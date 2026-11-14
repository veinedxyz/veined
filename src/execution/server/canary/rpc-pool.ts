// G14 protected proposal B4 + G14 closure (B4 / K4) — READ-ONLY reads of the canary from the TWO configured operators
// of one chain, at ONE common block. Server only.
// Every request here leaves through the protected Swap transport's canary capability (src/swap/server/transport.ts
// canaryRead): the same reviewed boundary as before (egress allowlist, redirect "error", no-store, 1 MB cap, no raw
// upstream error), now with ONE method policy that lives in the transport — POOL_READ_METHODS below IS the
// transport's list (the same object), so the two cannot drift apart — and a narrow parameter check per method
// (pinned contracts, explicit blocks, bounded logs, the approved account only, a simulation without state override).
// There is no other fetch in this file and no way for a caller to pass a URL, a method, an ABI or a contract.
// What the closure adds to the reads: the owner's NATIVE balance, the fee values (base fee of the common block, the
// two operators' priority fee suggestions), the OP-stack L1 data fee of the exact transactions, the simulation, and —
// for the tracker — receipts, transactions, the account nonce and bounded event logs. Every one of them is read from
// BOTH operators and counts only when both returned the same thing for the same block; a source that fails is `null`
// and the result is then SINGLE / UNKNOWN. No retry, no fallback to one operator.
// Each chain reconciles in its own pair; a Base block is never compared with an Arbitrum block.
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  serializeTransaction,
  type Hex,
} from "viem";
import {
  CANARY_READ_LIMITS,
  CANARY_READ_METHODS,
  canaryRead,
  canaryReadProblem,
} from "../../../swap/server/transport";
import { CANARY_RPC_POOL } from "../../../swap/server/config";
import { exactApproveCalldata } from "../../../security/canary-approval";
import {
  CANARY_PINS,
  type DestinationPinReads,
  type PinReads,
} from "../../canary/pins";
import { normalizeOrigin, type SourceRead } from "../../canary/chain-reads";
import type { ChainLog } from "../../canary/settlement";
import type { SimulationRequest } from "../../canary/simulation";

export type PoolChain = keyof typeof CANARY_RPC_POOL;
/**
 * The transport's own canary method list (the same frozen array, not a copy): nothing that writes, signs or traces.
 * A method that is not in the transport's policy cannot be in the pool's, and the other way round.
 */
export const POOL_READ_METHODS: readonly string[] = CANARY_READ_METHODS;
/** One request never waits longer than this; the caller's signal ends it earlier. */
export const POOL_READ_TIMEOUT_MS = CANARY_READ_LIMITS.timeoutMs;
export class PoolReadError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "PoolReadError";
  }
}
const isHex = (x: unknown): x is Hex =>
  typeof x === "string" && /^0x[0-9a-fA-F]*$/.test(x);

/** One read-only JSON-RPC call to operator `index` of `chain`. Refuses anything else before any network use. */
export async function poolRpc(
  chain: PoolChain,
  index: 0 | 1,
  method: string,
  params: unknown[],
  signal: AbortSignal,
): Promise<unknown> {
  // The transport's policy decides (method, chain, operator, every parameter) before anything is sent.
  const problem = canaryReadProblem(chain, index, method, params);
  if (problem)
    throw new PoolReadError(
      problem === "CANARY_METHOD_REFUSED"
        ? "METHOD_REFUSED"
        : problem === "CANARY_CHAIN_REFUSED" ||
            problem === "CANARY_SOURCE_REFUSED"
          ? "SOURCE_REFUSED"
          : problem,
    );
  try {
    return await canaryRead(chain, index, method, params, signal);
  } catch {
    throw new PoolReadError("INVALID_RESPONSE");
  }
}

export interface PoolBlock {
  tag: Hex;
  number: string;
  hash: string;
  timestamp: number;
  /** The block's own EIP-1559 base fee (wei, decimal), when the header carries one. */
  baseFeePerGas: string | null;
}
type Header = {
  number?: unknown;
  hash?: unknown;
  timestamp?: unknown;
  baseFeePerGas?: unknown;
} | null;
const quantity = (x: unknown): string | null =>
  typeof x === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(x)
    ? BigInt(x).toString()
    : null;
const header = (h: Header): PoolBlock | null =>
  h &&
  isHex(h.number) &&
  isHex(h.hash) &&
  h.hash.length === 66 &&
  isHex(h.timestamp)
    ? {
        // Canonical lower-case quantity: the transport accepts only that form as a block parameter.
        tag: `0x${BigInt(h.number).toString(16)}`,
        number: BigInt(h.number).toString(),
        hash: h.hash.toLowerCase(),
        timestamp: Number(BigInt(h.timestamp)),
        baseFeePerGas: quantity(h.baseFeePerGas),
      }
    : null;
