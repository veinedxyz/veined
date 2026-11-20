// VEINED-MC1 (BRIDGE LANE): the bridge lane's two transactions and an INDEPENDENT exact decoder for the LI.FI
// AcrossFacetV4 entry point swapAndStartBridgeTokensViaAcrossV4 (selector 0x1794958f) and its one fee step. A call is
// accepted only when decoding it and re-encoding the decoded arguments gives back EXACTLY the same bytes (canonical ABI:
// no planted bytes, no relocated offsets), the fee step's own calldata included, and when every decoded field is bound
// to THIS pair and record (docs/SPEC_BRIDGE_LANE.md "Review" 3; never looser than signer v5 bridgeCalldataProblems):
//   receiver = Across receiver = refund (= the facet's depositor) = owner, every bytes32 an EVM address;
//   sendingAssetId = source USDC, output token = destination USDC, destination chain = the pair's;
//   no destination call, empty message, hasSourceSwaps (the fee step);
//   exactly one source step: FeeCollector.forwardERC20Fees(source USDC, [(pinned recipient, <= 25 bps)]) from exactly
//   the record's amount, with requiresDeposit; sum(fees) + bridged = amount;
//   multiplier in (0, 1e18]; effective output (bridged x multiplier / 1e18, the facet's own arithmetic) >= minimum and
//   <= the amount; cost <= the record's cap; quote timestamp within +/-9 min (signer v5: 10, less a 60 s hand-off
//   margin); fill window 30 min - 6 h from now (signer v5: 28 min - 6 h at signing time);
//   exclusivity <= 300 s with a relayer only inside a window; referrer 0; integrator <= 64 characters.
import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  type Hex,
} from "viem";
import {
  BRIDGE_FEE_COLLECTOR,
  BRIDGE_FEE_RECIPIENT,
  BRIDGE_LANE_SELECTORS,
  BRIDGE_LIFI_DIAMOND,
} from "./bridge-pins";
import {
  BRIDGE_LANE_SCOPE,
  bridgeChainById,
  type BridgeLanePair,
} from "./bridge-scope";

const BD =
  "(bytes32 transactionId,string bridge,string integrator,address referrer,address sendingAssetId,address receiver,uint256 minAmount,uint256 destinationChainId,bool hasSourceSwaps,bool hasDestinationCall)";
const SD =
  "(address callTo,address approveTo,address sendingAssetId,address receivingAssetId,uint256 fromAmount,bytes callData,bool requiresDeposit)[]";
const AD =
  "(bytes32 receiverAddress,bytes32 refundAddress,bytes32 sendingAssetId,bytes32 receivingAssetId,uint256 outputAmount,uint128 outputAmountMultiplier,bytes32 exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityParameter,bytes message)";
export const BRIDGE_ACROSS_ABI = parseAbi([
  `function swapAndStartBridgeTokensViaAcrossV4(${BD} _bridgeData, ${SD} _swapData, ${AD} _acrossData) payable`,
]);
export const BRIDGE_FEE_ABI = parseAbi([
  "function forwardERC20Fees(address token, (address recipient, uint256 amount)[] fees)",
]);
export const BRIDGE_ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
type Pair = Readonly<BridgeLanePair>;
const lower = (a: string) => a.toLowerCase();
const same = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = "0x" + "0".repeat(64);
const asAddress = (b32: string) => `0x${b32.slice(-40)}`.toLowerCase();
const isEvm = (b32: string) => /^0x0{24}[0-9a-fA-F]{40}$/.test(b32);

function exact<T extends readonly unknown[]>(
  abi: T,
  data: unknown,
): { functionName: string; args: readonly unknown[] } | null {
  if (
    typeof data !== "string" ||
    !/^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{64})*$/.test(data)
  )
    return null;
  try {
    const d = decodeFunctionData({ abi: abi as never, data: data as Hex }) as {
      functionName: string;
      args: readonly unknown[];
    };
    const encode = encodeFunctionData as unknown as (p: {
      abi: unknown;
      functionName: string;
      args: readonly unknown[];
    }) => Hex;
    const again = encode({ abi, functionName: d.functionName, args: d.args });
    return lower(again) === lower(data) ? d : null;
  } catch {
    return null;
  }
}

