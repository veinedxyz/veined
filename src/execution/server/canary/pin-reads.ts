// G14 Track A: live READ-ONLY verification of the canary pins on Base, through the existing reviewed Swap transport
// (src/swap/server/transport.ts: method allowlist eth_call / eth_getCode / eth_getStorageAt / eth_getBlockByNumber …,
// egress allowlist, provider quota — unchanged). Every value is read at ONE block (round-1 review F8). ONE operator is
// configured there for Base, so this yields one PinReads; the second, independent operator is protected item B4 —
// until then the review's PINS_AGREEMENT stays SINGLE (UNKNOWN).
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Hex,
} from "viem";
import { rpc } from "../../../swap/server/transport";
import { RPC_ORIGINS } from "../../../swap/server/config";
import { CANARY_PINS, pinValues, type PinReads } from "../../canary/pins";
import { normalizeOrigin } from "../../canary/chain-reads";

const ABI = parseAbi([
  "function facetAddress(bytes4) view returns (address)",
  "function SPOKEPOOL() view returns (address)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const isHex = (x: unknown): x is Hex =>
  typeof x === "string" && /^0x[0-9a-fA-F]*$/.test(x);

export async function readCanaryPins(
  selector: string,
  signal: AbortSignal,
): Promise<PinReads> {
  const p = CANARY_PINS;
  const sp = p.spokePools["8453"],
    u = p.usdc["8453"];
  const chain = await rpc("8453", "eth_chainId", [], signal).catch(() => null);
  const head = (await rpc(
    "8453",
    "eth_getBlockByNumber",
    ["latest", false],
    signal,
  ).catch(() => null)) as { number?: unknown; hash?: unknown } | null;
  const blockTag = head && isHex(head.number) ? head.number : null;
  const block =
    blockTag && isHex(head!.hash) && head!.hash.length === 66
      ? { number: BigInt(blockTag).toString(), hash: head!.hash.toLowerCase() }
      : null;
  const base = {
    origin: normalizeOrigin(RPC_ORIGINS["8453"]) ?? "",
    chainId: isHex(chain) ? BigInt(chain).toString() : null,
    block,
    selector: selector.toLowerCase(),
  };
  if (!blockTag || !block)
    return {
      ...base,
      diamondCodehash: null,
      facetForSelector: null,
      facetCodehash: null,
      facetSpokePool: null,
      feeCollectorCodehash: null,
      sourceSpokePool: {
        codehash: null,
        implementation: null,
        implementationCodehash: null,
      },
      sourceUsdc: {
        codehash: null,
        implementation: null,
        implementationCodehash: null,
        decimals: null,
        symbol: null,
      },
    };
  const code = async (address: string): Promise<string | null> => {
    const c = await rpc(
      "8453",
      "eth_getCode",
      [address, blockTag],
      signal,
    ).catch(() => null);
    return isHex(c) && c.length > 2 ? keccak256(c) : null;
  };
  const slot = async (address: string, s: string): Promise<string | null> => {
    const v = await rpc(
      "8453",
      "eth_getStorageAt",
      [address, s, blockTag],
      signal,
    ).catch(() => null);
    return isHex(v) && v.length === 66 ? `0x${v.slice(-40)}` : null;
  };
  const read = async <T>(
    to: string,
    fn: "facetAddress" | "SPOKEPOOL" | "decimals" | "symbol",
    args: readonly unknown[],
  ): Promise<T | null> => {
    try {
      const data = encodeFunctionData({
        abi: ABI,
        functionName: fn,
        args: args as never,
      });
      const out = await rpc(
        "8453",
        "eth_call",
        [{ to, data }, blockTag],
        signal,
      );
      if (!isHex(out) || out === "0x") return null;
      return decodeFunctionResult({
        abi: ABI,
        functionName: fn,
        data: out,
      }) as T;
    } catch {
      return null;
    }
  };
  const facet = await read<string>(p.diamond.address, "facetAddress", [
    selector,
  ]);
  const [
    diamondCodehash,
    facetCodehash,
    facetSpokePool,
    feeCollectorCodehash,
    spCode,
    spImpl,
    uCode,
    uImpl,
    decimals,
    symbol,
  ] = await Promise.all([
    code(p.diamond.address),
    facet ? code(facet) : Promise.resolve(null),
    facet ? read<string>(facet, "SPOKEPOOL", []) : Promise.resolve(null),
    code(p.feeCollector.address),
    code(sp.address),
    slot(sp.address, sp.implementation.slot),
    code(u.address),
    slot(u.address, u.implementation.slot),
    read<number>(u.address, "decimals", []),
    read<string>(u.address, "symbol", []),
  ]);
  const [spImplCode, uImplCode] = await Promise.all([
    spImpl ? code(spImpl) : null,
    uImpl ? code(uImpl) : null,
  ]);
  return {
    ...base,
    diamondCodehash,
    facetForSelector: facet,
    facetCodehash,
    facetSpokePool,
    feeCollectorCodehash,
    sourceSpokePool: {
      codehash: spCode,
      implementation: spImpl,
      implementationCodehash: spImplCode,
    },
    sourceUsdc: {
      codehash: uCode,
      implementation: uImpl,
      implementationCodehash: uImplCode,
      decimals: typeof decimals === "number" ? decimals : null,
      symbol: typeof symbol === "string" ? symbol : null,
    },
  };
}
let cache: { at: number; reads: PinReads } | null = null;
/** The pinned selector's reads, at most once per minute per process. */
export async function cachedCanaryPins(
  signal: AbortSignal,
  now = Date.now(),
): Promise<PinReads> {
  if (!cache || now - cache.at > 60_000 || now < cache.at) {
    const reads = await readCanaryPins(CANARY_PINS.selector, signal);
    // A read with any missing value is answered but not kept (round-2 review N7).
    const complete =
      Object.values(pinValues(reads)).every((v) => v !== null) &&
      reads.block !== null;
    if (!complete) return reads;
    cache = { at: now, reads };
  }
  return cache.reads;
}
