// G14 Track A: an INDEPENDENT decoder for the pinned LI.FI AcrossFacetV4 entry points (closes G13 limit §5-3 for the
// canary route). Only the one pinned selector is accepted, and only when re-encoding the decoded arguments gives
// back EXACTLY the input bytes (canonical ABI: no planted bytes, no relocated offsets, the third argument included).
// Only swapAndStartBridgeTokensViaAcrossV4 (the pinned selector) is accepted (review F1).
// It proves from the calldata itself: BridgeData (receiver, asset, bridged amount, destination, flags, referrer),
// the source steps (only LI.FI's pinned fee collection, exact fee payments) and the facet data (Across receiver,
// refund / depositor address, input and output tokens, output multiplier, deadlines, message). The output the facet
// will really deposit is computed the way the facet computes it (AcrossFacetV4.sol: minAmountAfterSwaps *
// outputAmountMultiplier / 1e18 on the swap path; outputAmount as given on the direct path).
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  type Hex,
} from "viem";
import { CANARY_PINS } from "./pins";

const BD =
  "(bytes32 transactionId,string bridge,string integrator,address referrer,address sendingAssetId,address receiver,uint256 minAmount,uint256 destinationChainId,bool hasSourceSwaps,bool hasDestinationCall)";
const SD =
  "(address callTo,address approveTo,address sendingAssetId,address receivingAssetId,uint256 fromAmount,bytes callData,bool requiresDeposit)[]";
const AD =
  "(bytes32 receiverAddress,bytes32 refundAddress,bytes32 sendingAssetId,bytes32 receivingAssetId,uint256 outputAmount,uint128 outputAmountMultiplier,bytes32 exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityParameter,bytes message)";
export const ACROSS_V4_ABI = parseAbi([
  `function swapAndStartBridgeTokensViaAcrossV4(${BD} _bridgeData, ${SD} _swapData, ${AD} _acrossData) payable`,
  `function startBridgeTokensViaAcrossV4(${BD} _bridgeData, ${AD} _acrossData) payable`,
]);
const FEE_ENTRIES = [
  { type: "address" },
  { type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }] },
] as const;
export const MULTIPLIER_BASE = 10n ** 18n;

export interface AcrossFee {
  recipient: string;
  amount: bigint;
}
export interface AcrossCall {
  selector: string;
  path: "swapAndStart" | "start";
  bridge: string;
  integrator: string;
  referrer: string;
  sendingAssetId: string;
  receiver: string;
  /** BridgeData.minAmount: the amount the facet bridges (after the fee step on the swap path). */
  bridgedAmount: bigint;
  destinationChainId: string;
  hasSourceSwaps: boolean;
  hasDestinationCall: boolean;
  /** Source steps; each must be a pinned fee collection (fees null = not a recognised fee step). */
  steps: {
    callTo: string;
    approveTo: string;
    token: string;
    receivingToken: string;
    fromAmount: bigint;
    selector: string;
    fees: AcrossFee[] | null;
  }[];
  across: {
    receiver: string;
    refund: string;
    inputToken: string;
    outputToken: string;
    outputAmount: bigint;
    multiplier: bigint;
    exclusiveRelayer: string;
    quoteTimestamp: number;
    fillDeadline: number;
    exclusivityParameter: number;
    message: string;
    /** bytes32 address fields whose upper 12 bytes are not zero (cannot be an EVM address). */
    nonEvmAddress: boolean;
  };
  /** What the facet will deposit as the Across output amount (raw units of the output token). */
  effectiveOutput: bigint;
}
const lower = (a: string) => a.toLowerCase();
const asAddress = (b32: string) => `0x${b32.slice(-40)}`.toLowerCase();
const isEvm = (b32: string) => /^0x0{24}[0-9a-fA-F]{40}$/.test(b32);

