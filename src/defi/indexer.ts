import { decodeEventLog, toEventSelector, type Hex } from "viem";
import { z } from "zod";
import type { Sql } from "postgres";
import type { RpcPool } from "../data/rpc/pool";
import type { ProtocolDeployment } from "./model";
import { eventAbi } from "./abi";
import { exactAddress, pinChain } from "./reader";
const logSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  topics: z
    .array(z.string().regex(/^0x[0-9a-fA-F]{64}$/))
    .min(1)
    .max(4),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  blockNumber: z.string().regex(/^0x[0-9a-f]+$/),
  blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  logIndex: z.string().regex(/^0x[0-9a-f]+$/),
  removed: z.boolean().optional(),
});
const signature: Record<string, string> = {
  CreateMarket:
    "CreateMarket(bytes32,(address,address,address,address,uint256))",
  CreateMetaMorpho:
    "CreateMetaMorpho(address,address,address,uint256,address,string,string,bytes32)",
  PairCreated: "PairCreated(address,address,address,uint256)",
  Transfer: "Transfer(address,address,uint256)",
  Supply: "Supply(bytes32,address,address,uint256,uint256)",
  Borrow: "Borrow(bytes32,address,address,address,uint256,uint256)",
  SupplyCollateral: "SupplyCollateral(bytes32,address,address,uint256)",
};
export function indexEvents(d: ProtocolDeployment) {
  return d.adapter === "morpho-blue"
    ? ["CreateMarket", "Supply", "Borrow", "SupplyCollateral"]
    : d.adapter === "morpho-vault"
      ? ["CreateMetaMorpho"]
      : d.adapter === "uniswap-v2"
        ? ["PairCreated"]
        : d.adapter === "uniswap-v3"
          ? ["Transfer"]
          : [];
}
export function decodeIndexedLog(
  d: ProtocolDeployment,
  raw: unknown,
  from: bigint,
  to: bigint,
) {
  const l = logSchema.parse(raw),
    block = BigInt(l.blockNumber),
    target =
      d.adapter === "uniswap-v3"
        ? d.contracts.manager
        : (d.contracts.blue ?? d.contracts.factory);
  if (
    l.removed ||
    block < from ||
    block > to ||
    exactAddress(l.address) !== target
  )
    throw Error("NONCANONICAL_LOG");
  const e = decodeEventLog({
    abi: eventAbi,
    topics: l.topics as [Hex, ...Hex[]],
    data: l.data as Hex,
    strict: true,
  });
  if (!indexEvents(d).includes(e.eventName)) throw Error("EVENT_NOT_ALLOWED");
  return {
    log: l,
    block,
    event: e.eventName,
    args: e.args as unknown as Record<string, unknown>,
  };
}
export async function commitDefiWindow(
  sql: Sql,
  d: ProtocolDeployment,
  from: bigint,
  to: bigint,
  hash: string,
  raw: unknown[],
  historicalComplete = false,
) {
  const logs = raw.map((l) => decodeIndexedLog(d, l, from, to));
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"defi:" + d.id}))`;
    const [cp] =
      await tx`SELECT indexed_through FROM defi_event_checkpoints WHERE deployment_id=${d.id} FOR UPDATE`;
    if (cp && BigInt(String(cp.indexed_through)) + 1n !== from)
      throw Error("INDEX_WINDOW_GAP");
    for (const { log: l, block, event, args: a } of logs) {
      if (
        event === "CreateMarket" ||
        event === "CreateMetaMorpho" ||
        event === "PairCreated"
      ) {
        const contract =
            event === "CreateMarket"
              ? null
              : exactAddress(event === "PairCreated" ? a.pair : a.metaMorpho),
          key = event === "CreateMarket" ? String(a.id) : contract!,
          market = event === "CreateMarket" ? key : null;
        await tx`INSERT INTO defi_position_refs(deployment_id,position_key,contract,market_id,source_block,source_hash) VALUES(${d.id},${key},${contract},${market},${block.toString()},${l.blockHash}) ON CONFLICT(deployment_id,position_key) DO NOTHING`;
      } else if (event === "Transfer") {
        const token = String(a.tokenId),
          owner = exactAddress(a.to);
        await tx`INSERT INTO erc721_transfers VALUES(${d.id},${block.toString()},${l.blockHash},${l.transactionHash},${Number(BigInt(l.logIndex))},${exactAddress(l.address)},${token},${exactAddress(a.from)},${owner}) ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO wallet_nft_positions VALUES(${d.id},${exactAddress(l.address)},${token},${owner},${block.toString()}) ON CONFLICT(deployment_id,collection,token_id) DO UPDATE SET owner_address=excluded.owner_address,block_number=excluded.block_number`;
        await tx`INSERT INTO defi_position_nft_refs VALUES(${d.id},${token},${block.toString()}) ON CONFLICT(deployment_id,token_id) DO UPDATE SET source_block=excluded.source_block`;
      } else {
        await tx`INSERT INTO wallet_protocol_activity VALUES(${d.id},${exactAddress(a.onBehalf)},${String(a.id)},${block.toString()},${l.transactionHash},${Number(BigInt(l.logIndex))}) ON CONFLICT DO NOTHING`;
      }
    }
    await tx`INSERT INTO defi_event_windows VALUES(${d.id},${from.toString()},${to.toString()},${hash}) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO defi_event_checkpoints VALUES(${d.id},${from.toString()},${to.toString()},${hash},${historicalComplete},now()) ON CONFLICT(deployment_id) DO UPDATE SET indexed_through=excluded.indexed_through,block_hash=excluded.block_hash,updated_at=now()`;
  });
  return {
    logs: logs.length,
    from: from.toString(),
    through: to.toString(),
    hash,
  };
}
/** Reorg rollback drops discovery after the ancestor and reconstructs NFT ownership from retained transfers. */
export async function rollbackDefi(
  sql: Sql,
  d: string,
  ancestor: bigint,
  hash: string,
) {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"defi:" + d}))`;
    await tx`DELETE FROM defi_position_refs WHERE deployment_id=${d} AND source_block>${ancestor.toString()}`;
    await tx`DELETE FROM erc721_transfers WHERE deployment_id=${d} AND block_number>${ancestor.toString()}`;
    await tx`DELETE FROM wallet_protocol_activity WHERE deployment_id=${d} AND source_block>${ancestor.toString()}`;
    await tx`DELETE FROM defi_event_windows WHERE deployment_id=${d} AND to_block>${ancestor.toString()}`;
    await tx`DELETE FROM wallet_nft_positions WHERE deployment_id=${d}`;
    await tx`DELETE FROM defi_position_nft_refs WHERE deployment_id=${d}`;
    await tx`INSERT INTO wallet_nft_positions SELECT DISTINCT ON(collection,token_id) deployment_id,collection,token_id,to_address,block_number FROM erc721_transfers WHERE deployment_id=${d} ORDER BY collection,token_id,block_number DESC,log_index DESC`;
    await tx`INSERT INTO defi_position_nft_refs SELECT deployment_id,token_id,block_number FROM wallet_nft_positions WHERE deployment_id=${d}`;
    await tx`UPDATE defi_event_checkpoints SET indexed_through=${ancestor.toString()},block_hash=${hash},updated_at=now() WHERE deployment_id=${d}`;
  });
}
export async function indexDefiOnce(
  sql: Sql,
  pool: RpcPool,
  d: ProtocolDeployment,
  options: { fromBlock?: bigint; range?: number; signal?: AbortSignal } = {},
) {
  if (!indexEvents(d).length) throw Error("NO_INDEXED_EVENT_FAMILY");
  const signal = AbortSignal.any([
    AbortSignal.timeout(30000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const range = Math.min(Math.max(options.range ?? 2000, 1), 10000);
  if (!Number.isInteger(range)) throw Error("INVALID_INDEX_RANGE");
  const pin = await pinChain(
      pool,
      signal,
      (e) => e.supportsLogs && e.maxLogRange >= range,
    ),
    head = pin.number > 32n ? pin.number - 32n : 0n;
  const pinned = {
    signal,
    attempts: 1,
    filter: (e: import("../data/rpc/pool").ApprovedEndpoint) =>
      e.id === pin.endpointId,
  };
  const [cp] =
    await sql`SELECT * FROM defi_event_checkpoints WHERE deployment_id=${d.id}`;
  if (cp) {
    const old = await pool.call(
      {
        method: "eth_getBlockByNumber",
        params: ["0x" + BigInt(String(cp.indexed_through)).toString(16), false],
      },
      pinned,
    );
    if ((old.value as { hash?: string })?.hash !== cp.block_hash) {
      const windows =
        await sql`SELECT * FROM defi_event_windows WHERE deployment_id=${d.id} ORDER BY to_block DESC LIMIT 32`;
      let ancestor: null | { block: bigint; hash: string } = null;
      for (const w of windows) {
        const block = BigInt(String(w.to_block)),
          r = await pool.call(
            {
              method: "eth_getBlockByNumber",
              params: ["0x" + block.toString(16), false],
            },
            pinned,
          );
        if ((r.value as { hash?: string })?.hash === w.block_hash) {
          ancestor = { block, hash: String(w.block_hash) };
          break;
        }
      }
      if (!ancestor) throw Error("REORG_BEYOND_WINDOW_HISTORY");
      await rollbackDefi(sql, d.id, ancestor.block, ancestor.hash);
      return { state: "ROLLED_BACK", ancestor: ancestor.block.toString() };
    }
  }
  const from = cp
    ? BigInt(String(cp.indexed_through)) + 1n
    : (options.fromBlock ?? (d.startBlock ? BigInt(d.startBlock) : undefined));
  if (from === undefined) throw Error("EXPLICIT_START_BLOCK_REQUIRED");
  if (from > head)
    return {
      state: "CURRENT",
      through: cp ? String(cp.indexed_through) : null,
    };
  const to =
      from + BigInt(range) - 1n > head ? head : from + BigInt(range) - 1n,
    target =
      d.adapter === "uniswap-v3"
        ? d.contracts.manager
        : (d.contracts.blue ?? d.contracts.factory);
  const logs: unknown[] = [];
  const before = await pool.call(
    { method: "eth_getBlockByNumber", params: ["0x" + to.toString(16), false] },
    pinned,
  );
  const hash = (before.value as { hash: string }).hash;
  for (const name of indexEvents(d)) {
    const topic = toEventSelector(signature[name]);
    const r = await pool.call(
      {
        method: "eth_getLogs",
        params: [
          {
            address: target,
            topics: [topic],
            fromBlock: "0x" + from.toString(16),
            toBlock: "0x" + to.toString(16),
          },
        ],
      },
      {
        ...pinned,
        policy: {
          ecosystem: "EVM",
          maxLogRange: range,
          defiLog: { address: target, topic },
        },
        maxBytes: 2000000,
      },
    );
    if (!Array.isArray(r.value) || r.value.length > 20000)
      throw Error("LOG_RESPONSE_LIMIT");
    logs.push(...r.value);
    if (logs.length > 20000) throw Error("LOG_RESPONSE_LIMIT");
  }
  await verifyIndexedHashes(logs, async (block) => {
    const value = await pool.call(
      { method: "eth_getBlockByNumber", params: [block, false] },
      pinned,
    );
    return (value.value as { hash: string }).hash;
  });
  const after = await pool.call(
    { method: "eth_getBlockByNumber", params: ["0x" + to.toString(16), false] },
    pinned,
  );
  if ((after.value as { hash: string }).hash !== hash)
    throw Error("REORG_WINDOW_CHANGED");
  logs.sort((a, b) => {
    const x = logSchema.parse(a),
      y = logSchema.parse(b);
    return (
      Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) ||
      Number(BigInt(x.logIndex) - BigInt(y.logIndex))
    );
  });
  return {
    state: "INDEXED",
    ...(await commitDefiWindow(
      sql,
      d,
      from,
      to,
      hash,
      logs,
      !!d.startBlock && from === BigInt(d.startBlock),
    )),
  };
}
/** A range endpoint hash alone cannot establish that each returned event is canonical. */
export async function verifyIndexedHashes(
  raw: unknown[],
  blockHash: (block: string) => Promise<string>,
) {
  const expected = new Map<string, string>();
  for (const value of raw) {
    const log = logSchema.parse(value);
    if (
      log.removed ||
      (expected.has(log.blockNumber) &&
        expected.get(log.blockNumber) !== log.blockHash)
    )
      throw Error("NONCANONICAL_LOG");
    expected.set(log.blockNumber, log.blockHash);
  }
  for (const [block, hash] of expected)
    if ((await blockHash(block)) !== hash) throw Error("NONCANONICAL_LOG");
}
