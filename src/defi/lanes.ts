import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  toEventSelector,
  type Hex,
} from "viem";
import { z } from "zod";
import type { Sql } from "postgres";
import type { ProtocolDeployment } from "./model";
import { exactAddress } from "./reader";
// V1.14 resumable, reorg-safe registry backfill lanes (factory / market-creation events). A lane covers
// [startBlock, indexedThrough] without gaps; historicalComplete means it reached the finalized head from the official
// deployment block. Only registry identities are stored (no raw chain archive). Every window is hash-checked before
// and after the log read, every log's block hash must be canonical, and removed logs are rejected.
export interface LaneSpec {
  lane: string;
  contractKey: string;
  signature: string;
  decode: (log: RawLog) => { entryKey: string; detail: Record<string, string> };
}
export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}
const logSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  topics: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{64}$/))
    .min(1)
    .max(4),
  data: z
    .string()
    .regex(/^0x[0-9a-fA-F]*$/)
    .max(20000),
  blockNumber: z.string().regex(/^0x[0-9a-f]+$/),
  blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  logIndex: z.string().regex(/^0x[0-9a-f]+$/),
  removed: z.boolean().optional(),
});
const topicAddress = (t: string) => exactAddress("0x" + t.slice(26));
export const LANES: Partial<Record<ProtocolDeployment["adapter"], LaneSpec[]>> =
  {
    "morpho-blue": [
      {
        lane: "markets",
        contractKey: "blue",
        signature:
          "CreateMarket(bytes32,(address,address,address,address,uint256))",
        decode: (l) => {
          const id = l.topics[1]?.toLowerCase();
          const [p] = decodeAbiParameters(
            [
              {
                type: "tuple",
                components: [
                  { type: "address", name: "loanToken" },
                  { type: "address", name: "collateralToken" },
                  { type: "address", name: "oracle" },
                  { type: "address", name: "irm" },
                  { type: "uint256", name: "lltv" },
                ],
              },
            ],
            l.data as Hex,
          ) as unknown as [
            {
              loanToken: string;
              collateralToken: string;
              oracle: string;
              irm: string;
              lltv: bigint;
            },
          ];
          // The market id must be the hash of its parameters (MarketParamsLib.id).
          const computed = keccak256(
            encodeAbiParameters(
              [
                { type: "address" },
                { type: "address" },
                { type: "address" },
                { type: "address" },
                { type: "uint256" },
              ],
              [
                p.loanToken as Hex,
                p.collateralToken as Hex,
                p.oracle as Hex,
                p.irm as Hex,
                p.lltv,
              ],
            ),
          );
          if (!id || computed !== id) throw Error("MARKET_ID_MISMATCH");
          return {
            entryKey: id,
            detail: {
              loanToken: exactAddress(p.loanToken),
              collateralToken: exactAddress(p.collateralToken),
              oracle: exactAddress(p.oracle),
              irm: exactAddress(p.irm),
              lltv: p.lltv.toString(),
            },
          };
        },
      },
    ],
    "morpho-vault": [
      {
        lane: "vaults",
        contractKey: "factory",
        signature:
          "CreateMetaMorpho(address,address,address,uint256,address,string,string,bytes32)",
        decode: (l) => ({
          entryKey: topicAddress(l.topics[1] ?? ""),
          detail: {},
        }),
      },
    ],
  };
export interface LogSource {
  id: string;
  head(): Promise<bigint>;
  blockHash(block: bigint): Promise<string>;
  logs(
    address: string,
    topic: string,
    from: bigint,
    to: bigint,
  ): Promise<unknown[]>;
}
const ALLOWED_LOG_HOSTS =
  /^(gateway\.tenderly\.co|[a-z0-9-]+\.gateway\.tenderly\.co|ethereum-rpc\.publicnode\.com|rpc\.mevblocker\.io)$/;