/**
 * The block both operators are asked about: the LOWER of their two heads, re-read by number from each (so each
 * operator states its own hash and time for it). A source that cannot serve it is null.
 */
export async function commonBlock(
  chain: PoolChain,
  signal: AbortSignal,
): Promise<[PoolBlock | null, PoolBlock | null]> {
  const heads = await Promise.all(
    ([0, 1] as const).map((i) =>
      poolRpc(chain, i, "eth_getBlockByNumber", ["latest", false], signal)
        .then((h) => header(h as Header))
        .catch(() => null),
    ),
  );
  if (!heads[0] || !heads[1]) return [null, null];
  const n =
    BigInt(heads[0].number) < BigInt(heads[1].number)
      ? heads[0].tag
      : heads[1].tag;
  const at = await Promise.all(
    ([0, 1] as const).map((i) =>
      poolRpc(chain, i, "eth_getBlockByNumber", [n, false], signal)
        .then((h) => header(h as Header))
        .catch(() => null),
    ),
  );
  return [at[0], at[1]];
}

const ABI = parseAbi([
  "function facetAddress(bytes4) view returns (address)",
  "function SPOKEPOOL() view returns (address)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
type Fn =
  | "facetAddress"
  | "SPOKEPOOL"
  | "decimals"
  | "symbol"
  | "balanceOf"
  | "allowance";
/** The reads of ONE operator at ONE block; every failure is null (never thrown, never retried elsewhere). */
function reader(chain: PoolChain, index: 0 | 1, tag: Hex, signal: AbortSignal) {
  const code = async (address: string): Promise<string | null> => {
    const c = await poolRpc(
      chain,
      index,
      "eth_getCode",
      [address, tag],
      signal,
    ).catch(() => null);
    return isHex(c) && c.length > 2 ? keccak256(c) : null;
  };
  const slot = async (address: string, s: string): Promise<string | null> => {
    const v = await poolRpc(
      chain,
      index,
      "eth_getStorageAt",
      [address, s, tag],
      signal,
    ).catch(() => null);
    return isHex(v) && v.length === 66 ? `0x${v.slice(-40)}` : null;
  };
  const call = async <T>(
    to: string,
    fn: Fn,
    args: readonly unknown[],
  ): Promise<T | null> => {
    try {
      const data = encodeFunctionData({
        abi: ABI,
        functionName: fn,
        args: args as never,
      });
      const out = await poolRpc(
        chain,
        index,
        "eth_call",
        [{ to, data }, tag],
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
  const chainId = async (): Promise<string | null> => {
    const c = await poolRpc(chain, index, "eth_chainId", [], signal).catch(
      () => null,
    );
    return isHex(c) && c.length > 2 ? BigInt(c).toString() : null;
  };
  return { code, slot, call, chainId };
}
const originOf = (chain: PoolChain, index: 0 | 1) =>
  normalizeOrigin(CANARY_RPC_POOL[chain][index].url) ?? "";
/** The value of a read the transport would refuse (a contract outside the pin set): never equal to any pin. */
export const UNPINNED = "unpinned:not-read";
const pinned = (chain: PoolChain, address: string) =>
  canaryReadProblem(chain, 0, "eth_getCode", [address, "0x1"]) === null;

/** Source-side pin reads (Base) from both operators at the common block: [operator 0, operator 1]. */
export async function readSourcePinsPair(
  selector: string,
  signal: AbortSignal,
): Promise<[PinReads | null, PinReads | null]> {
  return pinsAt(selector, signal, await commonBlock("8453", signal));
}
/** Module-private: the block pair can only come from commonBlock() inside this module (review 2 G7). */
async function pinsAt(
  selector: string,
  signal: AbortSignal,
  blocks: [PoolBlock | null, PoolBlock | null],
): Promise<[PinReads | null, PinReads | null]> {
  const chain: PoolChain = "8453";
  const p = CANARY_PINS;
  const sp = p.spokePools["8453"],
    u = p.usdc["8453"];
  const one = async (index: 0 | 1): Promise<PinReads | null> => {
    const b = blocks[index];
    if (!b) return null;
    const r = reader(chain, index, b.tag, signal);
    const facet = await r.call<string>(p.diamond.address, "facetAddress", [
      selector,
    ]);
    const [
      chainId,
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
      r.chainId(),
      r.code(p.diamond.address),
      // Only pinned contracts are ever read (transport policy). A facet the chain names that is NOT the pinned one is
      // not read: its values are the UNPINNED marker, so the pin check reports FACET_REROUTED / FACET_CODE_CHANGED
      // and two operators that name different facets DISAGREE (as before) instead of reading an arbitrary contract.
      facet && pinned(chain, facet)
        ? r.code(facet)
        : Promise.resolve(facet ? UNPINNED : null),
      facet && pinned(chain, facet)
        ? r.call<string>(facet, "SPOKEPOOL", [])
        : Promise.resolve(facet ? UNPINNED : null),
      r.code(p.feeCollector.address),
      r.code(sp.address),
      r.slot(sp.address, sp.implementation.slot),
      r.code(u.address),
      r.slot(u.address, u.implementation.slot),
      r.call<number>(u.address, "decimals", []),
      r.call<string>(u.address, "symbol", []),
    ]);
    const [spImplCode, uImplCode] = await Promise.all([
      spImpl ? (pinned(chain, spImpl) ? r.code(spImpl) : UNPINNED) : null,
      uImpl ? (pinned(chain, uImpl) ? r.code(uImpl) : UNPINNED) : null,
    ]);
    return {
      origin: originOf(chain, index),
      chainId,
      block: { number: b.number, hash: b.hash },
      selector: selector.toLowerCase(),
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
  };
  return Promise.all([one(0), one(1)]);
}

/**
 * The owner's USDC balance on `chain`, the NATIVE balance (eth_getBalance) — and, on Base, the allowance to the
 * pinned Diamond — from both operators at the common block. The transport serves the native balance only for the
 * account of the protected owner record: for any other account (and always with the disarmed record) `native` is
 * null, and the engine's balance agreement stays UNKNOWN.
 */
export async function readOwnerBalancesPair(
  chain: PoolChain,
  owner: string,
  signal: AbortSignal,
): Promise<[SourceRead | null, SourceRead | null]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner))
    throw new PoolReadError("OWNER_INVALID");
  return balancesAt(chain, owner, signal, await commonBlock(chain, signal));
}
async function balancesAt(
  chain: PoolChain,
  owner: string,
  signal: AbortSignal,
  blocks: [PoolBlock | null, PoolBlock | null],
): Promise<[SourceRead | null, SourceRead | null]> {
  const token = CANARY_PINS.usdc[chain].address;
  const one = async (index: 0 | 1): Promise<SourceRead | null> => {
    const b = blocks[index];
    if (!b) return null;
    const r = reader(chain, index, b.tag, signal);
    const [chainId, usdc, native, allowance] = await Promise.all([
      r.chainId(),
      r.call<bigint>(token, "balanceOf", [owner]),
      poolRpc(chain, index, "eth_getBalance", [owner, b.tag], signal)
        .then(quantity)
        .catch(() => null),
      chain === "8453"
        ? r.call<bigint>(token, "allowance", [
            owner,
            CANARY_PINS.diamond.address,
          ])
        : Promise.resolve(null),
    ]);
    return {
      origin: originOf(chain, index),
      chainId,
      block: { number: b.number, hash: b.hash, timestamp: b.timestamp },
      values: {
        usdc: typeof usdc === "bigint" ? usdc.toString() : null,
        native,
        ...(chain === "8453"
          ? {
              allowance:
                typeof allowance === "bigint" ? allowance.toString() : null,
            }
          : {}),
      },
    };
  };
  return Promise.all([one(0), one(1)]);
}

/**
 * Everything a source-side review reads on Base — pins, USDC balance and allowance — from both operators at ONE
 * common block (review 1 F6): the engine requires pins and balances to describe the same block number and hash, which
 * two separately chosen blocks on a 2-second chain would not.
 */
export async function readSourceReviewPair(
  owner: string,
  selector: string,
  signal: AbortSignal,
): Promise<{
  blocks: [PoolBlock | null, PoolBlock | null];
  pins: [PinReads | null, PinReads | null];
  balances: [SourceRead | null, SourceRead | null];
}> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner))
    throw new PoolReadError("OWNER_INVALID");
  const blocks = await commonBlock("8453", signal);
  const [pins, balances] = await Promise.all([
    pinsAt(selector, signal, blocks),
    balancesAt("8453", owner, signal, blocks),
  ]);
  return { blocks, pins, balances };
}

