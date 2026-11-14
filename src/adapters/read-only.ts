import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  toEventSelector,
} from "viem";
import { z } from "zod";
import {
  BridgeError,
  CROSS,
  NATIVE,
  sameAddress,
  addressSchema,
  hashSchema,
  type Health,
} from "../core/model";
import { READ_ONLY_DEPLOYMENT } from "./deployment";
import { nativeReadAbi } from "./native-abi";
import { bridgeAbi } from "./onebridge";
const implementationSlot =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const pinnedContracts = new Set(
  Object.entries(READ_ONLY_DEPLOYMENT)
    .filter(([key]) => !key.endsWith("Hash"))
    .map(([, value]) => value.toLowerCase()),
);
const blockTag = (value: unknown) =>
  ["latest", "finalized", "safe"].includes(String(value)) ||
  /^0x[0-9a-f]{1,16}$/i.test(String(value));
// ONE endpoint: observed official chain-info API; BSC: official BNB Chain RPC docs.
export const ENDPOINTS = {
  one: "https://mainnet.crosstoken.io:22001",
  bsc: "https://bsc-dataseed.bnbchain.org",
} as const;
export function publicIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  return (
    isIP(ip) === 6 && /^2[0-9a-f]{3}:/i.test(ip) && !/^2001:(db8|0):/i.test(ip)
  );
}
export async function boundedRequest(
  url: string,
  body?: unknown,
): Promise<unknown> {
  const parsed = new URL(url);
  const allowed = new Set([
    ...Object.values(ENDPOINTS),
    "https://bridge-api.crosstoken.io/bridge/pairs",
    "https://bridge-api.crosstoken.io/bridge/history",
    "https://wallet-server.crosstoken.io/api/v1/public/chain/info",
  ]);
  if (
    !allowed.has(url as typeof ENDPOINTS.one) ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    isIP(parsed.hostname)
  )
    throw new BridgeError("HOST_NOT_ALLOWED");
  if (url.endsWith("/bridge/history"))
    z.object({
      owner: addressSchema,
      page: z.number().int().min(1).max(3),
      size: z.literal(20),
      sort: z.literal("desc"),
    })
      .strict()
      .parse(body);
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const resolved = await Promise.race([
    lookup(parsed.hostname, { all: true }),
    new Promise<never>((_, reject) => {
      dnsTimer = setTimeout(
        () => reject(new BridgeError("UPSTREAM_TIMEOUT")),
        8000,
      );
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (!resolved.length || resolved.some((a) => !publicIp(a.address)))
    throw new BridgeError("UNSAFE_DNS");
  const pinned = resolved[0];
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      parsed,
      {
        method: payload ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
        lookup: (_host, opts, cb) => {
          if (typeof opts === "object" && "all" in opts && opts.all)
            (
              cb as unknown as (
                error: Error | null,
                addresses: { address: string; family: number }[],
              ) => void
            )(null, [pinned]);
          else cb(null, pinned.address, pinned.family);
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new BridgeError(
              res.statusCode === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
            ),
          );
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1048576) {
            req.destroy(new BridgeError("RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new BridgeError("INVALID_RESPONSE"));
          }
        });
        res.on("error", () => reject(new BridgeError("UPSTREAM_UNAVAILABLE")));
      },
    );
    const timer = setTimeout(
      () => req.destroy(new BridgeError("UPSTREAM_TIMEOUT")),
      8000,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", (e) =>
      reject(
        e instanceof BridgeError ? e : new BridgeError("UPSTREAM_UNAVAILABLE"),
      ),
    );
    if (payload) req.write(payload);
    req.end();
  });
}
const hex = z.string().regex(/^0x[0-9a-f]*$/i);
export function validateRpc(method: string, params: unknown[]) {
  const zero = ["eth_chainId", "eth_blockNumber", "eth_gasPrice"];
  if (zero.includes(method) && params.length === 0) return;
  if (
    ["eth_getCode", "eth_getBalance"].includes(method) &&
    params.length === 2 &&
    addressSchema.safeParse(params[0]).success &&
    blockTag(params[1])
  )
    return;
  if (
    ["eth_getTransactionReceipt", "eth_getTransactionByHash"].includes(
      method,
    ) &&
    params.length === 1 &&
    hashSchema.safeParse(params[0]).success
  )
    return;
  if (
    method === "eth_getBlockByNumber" &&
    params.length === 2 &&
    blockTag(params[0]) &&
    params[1] === false
  )
    return;
  if (
    method === "eth_getStorageAt" &&
    params.length === 3 &&
    [READ_ONLY_DEPLOYMENT.source, READ_ONLY_DEPLOYMENT.destination].includes(
      String(params[0]).toLowerCase() as typeof READ_ONLY_DEPLOYMENT.source,
    ) &&
    params[1] === implementationSlot &&
    blockTag(params[2])
  )
    return;
  if (method === "eth_getLogs" && params.length === 1) {
    const log = z
      .object({
        address: addressSchema,
        fromBlock: z.string().regex(/^0x[0-9a-f]{1,16}$/i),
        toBlock: z.string().regex(/^0x[0-9a-f]{1,16}$/i),
        topics: z.array(hashSchema.nullable()).min(1).max(4),
      })
      .strict()
      .safeParse(params[0]);
    if (
      log.success &&
      [READ_ONLY_DEPLOYMENT.source, READ_ONLY_DEPLOYMENT.destination].some(
        (a) => sameAddress(a, log.data.address),
      ) &&
      nativeReadAbi.some(
        (item) =>
          item.type === "event" && toEventSelector(item) === log.data.topics[0],
      ) &&
      BigInt(log.data.toBlock) >= BigInt(log.data.fromBlock) &&
      BigInt(log.data.toBlock) - BigInt(log.data.fromBlock) < 1000n
    )
      return;
  }
  if (
    (method === "eth_estimateGas" || method === "eth_call") &&
    (params.length === 1 || (params.length === 2 && blockTag(params[1])))
  ) {
    const simulation = z
      .object({
        from: addressSchema,
        to: addressSchema,
        data: z.string().regex(/^0x[0-9a-f]{8,520}$/i),
        value: z.string().regex(/^0x[0-9a-f]+$/i),
      })
      .strict()
      .safeParse(params[0]);
    if (
      simulation.success &&
      sameAddress(simulation.data.to, READ_ONLY_DEPLOYMENT.source)
    ) {
      try {
        const { args, functionName } = decodeFunctionData({
          abi: bridgeAbi,
          data: simulation.data.data as `0x${string}`,
        });
        if (
          functionName === "bridgeToken" &&
          args[0] === 56n &&
          sameAddress(args[1], NATIVE) &&
          sameAddress(args[2], simulation.data.from) &&
          args[3] > 0n &&
          args[6] === "0x" &&
          BigInt(simulation.data.value) === args[3] + args[4] + args[5]
        )
          return;
      } catch {
        /* Only this typed native simulation is accepted. */
      }
    }
  }
  if (method === "eth_call" && params.length === 2 && blockTag(params[1])) {
    const call = z
      .object({
        to: z.literal(CROSS),
        data: z.enum(["0x06fdde03", "0x95d89b41", "0x313ce567"]),
      })
      .strict();
    if (call.safeParse(params[0]).success) return;
    const view = z
      .object({
        to: addressSchema,
        data: z.string().regex(/^0x[0-9a-f]{8,392}$/i),
      })
      .strict()
      .safeParse(params[0]);
    if (
      view.success &&
      (pinnedContracts.has(view.data.to.toLowerCase()) ||
        view.data.to.toLowerCase() === CROSS.toLowerCase())
    ) {
      try {
        if (view.data.to.toLowerCase() === CROSS.toLowerCase()) {
          const decoded = decodeFunctionData({
            abi: erc20Abi,
            data: view.data.data as `0x${string}`,
          });
          if (
            decoded.functionName === "balanceOf" &&
            decoded.args[0].toLowerCase() === READ_ONLY_DEPLOYMENT.destination
          )
            return;
        } else {
          const decoded = decodeFunctionData({
            abi: nativeReadAbi,
            data: view.data.data as `0x${string}`,
          });
          if (
            decoded.args?.length &&
            (!([56n, 612055n] as readonly unknown[]).includes(
              decoded.args[0],
            ) ||
              (decoded.args.length > 1 &&
                ![
                  CROSS.toLowerCase(),
                  "0x0000000000000000000000000000000000000001",
                ].includes(String(decoded.args[1]).toLowerCase())))
          )
            throw new BridgeError("RPC_NOT_ALLOWED");
          return;
        }
      } catch {
        /* Reject undecodable or write selectors. */
      }
    }
  }
  throw new BridgeError("RPC_NOT_ALLOWED");
}
export async function rpc(
  chain: "one" | "bsc",
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  validateRpc(method, params);
  const result = z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.literal(1),
      result: z.unknown().optional(),
      error: z.unknown().optional(),
    })
    .parse(
      await boundedRequest(ENDPOINTS[chain], {
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    );
  if (result.error) {
    const error = new BridgeError("RPC_ERROR");
    error.cause = result.error; // Internal diagnostics only; the API returns the code.
    throw error;
  }
  if (result.result === undefined) throw new BridgeError("INVALID_RESPONSE");
  return result.result;
}
export async function chainSnapshot(chain: "one" | "bsc", expected: number) {
  const id = hex.parse(await rpc(chain, "eth_chainId"));
  if (BigInt(id) !== BigInt(expected)) throw new BridgeError("CHAIN_MISMATCH");
  const block = z
    .object({ number: hex, timestamp: hex, hash: hashSchema })
    .parse(await rpc(chain, "eth_getBlockByNumber", ["latest", false]));
  if (Date.now() / 1000 - Number(BigInt(block.timestamp)) > 180)
    throw new BridgeError("STALE_CHAIN");
  return {
    chainId: expected,
    block: BigInt(block.number).toString(),
    timestamp: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
  };
}
export async function tokenSnapshot() {
  if (BigInt(hex.parse(await rpc("bsc", "eth_chainId"))) !== 56n)
    throw new BridgeError("CHAIN_MISMATCH");
  const code = hex.parse(await rpc("bsc", "eth_getCode", [CROSS, "latest"]));
  if (code === "0x") throw new BridgeError("TOKEN_NO_CODE");
  const values = await Promise.all(
    ["name", "symbol", "decimals"].map(async (name) => {
      const functionName = name as "name" | "symbol" | "decimals";
      const data = encodeFunctionData({ abi: erc20Abi, functionName });
      return decodeFunctionResult({
        abi: erc20Abi,
        functionName,
        data: hex.parse(
          await rpc("bsc", "eth_call", [{ to: CROSS, data }, "latest"]),
        ) as `0x${string}`,
      });
    }),
  );
  const [name, symbol, decimals] = values;
  if (name !== "Cross" || symbol !== "CROSS" || decimals !== 18)
    throw new BridgeError("TOKEN_METADATA_MISMATCH");
  return {
    name: String(name),
    symbol: String(symbol),
    decimals: Number(decimals),
    code: true,
  };
}
let cached: Health | undefined;
let active: Promise<Health> | undefined;
export async function liveHealth(): Promise<Health> {
  if (cached && Date.now() - cached.observedAt < 30000) return cached;
  if (active) return active;
  active = (async () => {
    const h: Health = {
      mode: "mainnet-readonly",
      observedAt: Date.now(),
      status: "blocked",
      reasons: [
        "DEPLOYMENT_UNVERIFIED",
        "RESERVE_UNKNOWN",
        "FINALITY_POLICY_UNKNOWN",
        "MAINNET_WRITE_DISABLED",
      ],
    };
    const results = await Promise.allSettled([
      chainSnapshot("one", 612055),
      chainSnapshot("bsc", 56),
      tokenSnapshot(),
    ]);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected")
        h.reasons.push(
          r.reason instanceof BridgeError
            ? r.reason.code
            : "UPSTREAM_UNAVAILABLE",
        );
      else if (i === 0) h.source = r.value as Health["source"];
      else if (i === 1) h.destination = r.value as Health["destination"];
      else h.token = r.value as Health["token"];
    }
    cached = h;
    return h;
  })();
  try {
    return await active;
  } finally {
    active = undefined;
  }
}
export async function balances(account: string) {
  addressSchema.parse(account);
  await Promise.all([chainSnapshot("one", 612055), chainSnapshot("bsc", 56)]);
  const [balance, bnb, sourceCode, destinationCode] = await Promise.all([
    rpc("one", "eth_getBalance", [account, "latest"]),
    rpc("bsc", "eth_getBalance", [account, "latest"]),
    rpc("one", "eth_getCode", [account, "latest"]),
    rpc("bsc", "eth_getCode", [account, "latest"]),
  ]);
  return {
    balance: BigInt(hex.parse(balance)).toString(),
    bnb: BigInt(hex.parse(bnb)).toString(),
    sourceCode: hex.parse(sourceCode),
    destinationCode: hex.parse(destinationCode),
  };
}