/** approve(Diamond, amount) on the source USDC — the exact allowance to the pinned Diamond, nothing else. */
export function bridgeApproveCalldata(amount: bigint): Hex {
  return encodeFunctionData({
    abi: BRIDGE_ERC20_ABI,
    functionName: "approve",
    args: [BRIDGE_LIFI_DIAMOND as Hex, amount],
  });
}
/** Why an approve calldata is not the lane's exact approval of `amount` to the Diamond (null = it is). */
export function bridgeApproveProblem(
  data: unknown,
  amount: bigint,
): string | null {
  if (
    typeof data !== "string" ||
    !data.toLowerCase().startsWith(BRIDGE_LANE_SELECTORS.approve)
  )
    return "APPROVE_CALLDATA_NOT_CANONICAL";
  const d = exact(BRIDGE_ERC20_ABI, data);
  if (!d || d.functionName !== "approve")
    return "APPROVE_CALLDATA_NOT_CANONICAL";
  if (!same(d.args[0], BRIDGE_LIFI_DIAMOND))
    return "APPROVE_SPENDER_NOT_DIAMOND";
  if (d.args[1] !== amount) return "APPROVE_NOT_EXACT_AMOUNT";
  return null;
}

export interface DecodedFeeStep {
  callTo: string;
  approveTo: string;
  sendingAssetId: string;
  receivingAssetId: string;
  fromAmount: bigint;
  requiresDeposit: boolean;
  selector: string;
  /** The decoded forwardERC20Fees call (null: not the exact fee call). */
  fee: {
    token: string;
    entries: { recipient: string; amount: bigint }[];
  } | null;
}
export interface DecodedBridgeCall {
  transactionId: string;
  bridge: string;
  integrator: string;
  referrer: string;
  sendingAssetId: string;
  receiver: string;
  /** BridgeData.minAmount: what the facet bridges after the fee step. */
  bridged: bigint;
  destinationChainId: string;
  hasSourceSwaps: boolean;
  hasDestinationCall: boolean;
  steps: DecodedFeeStep[];
  across: {
    receiverAddress: string;
    refundAddress: string;
    sendingAssetId: string;
    receivingAssetId: string;
    outputAmount: bigint;
    multiplier: bigint;
    exclusiveRelayer: string;
    quoteTimestamp: number;
    fillDeadline: number;
    exclusivityParameter: number;
    message: string;
  };
}
/** Exact decoder: the pinned selector only, canonical bytes only (the fee step's calldata decoded exactly as well). */
export function decodeBridgeCall(data: unknown): DecodedBridgeCall | null {
  if (
    typeof data !== "string" ||
    !data.toLowerCase().startsWith(BRIDGE_LANE_SELECTORS.bridge)
  )
    return null;
  const d = exact(BRIDGE_ACROSS_ABI, data);
  if (!d || d.functionName !== "swapAndStartBridgeTokensViaAcrossV4")
    return null;
  const [bd, sd, ad] = d.args as [
    {
      transactionId: string;
      bridge: string;
      integrator: string;
      referrer: string;
      sendingAssetId: string;
      receiver: string;
      minAmount: bigint;
      destinationChainId: bigint;
      hasSourceSwaps: boolean;
      hasDestinationCall: boolean;
    },
    readonly {
      callTo: string;
      approveTo: string;
      sendingAssetId: string;
      receivingAssetId: string;
      fromAmount: bigint;
      callData: string;
      requiresDeposit: boolean;
    }[],
    {
      receiverAddress: string;
      refundAddress: string;
      sendingAssetId: string;
      receivingAssetId: string;
      outputAmount: bigint;
      outputAmountMultiplier: bigint;
      exclusiveRelayer: string;
      quoteTimestamp: number;
      fillDeadline: number;
      exclusivityParameter: number;
      message: string;
    },
  ];
  return {
    transactionId: lower(bd.transactionId),
    bridge: bd.bridge,
    integrator: bd.integrator,
    referrer: lower(bd.referrer),
    sendingAssetId: lower(bd.sendingAssetId),
    receiver: lower(bd.receiver),
    bridged: bd.minAmount,
    destinationChainId: bd.destinationChainId.toString(),
    hasSourceSwaps: bd.hasSourceSwaps,
    hasDestinationCall: bd.hasDestinationCall,
    steps: sd.map((s) => {
      const f =
        lower(s.callData).startsWith(BRIDGE_LANE_SELECTORS.forwardFees) &&
        exact(BRIDGE_FEE_ABI, s.callData);
      const [token, entries] = f
        ? (f.args as [string, readonly { recipient: string; amount: bigint }[]])
        : [null, null];
      return {
        callTo: lower(s.callTo),
        approveTo: lower(s.approveTo),
        sendingAssetId: lower(s.sendingAssetId),
        receivingAssetId: lower(s.receivingAssetId),
        fromAmount: s.fromAmount,
        requiresDeposit: s.requiresDeposit,
        selector: lower(s.callData.slice(0, 10)),
        fee:
          token !== null && entries !== null
            ? {
                token: lower(token),
                entries: entries.map((e) => ({
                  recipient: lower(e.recipient),
                  amount: e.amount,
                })),
              }
            : null,
      };
    }),
    across: {
      receiverAddress: lower(ad.receiverAddress),
      refundAddress: lower(ad.refundAddress),
      sendingAssetId: lower(ad.sendingAssetId),
      receivingAssetId: lower(ad.receivingAssetId),
      outputAmount: ad.outputAmount,
      multiplier: ad.outputAmountMultiplier,
      exclusiveRelayer: lower(ad.exclusiveRelayer),
      quoteTimestamp: Number(ad.quoteTimestamp),
      fillDeadline: Number(ad.fillDeadline),
      exclusivityParameter: Number(ad.exclusivityParameter),
      message: lower(ad.message),
    },
  };
}
export interface BridgeBinding {
  owner: string;
  /** The record's exact amount (source units). */
  exactAmount: bigint;
  /** The record's minimum (destination units). */
  minimumOut: bigint;
  /** The record's cost cap (<= the pair's 300 bps). */
  maxCostBps: number;
  nowSec: number;
}
export interface BridgeCallVerdict {
  problems: string[];
  call: DecodedBridgeCall | null;
  /** What the facet will deposit as Across outputAmount (destination units). */
  effectiveOutput: bigint | null;
  feeTotal: bigint | null;
  costBps: number | null;
}
/** Every way `data` is not exactly a bridge of THIS pair for THIS record at `nowSec` ([] = it is). */
export function bridgeCallProblems(
  pair: Pair,
  data: unknown,
  w: BridgeBinding,
): BridgeCallVerdict {
  const call = decodeBridgeCall(data);
  const none = (p: string[]): BridgeCallVerdict => ({
    problems: p,
    call,
    effectiveOutput: null,
    feeTotal: null,
    costBps: null,
  });
  if (!call) return none(["BRIDGE_CALLDATA_NOT_CANONICAL"]);
  const S = bridgeChainById(pair.source),
    D = bridgeChainById(pair.destination);
  if (!S || !D) return none(["BRIDGE_PAIR_UNKNOWN"]);
  const p: string[] = [];
  const owner = lower(w.owner);
  const srcUsdc = lower(S.usdc.address),
    dstUsdc = lower(D.usdc.address);
  const a = call.across;
  if (call.bridge !== BRIDGE_LANE_SCOPE.tool) p.push("BRIDGE_TOOL_NOT_ACROSS");
  if (call.referrer !== ZERO) p.push("BRIDGE_REFERRER_SET");
  if (call.integrator.length > BRIDGE_LANE_SCOPE.maxIntegratorLength)
    p.push("BRIDGE_INTEGRATOR_TOO_LONG");
  if (call.receiver !== owner) p.push("BRIDGE_RECEIVER_NOT_OWNER");
  if (call.sendingAssetId !== srcUsdc) p.push("BRIDGE_ASSET_NOT_SOURCE_USDC");
  if (call.destinationChainId !== pair.destination)
    p.push("BRIDGE_DESTINATION_NOT_PAIR");
  if (call.hasDestinationCall) p.push("BRIDGE_DESTINATION_CALL");
  if (!call.hasSourceSwaps) p.push("BRIDGE_EXPECTS_FEE_STEP");
  if (a.message !== "0x") p.push("BRIDGE_MESSAGE_NOT_EMPTY");
  if (
    ![
      a.receiverAddress,
      a.refundAddress,
      a.sendingAssetId,
      a.receivingAssetId,
      a.exclusiveRelayer,
    ].every(isEvm)
  )
    p.push("BRIDGE_NON_EVM_ADDRESS");
  if (asAddress(a.receiverAddress) !== owner)
    p.push("ACROSS_RECEIVER_NOT_OWNER");
  if (asAddress(a.refundAddress) !== owner) p.push("ACROSS_REFUND_NOT_OWNER");
  if (asAddress(a.sendingAssetId) !== srcUsdc)
    p.push("ACROSS_INPUT_NOT_SOURCE_USDC");
  if (asAddress(a.receivingAssetId) !== dstUsdc)
    p.push("ACROSS_OUTPUT_NOT_DESTINATION_USDC");
  // Exactly one source step: LI.FI's pinned fee collection on the source USDC, from exactly the record amount.
  let feeTotal: bigint | null = null;
  if (call.steps.length !== 1) p.push("BRIDGE_STEP_COUNT");
  else {
    const s = call.steps[0];
    if (
      s.callTo !== BRIDGE_FEE_COLLECTOR ||
      s.approveTo !== BRIDGE_FEE_COLLECTOR
    )
      p.push("BRIDGE_STEP_NOT_FEE_COLLECTOR");
    if (s.sendingAssetId !== srcUsdc || s.receivingAssetId !== srcUsdc)
      p.push("BRIDGE_STEP_TOKEN");
    if (s.fromAmount !== w.exactAmount) p.push("BRIDGE_INPUT_NOT_EXACT");
    if (s.requiresDeposit !== true) p.push("BRIDGE_STEP_REQUIRES_DEPOSIT");
    if (s.selector !== BRIDGE_LANE_SELECTORS.forwardFees || !s.fee)
      p.push("BRIDGE_FEE_CALL_NOT_CANONICAL");
    else {
      if (s.fee.token !== srcUsdc) p.push("BRIDGE_FEE_TOKEN");
      if (s.fee.entries.length !== 1) p.push("BRIDGE_FEE_ENTRIES");
      for (const e of s.fee.entries) {
        if (e.recipient !== BRIDGE_FEE_RECIPIENT)
          p.push("BRIDGE_FEE_RECIPIENT_NOT_PINNED");
        if (e.amount > pair.maxFee) p.push("BRIDGE_FEE_ABOVE_25_BPS");
      }
      feeTotal = s.fee.entries.reduce((acc, e) => acc + e.amount, 0n);
      if (feeTotal + call.bridged !== w.exactAmount)
        p.push("BRIDGE_FEE_ARITHMETIC");
    }
  }
  const inU = 10n ** BigInt(S.usdc.decimals),
    outU = 10n ** BigInt(D.usdc.decimals);
  const toOut = (x: bigint) => (x * outU) / inU;
  if (call.bridged > w.exactAmount) p.push("BRIDGE_BRIDGED_ABOVE_INPUT");
  if (toOut(call.bridged) < w.minimumOut)
    p.push("BRIDGE_BRIDGED_BELOW_MINIMUM");
  if (a.multiplier <= 0n || a.multiplier > pair.maxMultiplier)
    p.push("BRIDGE_MULTIPLIER_BOUNDS");
  // The facet's own arithmetic on the swap path (AcrossFacetV4: minAmountAfterSwaps * multiplier / 1e18).
  const effective =
    (call.bridged * a.multiplier) / BRIDGE_LANE_SCOPE.multiplierBase;
  if (effective < w.minimumOut) p.push("BRIDGE_OUTPUT_BELOW_MINIMUM");
  if (effective > toOut(w.exactAmount)) p.push("BRIDGE_OUTPUT_ABOVE_INPUT");
  // Cost in USDC-equivalent 6 decimals (both ends 6 decimals on every ENABLED pair).
  const in6 = (w.exactAmount * 1_000_000n) / inU,
    out6 = (effective * 1_000_000n) / outU;
  const lost = in6 - (out6 < in6 ? out6 : in6);
  const costBps = in6 > 0n ? Number((lost * 10_000n) / in6) : 10_000;
  if (
    !Number.isInteger(w.maxCostBps) ||
    w.maxCostBps > pair.maxCostBps ||
    lost * 10_000n > BigInt(Math.max(0, w.maxCostBps)) * in6
  )
    p.push("BRIDGE_COST_ABOVE_CAP");
  if (
    Math.abs(a.quoteTimestamp - w.nowSec) >
    BRIDGE_LANE_SCOPE.maxQuoteSkewSec - BRIDGE_LANE_SCOPE.quoteSkewMarginSec
  )
    p.push("BRIDGE_QUOTE_TIMESTAMP_SKEW");
  const fillWindow = a.fillDeadline - w.nowSec;
  if (
    fillWindow < BRIDGE_LANE_SCOPE.minFillWindowSec ||
    fillWindow > BRIDGE_LANE_SCOPE.maxFillWindowSec
  )
    p.push("BRIDGE_FILL_DEADLINE_WINDOW");
  const x = a.exclusivityParameter;
  if (x > BRIDGE_LANE_SCOPE.maxExclusivitySec) p.push("BRIDGE_EXCLUSIVITY");
  if (x === 0 && a.exclusiveRelayer !== ZERO32)
    p.push("BRIDGE_EXCLUSIVE_RELAYER_WITHOUT_WINDOW");
  if (x > 0 && a.exclusiveRelayer === ZERO32)
    p.push("BRIDGE_EXCLUSIVITY_WITHOUT_RELAYER");
  return {
    problems: p,
    call,
    effectiveOutput: effective,
    feeTotal,
    costBps,
  };
}