/** Destination-side pin reads (Arbitrum) from both operators at the common block, each with its block and origin. */
export async function readDestinationPinsPair(
  signal: AbortSignal,
): Promise<
  [
    (DestinationPinReads & { source: SourceRead }) | null,
    (DestinationPinReads & { source: SourceRead }) | null,
  ]
> {
  const chain: PoolChain = "42161";
  const blocks = await commonBlock(chain, signal);
  const sp = CANARY_PINS.spokePools["42161"],
    u = CANARY_PINS.usdc["42161"];
  const one = async (index: 0 | 1) => {
    const b = blocks[index];
    if (!b) return null;
    const r = reader(chain, index, b.tag, signal);
    const [chainId, spCode, spImpl, uCode, uImpl, decimals, symbol] =
      await Promise.all([
        r.chainId(),
        r.code(sp.address),
        r.slot(sp.address, sp.implementation.slot),
        r.code(u.address),
        r.slot(u.address, u.implementation.slot),
        r.call<number>(u.address, "decimals", []),
        r.call<string>(u.address, "symbol", []),
      ]);
    const [spImplCode, uImplCode] = await Promise.all([
      spImpl ? (pinned(chain, spImpl) ? r.code(spImpl) : UNPINNED) : null,
      uImpl ? (pinned(chain, uImpl) ? r.code(uImpl) : UNPINNED) : null,
    ]);
    const reads: DestinationPinReads = {
      spokePool: {
        codehash: spCode,
        implementation: spImpl,
        implementationCodehash: spImplCode,
      },
      usdc: {
        codehash: uCode,
        implementation: uImpl,
        implementationCodehash: uImplCode,
        decimals: typeof decimals === "number" ? decimals : null,
        symbol: typeof symbol === "string" ? symbol : null,
      },
    };
    return {
      ...reads,
      // The same values as one comparable read, so the pair is reconciled like every other (agreeConfigured).
      source: {
        origin: originOf(chain, index),
        chainId,
        block: { number: b.number, hash: b.hash, timestamp: b.timestamp },
        values: {
          spokePoolCodehash: spCode,
          spokePoolImplementation: spImpl,
          spokePoolImplementationCodehash: spImplCode,
          usdcCodehash: uCode,
          usdcImplementation: uImpl,
          usdcImplementationCodehash: uImplCode,
          usdcDecimals: typeof decimals === "number" ? String(decimals) : null,
          usdcSymbol: typeof symbol === "string" ? symbol : null,
        },
      } satisfies SourceRead,
    };
  };
  return Promise.all([one(0), one(1)]);
}
// ------------------------------------------------------------------------------------------------------------------
// G14 closure (B4 / K4): fees, the L1 data fee, the account nonce, the simulation and the tracker's reads.
// The same rule everywhere: both operators, the same block, the same answer — or nothing.
const same2 = (a: unknown, b: unknown) =>
  a !== null &&
  a !== undefined &&
  b !== null &&
  b !== undefined &&
  JSON.stringify(a) === JSON.stringify(b);
