import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  keccak256,
  pad,
  toHex,
  type Hex,
} from "viem";
import {
  TRANSFER_TOPIC,
  multicall3Abi,
  walletTopic,
  SELECTORS,
} from "../../src/data/evm/erc20";
import {
  RpcError,
  type RpcEndpoint,
  type RpcTransport,
} from "../../src/data/rpc/transport";
import type { AdmissionResult } from "../../src/data/rpc/admission";
// Deterministic synthetic EVM chain for RPC fixture tests. SYNTHETIC_TEST_ONLY: never live evidence.
export interface FakeLog {
  token: string;
  from: string;
  to: string;
  value: bigint;
}
interface Block {
  number: bigint;
  hash: string;
  parentHash: string;
  logs: FakeLog[];
}
export interface Behavior {
  wrongChainId?: boolean;
  maxRange?: number;
  rateLimited?: boolean;
  timeout?: boolean;
  malformedLogs?: boolean;
  pruned?: boolean;
  noLogs?: boolean;
  behindBy?: number;
  lyingTags?: boolean;
  calls?: number;
}
const h = (salt: string, n: bigint) => keccak256(toHex(`${salt}:${n}`));
export class FakeChain {
  blocks: Block[] = [];
  native = new Map<string, bigint>();
  nonces = new Map<string, bigint>();
  balances = new Map<string, bigint>();
  metadata = new Map<
    string,
    { symbol: string; name: string; decimals: number }
  >();
  finalityDepth = 20n;
  constructor(
    readonly chainId: string,
    private salt = "a",
  ) {
    this.blocks.push({
      number: 0n,
      hash: h(salt, 0n),
      parentHash: "0x" + "0".repeat(64),
      logs: [],
    });
  }
  get head() {
    return this.blocks[this.blocks.length - 1].number;
  }
  mine(count: number, logs: (n: bigint) => FakeLog[] = () => []) {
    for (let i = 0; i < count; i++) {
      const prev = this.blocks[this.blocks.length - 1];
      const number = prev.number + 1n;
      this.blocks.push({
        number,
        hash: h(this.salt, number),
        parentHash: prev.hash,
        logs: logs(number),
      });
    }
  }
  // Replaces every block >= from with a new fork (different hashes and logs).
  reorg(from: bigint, salt: string, logs: (n: bigint) => FakeLog[] = () => []) {
    const keep = this.blocks.filter((b) => b.number < from);
    const count = this.blocks.length - keep.length;
    this.blocks = keep;
    const old = this.salt;
    this.salt = salt;
    this.mine(count, logs);
    this.salt = old;
  }
  block(tag: string, behind = 0n, lyingTags = false) {
    const head = this.head - behind;
    const n =
      tag === "latest"
        ? head
        : tag === "finalized" || tag === "safe"
          ? lyingTags
            ? head
            : head - this.finalityDepth
          : BigInt(tag);
    if (n < 0n || n > head) return null;
    return this.blocks[Number(n)];
  }
  rawLogs(from: bigint, to: bigint, malformed = false) {
    const out: unknown[] = [];
    for (let n = from; n <= to && n <= this.head; n++) {
      const b = this.blocks[Number(n)];
      b.logs.forEach((l, i) =>
        out.push({
          address: l.token,
          topics: [TRANSFER_TOPIC, walletTopic(l.from), walletTopic(l.to)],
          data: malformed ? "0xzz" : pad(toHex(l.value)),
          blockNumber: toHex(b.number),
          blockHash: b.hash,
          transactionHash: keccak256(toHex(`${b.hash}:tx:${i}`)),
          logIndex: toHex(i),
          removed: false,
        }),
      );
    }
    return out;
  }
  private view(selector: string, data: string, target?: string): Hex {
    if (selector === SELECTORS.balanceOf) {
      const wallet = `0x${data.slice(34, 74)}`.toLowerCase();
      return pad(toHex(this.balances.get(`${target}|${wallet}`) ?? 0n));
    }
    const meta = this.metadata.get(target ?? "");
    if (!meta) throw Error("NO_CONTRACT");
    if (selector === SELECTORS.decimals)
      return pad(toHex(BigInt(meta.decimals)));
    if (selector === SELECTORS.symbol)
      return encodeAbiParameters([{ type: "string" }], [meta.symbol]);
    if (selector === SELECTORS.name)
      return encodeAbiParameters([{ type: "string" }], [meta.name]);
    throw Error("UNSUPPORTED_VIEW");
  }
  handle(method: string, params: unknown[], b: Behavior): unknown {
    const behind = BigInt(b.behindBy ?? 0);
    switch (method) {
      case "eth_chainId":
        return toHex(
          b.wrongChainId ? BigInt(this.chainId) + 1n : BigInt(this.chainId),
        );
      case "eth_blockNumber":
        return toHex(this.head - behind);
      case "eth_getBlockByNumber": {
        const blk = this.block(String(params[0]), behind, b.lyingTags);
        return blk
          ? {
              number: toHex(blk.number),
              hash: blk.hash,
              parentHash: blk.parentHash,
              timestamp: "0x1",
            }
          : null;
      }
      case "eth_getBalance": {
        if (b.pruned && params[1] === "0x1")
          throw { code: -32000, message: "missing trie node" };
        return toHex(this.native.get(String(params[0]).toLowerCase()) ?? 0n);
      }
      case "eth_getTransactionCount":
        return toHex(this.nonces.get(String(params[0]).toLowerCase()) ?? 0n);
      case "eth_getCode":
        return this.metadata.has(String(params[0]).toLowerCase())
          ? "0x6001"
          : "0x";
      case "eth_getLogs": {
        if (b.noLogs) throw { code: -32601, message: "method not available" };
        const f = params[0] as { fromBlock: string; toBlock: string };
        const from = BigInt(f.fromBlock),
          to = BigInt(f.toBlock);
        if (b.maxRange !== undefined && to - from + 1n > BigInt(b.maxRange))
          throw {
            code: -32005,
            message:
              "query returned more than 10000 results; block range too large",
          };
        return this.rawLogs(
          from,
          to > this.head - behind ? this.head - behind : to,
          b.malformedLogs,
        );
      }
      case "eth_call": {
        const call = params[0] as { to: string; data: Hex };
        const to = call.to.toLowerCase();
        if (call.data.startsWith(SELECTORS.aggregate3)) {
          const decoded = decodeFunctionData({
            abi: multicall3Abi,
            data: call.data,
          });
          const results = (
            decoded.args[0] as readonly { target: string; callData: Hex }[]
          ).map((c) => {
            try {
              return {
                success: true,
                returnData: this.view(
                  c.callData.slice(0, 10),
                  c.callData,
                  c.target.toLowerCase(),
                ),
              };
            } catch {
              return { success: false, returnData: "0x" as Hex };
            }
          });
          return encodeFunctionResult({
            abi: multicall3Abi,
            functionName: "aggregate3",
            result: results,
          });
        }
        return this.view(call.data.slice(0, 10), call.data, to);
      }
      default:
        throw { code: -32601, message: "method not found" };
    }
  }
}
// One transport for many synthetic endpoints: URL host selects the chain and behavior.
export function fakeNetwork() {
  const chains = new Map<string, FakeChain>();
  const behaviors = new Map<string, Behavior>();
  const transport: RpcTransport = async (
    endpoint: RpcEndpoint,
    body: unknown,
    options,
  ) => {
    const b = behaviors.get(endpoint.url) ?? {};
    b.calls = (b.calls ?? 0) + 1;
    behaviors.set(endpoint.url, b);
    if (options.signal?.aborted) throw new RpcError("TIMEOUT");
    if (b.rateLimited) throw new RpcError("RATE_LIMITED", "429");
    if (b.timeout)
      return new Promise((_, reject) => {
        const t = setTimeout(
          () => reject(new RpcError("TIMEOUT")),
          options.timeoutMs ?? 1000,
        );
        options.signal?.addEventListener(
          "abort",
          () => (clearTimeout(t), reject(new RpcError("TIMEOUT"))),
        );
      });
    const chain = chains.get(endpoint.chainId);
    if (!chain) throw new RpcError("HTTP_ERROR", "NO_CHAIN");
    const one = (req: { id: number; method: string; params: unknown[] }) => {
      try {
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: chain.handle(req.method, req.params, b),
        };
      } catch (error) {
        return { jsonrpc: "2.0", id: req.id, error };
      }
    };
    return Array.isArray(body)
      ? body.map(one)
      : one(body as { id: number; method: string; params: unknown[] });
  };
  return { chains, behaviors, transport };
}
export function approved(
  chainId: string,
  host: string,
  extra: Partial<AdmissionResult> = {},
): AdmissionResult {
  return {
    chainId,
    url: `https://${host}`,
    host,
    provenance: "curated",
    status: "APPROVED",
    reason: null,
    latencyMs: 10,
    latestBlock: "0",
    supportsLogs: true,
    maxLogRange: 1000,
    supportsBatch: true,
    supportsFinalized: true,
    supportsSafe: true,
    archive: false,
    logsPerBlock: 1,
    checkedAt: Date.now(),
    ...extra,
  };
}