/** Decimal or 0x-hex quantity (LI.FI sends hex), else null. */
const quantity = (v: unknown): bigint | null => {
  if (typeof v === "string" && /^(0|[1-9]\d{0,40})$/.test(v)) return BigInt(v);
  if (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v))
    return BigInt(v);
  return null;
};
const plain = (o: unknown): o is Record<string, unknown> =>
  !!o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.getPrototypeOf(o) === Object.prototype;
export interface BridgeQuoteVerdict {
  problems: string[];
  /** The quote's transaction data (only when it is a string of the bridge selector). */
  data: string | null;
  quotedMinimum: bigint | null;
  gasLimit: bigint | null;
}
/**
 * The LI.FI quote ITSELF (docs/SPEC_BRIDGE_LANE.md "Review" 2): tool across, to = Diamond, from = owner, the source
 * chain, selector 0x1794958f, value 0, approvalAddress = Diamond, the record's amount, a bounded gasLimit; the action's
 * chains, tokens and addresses are the pair's and the owner's. Its numbers only have to AGREE with the calldata, which
 * bridgeCallProblems() decides from the bytes.
 */
export function bridgeQuoteProblems(
  pair: Pair,
  quote: unknown,
  owner: string,
): BridgeQuoteVerdict {
  const out: BridgeQuoteVerdict = {
    problems: [],
    data: null,
    quotedMinimum: null,
    gasLimit: null,
  };
  const p = out.problems;
  const S = bridgeChainById(pair.source),
    D = bridgeChainById(pair.destination);
  if (!plain(quote) || !S || !D) {
    p.push("QUOTE_SHAPE");
    return out;
  }
  if (quote.tool !== BRIDGE_LANE_SCOPE.tool) p.push("QUOTE_TOOL_NOT_ACROSS");
  const tx = quote.transactionRequest,
    est = quote.estimate,
    act = quote.action;
  if (!plain(tx) || !plain(est) || !plain(act)) {
    p.push("QUOTE_SHAPE");
    return out;
  }
  if (!same(tx.to, BRIDGE_LIFI_DIAMOND)) p.push("QUOTE_TARGET_NOT_DIAMOND");
  if (!same(tx.from, owner)) p.push("QUOTE_FROM_NOT_OWNER");
  if (String(tx.chainId) !== pair.source) p.push("QUOTE_CHAIN_NOT_SOURCE");
  if (quantity(tx.value ?? "0x0") !== 0n) p.push("QUOTE_NATIVE_VALUE");
  if (
    typeof tx.data !== "string" ||
    !tx.data.toLowerCase().startsWith(BRIDGE_LANE_SELECTORS.bridge)
  )
    p.push("QUOTE_SELECTOR_NOT_ACROSS_V4");
  else out.data = tx.data.toLowerCase();
  const gas = quantity(tx.gasLimit);
  if (gas === null || gas <= 0n || gas > BRIDGE_LANE_SCOPE.maxQuoteGasLimit)
    p.push("QUOTE_GAS_LIMIT_UNBOUNDED");
  else out.gasLimit = gas;
  if (!same(est.approvalAddress, BRIDGE_LIFI_DIAMOND))
    p.push("QUOTE_SPENDER_NOT_DIAMOND");
  if (quantity(est.fromAmount) !== pair.exactAmount)
    p.push("QUOTE_AMOUNT_NOT_EXACT");
  out.quotedMinimum = quantity(est.toAmountMin);
  if (out.quotedMinimum === null) p.push("QUOTE_MINIMUM_UNREADABLE");
  if (
    String(act.fromChainId) !== pair.source ||
    String(act.toChainId) !== pair.destination
  )
    p.push("QUOTE_ACTION_CHAINS");
  const tok = (t: unknown) =>
    plain(t) ? t.address : typeof t === "string" ? t : null;
  if (
    !same(tok(act.fromToken), S.usdc.address) ||
    !same(tok(act.toToken), D.usdc.address)
  )
    p.push("QUOTE_ACTION_TOKENS");
  if (!same(act.fromAddress, owner) || !same(act.toAddress, owner))
    p.push("QUOTE_ACTION_ADDRESSES");
  return out;
}