/** Both operators state the same block (number, hash and time), or null. */
const agreedBlock = (
  blocks: [PoolBlock | null, PoolBlock | null],
): PoolBlock | null =>
  blocks[0] &&
  blocks[1] &&
  blocks[0].number === blocks[1].number &&
  blocks[0].hash === blocks[1].hash &&
  blocks[0].timestamp === blocks[1].timestamp
    ? blocks[0]
    : null;
export interface PoolFees {
  baseFeePerGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}
/**
 * Fee values for a review at the common block: the block's own base fee (both operators must state the same one) and
 * a priority fee. The priority fee is a SUGGESTION of each operator, not chain data, so the two need not be equal:
 * both must answer, and the HIGHER one is used (the conservative side for a budget). The fee cap is the usual
 * 2 x base fee + priority fee. One operator alone concludes nothing.
 */
async function feesAt(
  blocks: [PoolBlock | null, PoolBlock | null],
  signal: AbortSignal,
): Promise<PoolFees | null> {
  const b = agreedBlock(blocks);
  if (
    !b ||
    b.baseFeePerGas === null ||
    b.baseFeePerGas !== blocks[1]!.baseFeePerGas
  )
    return null;
  const tips = await Promise.all(
    ([0, 1] as const).map((i) =>
      poolRpc("8453", i, "eth_maxPriorityFeePerGas", [], signal)
        .then(quantity)
        .catch(() => null),
    ),
  );
  if (tips[0] === null || tips[1] === null) return null;
  const tip = BigInt(tips[0]) > BigInt(tips[1]) ? tips[0] : tips[1];
  return {
    baseFeePerGas: b.baseFeePerGas,
    maxPriorityFeePerGas: tip,
    maxFeePerGas: (BigInt(b.baseFeePerGas) * 2n + BigInt(tip)).toString(),
  };
}
/** The approved account's transaction count at the common block (both operators equal), or null. */
async function nonceAt(
  chain: PoolChain,
  owner: string,
  blocks: [PoolBlock | null, PoolBlock | null],
  signal: AbortSignal,
): Promise<string | null> {
  if (!agreedBlock(blocks)) return null;
  const n = await Promise.all(
    ([0, 1] as const).map((i) =>
      poolRpc(
        chain,
        i,
        "eth_getTransactionCount",
        [owner, blocks[i]!.tag],
        signal,
      )
        .then(quantity)
        .catch(() => null),
    ),
  );
  return n[0] !== null && n[0] === n[1] ? n[0] : null;
}
const ORACLE_ABI = parseAbi([
  "function getL1Fee(bytes) view returns (uint256)",
]);
export interface FeeTransaction {
  to: string;
  data: string;
  /** Decimal gas limit, fee caps and account nonce the wallet request will carry. */
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  nonce: string;
}
/**
 * The OP-stack L1 DATA fee (wei) of the given transactions on Base at the common block: GasPriceOracle.getL1Fee of
 * each unsigned EIP-1559 serialization, summed; both operators must return the same sum. This is the L1 part only —
 * the L2 execution cost (gas x fee) is a separate number and is never folded into it. It is an ESTIMATE made at the
 * review block: the fee actually charged is fixed when the transaction is included (stated; the mined receipt's own
 * l1Fee is what reconciliation reads). Unknown is null, never 0.
 */