export function decodeAcrossCall(data: unknown): AcrossCall | null {
  if (
    typeof data !== "string" ||
    !/^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{64})+$/.test(data)
  )
    return null;
  const selector = data.slice(0, 10).toLowerCase();
  // Only the pinned swap-and-start entry point is in scope (round-1 review F1).
  if (selector !== CANARY_PINS.selector) return null;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: ACROSS_V4_ABI, data: data as Hex });
    const again = encodeFunctionData({
      abi: ACROSS_V4_ABI,
      functionName: decoded.functionName,
      args: decoded.args as never,
    });
    if (lower(again) !== lower(data)) return null;
  } catch {
    return null;
  }
  const swapPath =
    decoded.functionName === "swapAndStartBridgeTokensViaAcrossV4";
  if (!swapPath) return null;
  const args = decoded.args as readonly unknown[];
  const bd = args[0] as {
    bridge: string;
    integrator: string;
    referrer: string;
    sendingAssetId: string;
    receiver: string;
    minAmount: bigint;
    destinationChainId: bigint;
    hasSourceSwaps: boolean;
    hasDestinationCall: boolean;
  };
  const sd = (swapPath ? args[1] : []) as {
    callTo: string;
    approveTo: string;
    sendingAssetId: string;
    receivingAssetId: string;
    fromAmount: bigint;
    callData: string;
  }[];
  const ad = (swapPath ? args[2] : args[1]) as {
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
  };
  if (bd.bridge.length > 64 || bd.integrator.length > 64) return null;
  const fc = CANARY_PINS.feeCollector;
  const steps = sd.map((s) => {
    let fees: AcrossFee[] | null = null;
    if (
      lower(s.callTo) === fc.address &&
      lower(s.approveTo) === fc.address &&
      lower(s.callData.slice(0, 10)) === fc.selector
    ) {
      try {
        const [token, entries] = decodeAbiParameters(
          FEE_ENTRIES,
          `0x${s.callData.slice(10)}` as Hex,
        );
        fees =
          lower(token) === lower(s.sendingAssetId)
            ? entries.map(([recipient, amount]) => ({
                recipient: lower(recipient),
                amount,
              }))
            : null;
      } catch {
        fees = null;
      }
    }
    return {
      callTo: lower(s.callTo),
      approveTo: lower(s.approveTo),
      token: lower(s.sendingAssetId),
      receivingToken: lower(s.receivingAssetId),
      fromAmount: s.fromAmount,
      selector: lower(s.callData.slice(0, 10)),
      fees,
    };
  });
  const effectiveOutput = swapPath
    ? (bd.minAmount * ad.outputAmountMultiplier) / MULTIPLIER_BASE
    : ad.outputAmount;
  return {
    selector,
    path: swapPath ? "swapAndStart" : "start",
    bridge: bd.bridge,
    integrator: bd.integrator,
    referrer: lower(bd.referrer),
    sendingAssetId: lower(bd.sendingAssetId),
    receiver: lower(bd.receiver),
    bridgedAmount: bd.minAmount,
    destinationChainId: bd.destinationChainId.toString(),
    hasSourceSwaps: bd.hasSourceSwaps,
    hasDestinationCall: bd.hasDestinationCall,
    steps,
    across: {
      receiver: asAddress(ad.receiverAddress),
      refund: asAddress(ad.refundAddress),
      inputToken: asAddress(ad.sendingAssetId),
      outputToken: asAddress(ad.receivingAssetId),
      outputAmount: ad.outputAmount,
      multiplier: ad.outputAmountMultiplier,
      exclusiveRelayer: lower(ad.exclusiveRelayer),
      quoteTimestamp: ad.quoteTimestamp,
      fillDeadline: ad.fillDeadline,
      exclusivityParameter: ad.exclusivityParameter,
      message: lower(ad.message),
      nonEvmAddress: ![
        ad.receiverAddress,
        ad.refundAddress,
        ad.sendingAssetId,
        ad.receivingAssetId,
        ad.exclusiveRelayer,
      ].every(isEvm),
    },
    effectiveOutput,
  };
}