/** Operator-configured HTTPS log source (backfill only). Exact host allowlist; read-only methods only. */
export function httpLogSource(
  url: string,
  fetcher: typeof fetch = fetch,
): LogSource {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    !ALLOWED_LOG_HOSTS.test(u.hostname)
  )
    throw Error("LOG_SOURCE_NOT_ALLOWED");
  let id = 1;
  const call = async (method: string, params: unknown[]) => {
    if (
      !["eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs"].includes(
        method,
      )
    )
      throw Error("METHOD_NOT_ALLOWED");
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetcher(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
          signal: AbortSignal.timeout(120000),
        });
        const text = await r.text();
        if (text.length > 64 * 1024 * 1024)
          throw Error("LOG_RESPONSE_TOO_LARGE");
        const j = JSON.parse(text) as {
          result?: unknown;
          error?: { message?: string };
        };
        if (j.error)
          throw Error(
            "RPC_ERROR:" + String(j.error.message ?? "").slice(0, 120),
          );
        return j.result;
      } catch (e) {
        if (
          attempt >= 5 ||
          !/rate limit|429|timeout|fetch failed|block not found|ECONNRESET/i.test(
            String((e as Error).message),
          )
        )
          throw e;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  };
  return {
    id: u.hostname,
    async head() {
      return BigInt(String(await call("eth_blockNumber", [])));
    },
    async blockHash(block) {
      const b = (await call("eth_getBlockByNumber", [
        "0x" + block.toString(16),
        false,
      ])) as { hash?: string } | null;
      if (!b?.hash || !/^0x[0-9a-f]{64}$/.test(b.hash))
        throw Error("BLOCK_NOT_AVAILABLE");
      return b.hash;
    },
    async logs(address, topic, from, to) {
      const r = await call("eth_getLogs", [
        {
          address,
          topics: [topic],
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
        },
      ]);
      if (!Array.isArray(r) || r.length > 20000)
        throw Error("LOG_RESPONSE_LIMIT");
      return r;
    },
  };
}
export function decodeLaneLog(
  d: ProtocolDeployment,
  spec: LaneSpec,
  raw: unknown,
  from: bigint,
  to: bigint,
) {
  const l = logSchema.parse(raw);
  const block = BigInt(l.blockNumber);
  if (l.removed || block < from || block > to) throw Error("NONCANONICAL_LOG");
  if (exactAddress(l.address) !== d.contracts[spec.contractKey])
    throw Error("LOG_ADDRESS_MISMATCH");
  if (l.topics[0].toLowerCase() !== toEventSelector(spec.signature))
    throw Error("EVENT_NOT_ALLOWED");
  return { log: l, block, ...spec.decode(l as RawLog) };
}
/** One bounded backfill step for a lane; returns its new checkpoint state. Call repeatedly until CURRENT. */
export async function indexLaneOnce(
  sql: Sql,
  source: LogSource,
  d: ProtocolDeployment,
  spec: LaneSpec,
  options: { range?: bigint; finality?: bigint; maxWindows?: number } = {},
) {
  if (!d.startBlock) throw Error("EXPLICIT_START_BLOCK_REQUIRED");
  const start = BigInt(d.startBlock);
  const finality = options.finality ?? 64n;
  let range = options.range ?? 500000n;
  const topic = toEventSelector(spec.signature);
  const target = d.contracts[spec.contractKey];
  const [cp] =
    await sql`SELECT * FROM defi_index_lanes WHERE deployment_id=${d.id} AND lane=${spec.lane}`;
  // Reorg check against the stored canonical checkpoint hash; roll back to the newest window that still matches.
  if (cp) {
    const through = BigInt(String(cp.indexed_through));
    if ((await source.blockHash(through)) !== cp.block_hash) {
      const windows =
        await sql`SELECT to_block,block_hash FROM defi_index_lane_windows WHERE deployment_id=${d.id} AND lane=${spec.lane} ORDER BY to_block DESC LIMIT 64`;
      let ancestor: { block: bigint; hash: string } | null = null;
      for (const w of windows) {
        const b = BigInt(String(w.to_block));
        if ((await source.blockHash(b)) === w.block_hash) {
          ancestor = { block: b, hash: String(w.block_hash) };
          break;
        }
      }
      if (!ancestor) throw Error("REORG_BEYOND_LANE_WINDOWS");
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${"lane:" + d.id + ":" + spec.lane}))`;
        await tx`DELETE FROM defi_registry_entries WHERE deployment_id=${d.id} AND lane=${spec.lane} AND source_block>${ancestor!.block.toString()}`;
        await tx`DELETE FROM defi_index_lane_windows WHERE deployment_id=${d.id} AND lane=${spec.lane} AND to_block>${ancestor!.block.toString()}`;
        await tx`UPDATE defi_index_lanes SET indexed_through=${ancestor!.block.toString()},block_hash=${ancestor!.hash},historical_complete=false,updated_at=now() WHERE deployment_id=${d.id} AND lane=${spec.lane}`;
      });
      return {
        state: "ROLLED_BACK" as const,
        ancestor: ancestor.block.toString(),
      };
    }
  }
  const head = (await source.head()) - finality;
  let from = cp ? BigInt(String(cp.indexed_through)) + 1n : start;
  let windows = 0,
    entries = 0;
  while (from <= head && windows < (options.maxWindows ?? 64)) {
    const to = from + range - 1n > head ? head : from + range - 1n;
    const before = await source.blockHash(to);
    let raw: unknown[];
    try {
      raw = await source.logs(target, topic, from, to);
    } catch (e) {
      // Provider range/result limits: halve the window (never skip it).
      if (
        range > 1000n &&
        /limit|range|too many|exceed/i.test(String((e as Error).message))
      ) {
        range /= 2n;
        continue;
      }
      throw e;
    }
    const decoded = raw.map((r) => decodeLaneLog(d, spec, r, from, to));
    // Canonical block hash per distinct log block, and the window end hash must not move during the read.
    const hashes = new Map<string, string>();
    for (const x of decoded) {
      const key = x.block.toString();
      if (!hashes.has(key)) hashes.set(key, await source.blockHash(x.block));
      if (hashes.get(key) !== x.log.blockHash) throw Error("NONCANONICAL_LOG");
    }
    if ((await source.blockHash(to)) !== before)
      throw Error("REORG_WINDOW_CHANGED");
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${"lane:" + d.id + ":" + spec.lane}))`;
      const [now] =
        await tx`SELECT indexed_through FROM defi_index_lanes WHERE deployment_id=${d.id} AND lane=${spec.lane} FOR UPDATE`;
      if (now && BigInt(String(now.indexed_through)) + 1n !== from)
        throw Error("LANE_WINDOW_GAP");
      if (!now && from !== start) throw Error("LANE_WINDOW_GAP");
      await tx`INSERT INTO defi_index_lanes(deployment_id,lane,start_block,indexed_from,indexed_through,block_hash,historical_complete) VALUES(${d.id},${spec.lane},${start.toString()},${start.toString()},${to.toString()},${before},${to >= head}) ON CONFLICT(deployment_id,lane) DO UPDATE SET indexed_through=excluded.indexed_through,block_hash=excluded.block_hash,historical_complete=excluded.historical_complete,updated_at=now()`;
      await tx`INSERT INTO defi_index_lane_windows VALUES(${d.id},${spec.lane},${from.toString()},${to.toString()},${before},${decoded.length}) ON CONFLICT DO NOTHING`;
      for (const x of decoded)
        await tx`INSERT INTO defi_registry_entries VALUES(${d.id},${spec.lane},${x.entryKey},${x.block.toString()},${x.log.blockHash},${x.log.transactionHash},${Number(BigInt(x.log.logIndex))},${tx.json(x.detail)}) ON CONFLICT DO NOTHING`;
    });
    windows++;
    entries += decoded.length;
    from = to + 1n;
  }
  const [after] =
    await sql`SELECT indexed_through,historical_complete FROM defi_index_lanes WHERE deployment_id=${d.id} AND lane=${spec.lane}`;
  return {
    state: from > head ? ("CURRENT" as const) : ("PARTIAL" as const),
    windows,
    entries,
    indexedThrough: after ? String(after.indexed_through) : null,
    historicalComplete: after?.historical_complete === true,
    head: head.toString(),
    source: source.id,
  };
}