async function l1FeeAt(
  transactions: readonly FeeTransaction[],
  blocks: [PoolBlock | null, PoolBlock | null],
  signal: AbortSignal,
): Promise<string | null> {
  if (!agreedBlock(blocks) || transactions.length === 0) return null;
  let bytes: Hex[];
  try {
    bytes = transactions.map((t) =>
      serializeTransaction({
        chainId: 8453,
        type: "eip1559",
        to: t.to as Hex,
        data: t.data as Hex,
        value: 0n,
        gas: BigInt(t.gas),
        maxFeePerGas: BigInt(t.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas),
        nonce: Number(BigInt(t.nonce)),
      }),
    );
  } catch {
    return null;
  }
  const one = async (index: 0 | 1): Promise<string | null> => {
    let total = 0n;
    for (const raw of bytes) {
      try {
        const out = await poolRpc(
          "8453",
          index,
          "eth_call",
          [
            {
              to: CANARY_PINS.gasPriceOracle,
              data: encodeFunctionData({
                abi: ORACLE_ABI,
                functionName: "getL1Fee",
                args: [raw],
              }),
            },
            blocks[index]!.tag,
          ],
          signal,
        );
        if (!isHex(out) || out.length !== 66) return null;
        total += decodeFunctionResult({
          abi: ORACLE_ABI,
          functionName: "getL1Fee",
          data: out,
        });
      } catch {
        return null;
      }
    }
    return total.toString();
  };
  const [a, b] = await Promise.all([one(0), one(1)]);
  return a !== null && a === b ? a : null;
}
/**
 * Everything ONE canary review reads on Base, from both operators at ONE common block: the pins for the call's
 * selector, the owner's USDC / native balance and allowance, the fee values, the account nonce and the L1 data fee of
 * the exact transactions the owner would sign (the exact approval when the allowance does not cover the amount, then
 * the reviewed call). Anything not agreed is null and keeps the review from being ready.
 */
export async function readCanaryReview(
  i: {
    owner: string;
    selector: string;
    amountIn: string;
    /** The reviewed call (the quote's own request): target, calldata and gas limit (decimal). */
    call: { to: string; data: string; gas: string };
  },
  signal: AbortSignal,
): Promise<{
  blocks: [PoolBlock | null, PoolBlock | null];
  pins: [PinReads | null, PinReads | null];
  balances: [SourceRead | null, SourceRead | null];
  fees: PoolFees | null;
  nonce: string | null;
  l1FeeWei: string | null;
}> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(i.owner))
    throw new PoolReadError("OWNER_INVALID");
  const blocks = await commonBlock("8453", signal);
  const [pins, balances, fees, nonce] = await Promise.all([
    pinsAt(i.selector, signal, blocks),
    balancesAt("8453", i.owner, signal, blocks),
    feesAt(blocks, signal),
    nonceAt("8453", i.owner, blocks, signal),
  ]);
  let l1FeeWei: string | null = null;
  const allowance =
    balances[0]?.values.allowance != null &&
    balances[0].values.allowance === balances[1]?.values.allowance
      ? balances[0].values.allowance
      : null;
  if (
    fees &&
    nonce !== null &&
    allowance !== null &&
    /^(0|[1-9]\d{0,40})$/.test(i.amountIn)
  ) {
    const needsApproval = BigInt(allowance) < BigInt(i.amountIn);
    const cap = {
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
    const txs: FeeTransaction[] = [];
    if (needsApproval)
      txs.push({
        to: CANARY_PINS.usdc["8453"].address,
        data: exactApproveCalldata(
          CANARY_PINS.diamond.address,
          BigInt(i.amountIn),
        ),
        // The approval's own limit is fixed after the simulation; the L1 data fee does not depend on the gas used,
        // only (slightly) on the encoded limit, so the simulation's allowance bound is used here.
        gas: "100000",
        nonce,
        ...cap,
      });
    txs.push({
      to: i.call.to,
      data: i.call.data,
      gas: i.call.gas,
      nonce: (BigInt(nonce) + (needsApproval ? 1n : 0n)).toString(),
      ...cap,
    });
    l1FeeWei = await l1FeeAt(txs, blocks, signal);
  }
  return { blocks, pins, balances, fees, nonce, l1FeeWei };
}
/**
 * eth_simulateV1 of the request the ENGINE built, at the reviewed block, from BOTH operators. The result counts only
 * when both returned the same thing; otherwise null (the engine then reads UNKNOWN / FAIL, never a pass). The
 * transport refuses any state override and any call that is not from the approved account to a pinned contract.
 */
export async function simulatePair(
  request: SimulationRequest,
  block: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (!/^(0|[1-9]\d{0,19})$/.test(block)) return null;
  const tag = `0x${BigInt(block).toString(16)}`;
  const [a, b] = await Promise.all(
    ([0, 1] as const).map((i) =>
      poolRpc("8453", i, "eth_simulateV1", [request, tag], signal).catch(
        () => null,
      ),
    ),
  );
  return same2(a, b) ? a : null;
}

// ---- tracker reads ------------------------------------------------------------------------------------------------
export interface PoolReceipt {
  hash: string;
  blockNumber: string;
  blockHash: string;
  /** true = status 0x1. */
  success: boolean;
  from: string;
  to: string | null;
  gasUsed: string;
  effectiveGasPrice: string;
  /** OP-stack L1 data fee actually charged (wei); null when the receipt does not carry one. */
  l1FeeWei: string | null;
  logs: ChainLog[];
}
const logOf = (l: unknown): ChainLog | null => {
  if (!l || typeof l !== "object") return null;
  const x = l as Record<string, unknown>;
  const number = quantity(x.blockNumber);
  if (
    typeof x.address !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(x.address) ||
    !Array.isArray(x.topics) ||
    !x.topics.every(
      (t) => typeof t === "string" && /^0x[0-9a-fA-F]{64}$/.test(t),
    ) ||
    !isHex(x.data) ||
    typeof x.transactionHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(x.transactionHash) ||
    number === null
  )
    return null;
  const time = quantity(x.blockTimestamp);
  return {
    address: x.address.toLowerCase(),
    topics: (x.topics as string[]).map((t) => t.toLowerCase()),
    data: x.data.toLowerCase(),
    transactionHash: x.transactionHash.toLowerCase(),
    blockNumber: number,
    ...(time !== null ? { timestamp: Number(time) } : {}),
    ...(x.removed === true ? { removed: true } : {}),
  };
};
const receiptOf = (r: unknown): PoolReceipt | null => {
  if (!r || typeof r !== "object") return null;
  const x = r as Record<string, unknown>;
  const number = quantity(x.blockNumber),
    gasUsed = quantity(x.gasUsed),
    price = quantity(x.effectiveGasPrice);
  if (
    typeof x.transactionHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(x.transactionHash) ||
    typeof x.blockHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(x.blockHash) ||
    (x.status !== "0x1" && x.status !== "0x0") ||
    typeof x.from !== "string" ||
    number === null ||
    gasUsed === null ||
    price === null ||
    !Array.isArray(x.logs) ||
    x.logs.length > MAX_LOGS
  )
    return null;
  const logs = x.logs.map(logOf);
  if (logs.some((l) => l === null)) return null;
  return {
    hash: x.transactionHash.toLowerCase(),
    blockNumber: number,
    blockHash: x.blockHash.toLowerCase(),
    success: x.status === "0x1",
    from: x.from.toLowerCase(),
    to: typeof x.to === "string" ? x.to.toLowerCase() : null,
    gasUsed,
    effectiveGasPrice: price,
    l1FeeWei: quantity(x.l1Fee),
    logs: logs as ChainLog[],
  };
};
/** No read returns more logs than this (a larger answer is treated as not read). */
export const MAX_LOGS = 400;
export type PairStatus = "AGREE" | "ABSENT" | "UNKNOWN";
/**
 * The receipt of `hash` from both operators, with the common head they were asked at. AGREE: both returned the same
 * mined receipt (block, status, gas, fee, logs). ABSENT: both say there is none. Anything else — one has it and the
 * other does not, different blocks, an unreadable answer, a source that failed — is UNKNOWN. `confirmations` counts
 * from the LOWER of the two heads. The caller must only ask for hashes it has recorded (the runtime's journal).
 */
export async function readReceiptPair(
  chain: PoolChain,
  hash: string,
  signal: AbortSignal,
): Promise<{
  status: PairStatus;
  receipt: PoolReceipt | null;
  confirmations: number | null;
  head: PoolBlock | null;
}> {
  const head = agreedBlock(await commonBlock(chain, signal));
  const raw = await Promise.all(
    ([0, 1] as const).map((i) =>
      poolRpc(chain, i, "eth_getTransactionReceipt", [hash], signal).then(
        (r) => ({ ok: true as const, r }),
        () => ({ ok: false as const, r: null }),
      ),
    ),
  );
  const none = { receipt: null, confirmations: null, head };
  if (!head || !raw[0].ok || !raw[1].ok) return { status: "UNKNOWN", ...none };
  if (raw[0].r === null && raw[1].r === null)
    return { status: "ABSENT", ...none };
  const a = receiptOf(raw[0].r),
    b = receiptOf(raw[1].r);
  if (
    !a ||
    !b ||
    !same2(a, b) ||
    a.hash !== hash.toLowerCase() ||
    BigInt(a.blockNumber) > BigInt(head.number)
  )
    return { status: "UNKNOWN", ...none };
  return {
    status: "AGREE",
    receipt: a,
    confirmations: Number(BigInt(head.number) - BigInt(a.blockNumber)) + 1,
    head,
  };
}
export interface PoolTransaction {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  nonce: string;
  /** Decimal block number, or null while the transaction is only in the mempool. */
  blockNumber: string | null;
}
const transactionOf = (t: unknown): PoolTransaction | null => {
  if (!t || typeof t !== "object") return null;
  const x = t as Record<string, unknown>;
  const value = quantity(x.value),
    nonce = quantity(x.nonce);
  if (
    typeof x.hash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(x.hash) ||
    typeof x.from !== "string" ||
    !isHex(x.input) ||
    value === null ||
    nonce === null
  )
    return null;
  return {
    hash: x.hash.toLowerCase(),
    from: x.from.toLowerCase(),
    to: typeof x.to === "string" ? x.to.toLowerCase() : null,
    input: x.input.toLowerCase(),
    value,
    nonce,
    blockNumber: x.blockNumber == null ? null : quantity(x.blockNumber),
  };
};
/**
 * The transaction behind `hash` as both operators know it. AGREE needs the same sender, target, calldata, value and
 * nonce from both (the mempool view may differ in the block field only). ABSENT: neither knows it.
 */
export async function readTransactionPair(
  chain: PoolChain,
  hash: string,
  signal: AbortSignal,
): Promise<{ status: PairStatus; transaction: PoolTransaction | null }> {
  const raw = await Promise.all(
    ([0, 1] as const).map((i) =>
      poolRpc(chain, i, "eth_getTransactionByHash", [hash], signal).then(
        (r) => ({ ok: true as const, r }),
        () => ({ ok: false as const, r: null }),
      ),
    ),
  );
  if (!raw[0].ok || !raw[1].ok) return { status: "UNKNOWN", transaction: null };
  if (raw[0].r === null && raw[1].r === null)
    return { status: "ABSENT", transaction: null };
  const a = transactionOf(raw[0].r),
    b = transactionOf(raw[1].r);
  if (
    !a ||
    !b ||
    a.hash !== hash.toLowerCase() ||
    !same2({ ...a, blockNumber: null }, { ...b, blockNumber: null })
  )
    return { status: "UNKNOWN", transaction: null };
  return { status: "AGREE", transaction: a };
}
/** The approved account's transaction count at the common head of `chain` (both operators equal), with that head. */
export async function readNoncePair(
  chain: PoolChain,
  owner: string,
  signal: AbortSignal,
): Promise<{ nonce: string | null; head: PoolBlock | null }> {
  const blocks = await commonBlock(chain, signal);
  return {
    nonce: await nonceAt(chain, owner, blocks, signal),
    head: agreedBlock(blocks),
  };
}
/**
 * G14 follow-up (review 13 R13-1, review 15 R15-1): ONE given block number on both operators — each states its header
 * for that number; they must agree on number, hash and time, and (review 14 R14-2) the agreed block must be THE asked
 * number, not another one. Null otherwise. The single check point of the two at-block reads below.
 */
async function blocksAtNumber(
  chain: PoolChain,
  number: string,
  signal: AbortSignal,
): Promise<[PoolBlock, PoolBlock] | null> {
  if (!/^\d{1,20}$/.test(number)) return null;
  const tag = `0x${BigInt(number).toString(16)}`;
  const at = await Promise.all(
    ([0, 1] as const).map((i) =>
      poolRpc(chain, i, "eth_getBlockByNumber", [tag, false], signal)
        .then((h) => header(h as Header))
        .catch(() => null),
    ),
  );
  const blocks: [PoolBlock | null, PoolBlock | null] = [at[0], at[1]];
  const b = agreedBlock(blocks);
  if (!b || b.number !== BigInt(number).toString()) return null;
  return [blocks[0]!, blocks[1]!];
}
/**
 * G14 follow-up (review 13 R13-1): the owner's nonce at ONE given block number, on both operators (blocksAtNumber).
 * Read only; the same two read methods as readNoncePair.
 */
export async function readNonceAtBlockPair(
  chain: PoolChain,
  owner: string,
  number: string,
  signal: AbortSignal,
): Promise<{ nonce: string | null; block: PoolBlock | null }> {
  const blocks = await blocksAtNumber(chain, number, signal);
  if (!blocks) return { nonce: null, block: null };
  return {
    nonce: await nonceAt(chain, owner, blocks, signal),
    block: blocks[0],
  };
}
/**
 * G14 follow-up (review 15 R15-1): the owner's balances at ONE given block number, on both operators (blocksAtNumber),
 * with that block — the reconciliation's FINAL-block reads. Read only; the same read methods as readBalancesAtHead.
 */
export async function readBalancesAtBlockPair(
  chain: PoolChain,
  owner: string,
  number: string,
  signal: AbortSignal,
): Promise<{
  balances: [SourceRead | null, SourceRead | null];
  block: PoolBlock | null;
}> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner))
    throw new PoolReadError("OWNER_INVALID");
  const blocks = await blocksAtNumber(chain, number, signal);
  if (!blocks) return { balances: [null, null], block: null };
  return {
    balances: await balancesAt(chain, owner, signal, blocks),
    block: blocks[0],
  };
}
/** The owner's balances on `chain` at the common head, with the agreed head (reconciliation reads). */
export async function readBalancesAtHead(
  chain: PoolChain,
  owner: string,
  signal: AbortSignal,
): Promise<{
  balances: [SourceRead | null, SourceRead | null];
  head: PoolBlock | null;
}> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner))
    throw new PoolReadError("OWNER_INVALID");
  const blocks = await commonBlock(chain, signal);
  return {
    balances: await balancesAt(chain, owner, signal, blocks),
    head: agreedBlock(blocks),
  };
}
/**
 * Event logs of pinned contracts over ONE bounded block range, from both operators; the range may not reach past the
 * common head. AGREE only when both returned the same list (at most MAX_LOGS entries). Every log carries its block's
 * time: taken from the log when the node reports it, otherwise from the block header both operators state (at most
 * `maxBlocks` distinct blocks; more is treated as not read).
 */
export async function readLogsPair(
  chain: PoolChain,
  filter: {
    address: string | readonly string[];
    topics: readonly (string | readonly string[] | null)[];
    /** Decimal block numbers, inclusive. */
    fromBlock: string;
    toBlock: string;
  },
  signal: AbortSignal,
  maxBlocks = 16,
): Promise<{
  status: PairStatus;
  logs: ChainLog[] | null;
  head: PoolBlock | null;
}> {
  const head = agreedBlock(await commonBlock(chain, signal));
  const fail = { status: "UNKNOWN" as const, logs: null, head };
  if (
    !head ||
    !/^(0|[1-9]\d{0,19})$/.test(filter.fromBlock) ||
    !/^(0|[1-9]\d{0,19})$/.test(filter.toBlock) ||
    BigInt(filter.toBlock) > BigInt(head.number)
  )
    return fail;
  const params = [
    {
      address: filter.address,
      fromBlock: `0x${BigInt(filter.fromBlock).toString(16)}`,
      toBlock: `0x${BigInt(filter.toBlock).toString(16)}`,
      topics: filter.topics,
    },
  ];
  const raw = await Promise.all(
    ([0, 1] as const).map((i) =>
      poolRpc(chain, i, "eth_getLogs", params, signal).catch(() => null),
    ),
  );
  const parse = (r: unknown): ChainLog[] | null => {
    if (!Array.isArray(r) || r.length > MAX_LOGS) return null;
    const logs = r.map(logOf);
    return logs.some((l) => l === null) ? null : (logs as ChainLog[]);
  };
  const a = parse(raw[0]),
    b = parse(raw[1]);
  if (!a || !b) return fail;
  const strip = (logs: ChainLog[]) =>
    logs.map((l) => ({ ...l, timestamp: undefined }));
  if (!same2(strip(a), strip(b))) return fail;
  // Block times, agreed by both operators for every block a log sits in.
  const missing = [
    ...new Set(
      a
        .filter((l) => !Number.isSafeInteger(l.timestamp))
        .map((l) => l.blockNumber),
    ),
  ];
  if (missing.length > maxBlocks) return fail;
  const times = new Map<string, number>();
  for (const n of missing) {
    const tag = `0x${BigInt(n).toString(16)}`;
    const hs = await Promise.all(
      ([0, 1] as const).map((i) =>
        poolRpc(chain, i, "eth_getBlockByNumber", [tag, false], signal)
          .then((h) => header(h as Header))
          .catch(() => null),
      ),
    );
    const blk = agreedBlock([hs[0], hs[1]]);
    if (!blk) return fail;
    times.set(n, blk.timestamp);
  }
  return {
    status: "AGREE",
    logs: a.map((l) =>
      Number.isSafeInteger(l.timestamp)
        ? l
        : { ...l, timestamp: times.get(l.blockNumber)! },
    ),
    head,
  };
}
