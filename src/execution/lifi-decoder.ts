// G13: an INDEPENDENT decoder for LI.FI bridge calls (a TrustedDecoder input for src/security/firewall.ts). Hardened
// after the Phase 3 review (F01/F02): only an ALLOWLISTED selector with its exact, canonical ABI head is decoded —
// any other function, or planted bytes behind a non-canonical offset, yields null (the checks then stay UNKNOWN).
// What it proves from the calldata itself (never from the provider's own "decoded" fields):
//   - ILiFi.BridgeData: receiver, sending asset, bridged amount, destination chain, destination-call flag, referrer;
//   - every source-side swap step: only a fee collection through the pinned LI.FI fee collector of that chain, paid in
//     the sent token to a pinned fee recipient, with the exact fee amounts.
// What it does NOT prove (stated, not guessed): the facet-specific data (third argument: the destination asset and
// minimum of the intents order) and whether the facet enforces BridgeData.receiver — so recipient and destination
// minimum stay UNKNOWN in the preflight until a reviewed facet decoder + code pin exist (PROTECTED_CHANGE_PROPOSAL B2).
import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";

/** Observed LI.FI facet selectors (live read-only quote, G13 evidence g13-lifi-probe) and their exact ABI head. */
export const LIFI_BRIDGE_SELECTORS: Readonly<
  Record<
    string,
    {
      label: string;
      headWords: number;
      sourceSwaps: boolean;
      receiverEnforced: boolean;
    }
  >
> = Object.freeze({
  "0x6d21c5df": {
    label:
      "LI.FI intents facet (swap-and-start: BridgeData, SwapData[], facet data) — name not verified",
    headWords: 3,
    sourceSwaps: true,
    // Unknown until the facet code is reviewed: the facet data may carry its own receiver.
    receiverEnforced: false,
  },
});
/** LI.FI fee collector per chain (observed as the only source-swap step) and the fee recipients it paid. */
export const LIFI_FEE_COLLECTORS: Readonly<
  Record<
    string,
    { address: string; selector: string; recipients: readonly string[] }
  >
> = Object.freeze({
  "8453": {
    address: "0xde2b920506ee931a6a2abdf566526220214fbbae",
    selector: "0x332d746b",
    recipients: ["0xc06ebbefd94032b85424d51906e2a335efae264b"],
  },
});

const BRIDGE_DATA = {
  type: "tuple",
  components: [
    { name: "transactionId", type: "bytes32" },
    { name: "bridge", type: "string" },
    { name: "integrator", type: "string" },
    { name: "referrer", type: "address" },
    { name: "sendingAssetId", type: "address" },
    { name: "receiver", type: "address" },
    { name: "minAmount", type: "uint256" },
    { name: "destinationChainId", type: "uint256" },
    { name: "hasSourceSwaps", type: "bool" },
    { name: "hasDestinationCall", type: "bool" },
  ],
} as const;
const SWAP_DATA = {
  type: "tuple[]",
  components: [
    { name: "callTo", type: "address" },
    { name: "approveTo", type: "address" },
    { name: "sendingAssetId", type: "address" },
    { name: "receivingAssetId", type: "address" },
    { name: "fromAmount", type: "uint256" },
    { name: "callData", type: "bytes" },
    { name: "requiresDeposit", type: "bool" },
  ],
} as const;
const FEE_ENTRIES = [
  { type: "address" },
  { type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }] },
] as const;

export interface LifiFeeStep {
  collector: string;
  token: string;
  fromAmount: bigint;
  /** Exact fee payments of this step; null when the step is not a recognised fee collection. */
  fees: { recipient: string; amount: bigint }[] | null;
  sameAsset: boolean;
}
export interface LifiBridgeCall {
  selector: string;
  bridge: string;
  integrator: string;
  referrer: string;
  sendingAssetId: string;
  receiver: string;
  minAmount: bigint;
  destinationChainId: string;
  hasSourceSwaps: boolean;
  hasDestinationCall: boolean;
  receiverEnforced: boolean;
  swaps: LifiFeeStep[];
}
const word = (data: string, i: number) =>
  BigInt(`0x${data.slice(10 + i * 64, 10 + (i + 1) * 64) || "0"}`);
const lower = (a: string) => a.toLowerCase();

export function decodeLifiBridgeCall(
  data: string,
  chainId: string,
): LifiBridgeCall | null {
  if (!/^0x[0-9a-fA-F]+$/.test(data) || (data.length - 10) % 64 !== 0)
    return null;
  const selector = data.slice(0, 10).toLowerCase();
  const spec = LIFI_BRIDGE_SELECTORS[selector];
  if (!spec || data.length < 10 + 64 * spec.headWords) return null;
  // Canonical head: the first argument (BridgeData) starts right after the head words, and every later offset is
  // 32-byte aligned, strictly increasing and inside the call (review N10); below, the first two arguments must also be
  // byte-exact canonical encodings at their canonical offsets (review round 3).
  if (word(data, 0) !== BigInt(32 * spec.headWords)) return null;
  const argBytes = BigInt((data.length - 10) / 2);
  for (let i = 1; i < spec.headWords; i++) {
    const o = word(data, i);
    if (o % 32n !== 0n || o <= word(data, i - 1) || o >= argBytes) return null;
  }
  try {
    const args = `0x${data.slice(10)}` as Hex;
    const [bd] = decodeAbiParameters([BRIDGE_DATA], args);
    if (bd.bridge.length > 64 || bd.integrator.length > 64) return null;
    if (bd.hasSourceSwaps !== spec.sourceSwaps) return null;
    const swaps: LifiFeeStep[] = [];
    if (spec.sourceSwaps) {
      const [, steps] = decodeAbiParameters([BRIDGE_DATA, SWAP_DATA], args);
      // Byte-exact canonical layout of the two arguments this decoder proves (review round 3, N10): re-encoding the
      // decoded values must give exactly the bytes at exactly the canonical offsets — a relocated, padded or planted
      // argument is refused. The third (facet) argument is not decoded, so its own length is not proven.
      const tail = (encoded: string) => encoded.slice(2 + 64); // drop the single-argument head word
      const bdBytes = tail(encodeAbiParameters([BRIDGE_DATA], [bd]));
      const swBytes = tail(encodeAbiParameters([SWAP_DATA], [steps]));
      const o1 = BigInt(32 * spec.headWords) + BigInt(bdBytes.length / 2);
      const o2 = o1 + BigInt(swBytes.length / 2);
      const body = data.slice(10);
      const at = (o: bigint, len: number) =>
        body.slice(Number(o) * 2, Number(o) * 2 + len);
      if (
        word(data, 1) !== o1 ||
        (spec.headWords > 2 && word(data, 2) !== o2) ||
        lower(at(BigInt(32 * spec.headWords), bdBytes.length)) !==
          lower(bdBytes) ||
        lower(at(o1, swBytes.length)) !== lower(swBytes)
      )
        return null;
      const collector = LIFI_FEE_COLLECTORS[chainId];
      for (const s of steps) {
        let fees: LifiFeeStep["fees"] = null;
        if (
          collector &&
          lower(s.callTo) === collector.address &&
          lower(s.approveTo) === collector.address &&
          lower(s.callData.slice(0, 10)) === collector.selector
        ) {
          try {
            const [token, entries] = decodeAbiParameters(
              FEE_ENTRIES,
              `0x${s.callData.slice(10)}` as Hex,
            );
            fees =
              lower(token) === lower(s.sendingAssetId)
                ? entries.map(([recipient, amount]) => ({ recipient, amount }))
                : null;
          } catch {
            fees = null;
          }
        }
        swaps.push({
          collector: s.callTo,
          token: s.sendingAssetId,
          fromAmount: s.fromAmount,
          fees,
          sameAsset: lower(s.sendingAssetId) === lower(s.receivingAssetId),
        });
      }
    }
    return {
      selector,
      bridge: bd.bridge,
      integrator: bd.integrator,
      referrer: bd.referrer,
      sendingAssetId: bd.sendingAssetId,
      receiver: bd.receiver,
      minAmount: bd.minAmount,
      destinationChainId: bd.destinationChainId.toString(),
      hasSourceSwaps: bd.hasSourceSwaps,
      hasDestinationCall: bd.hasDestinationCall,
      receiverEnforced: spec.receiverEnforced,
      swaps,
    };
  } catch {
    return null;
  }
}
/**
 * The source steps as fees: every step must be a pure fee collection (same asset in and out, the sent token, the
 * first step pulling exactly the amount sent) to a pinned fee recipient. A payment to any other address is a hidden
 * fee (FAIL); a step that is not a recognised fee collection cannot be read (UNKNOWN).
 */
export function lifiFees(
  call: LifiBridgeCall,
  chainId: string,
  payToken: string,
  amountIn: bigint,
):
  | { sum: bigint }
  | {
      problem:
        | "SOURCE_SWAP_NOT_DECODED"
        | "UNEXPECTED_FEE_RECIPIENT"
        | "SOURCE_SWAP_NOT_FEE";
      definitive: boolean;
    } {
  const collector = LIFI_FEE_COLLECTORS[chainId];
  let sum = 0n;
  for (const [i, s] of call.swaps.entries()) {
    if (!s.fees)
      return { problem: "SOURCE_SWAP_NOT_DECODED", definitive: false };
    if (
      !s.sameAsset ||
      lower(s.token) !== lower(payToken) ||
      (i === 0 && s.fromAmount !== amountIn)
    )
      return { problem: "SOURCE_SWAP_NOT_FEE", definitive: true };
    for (const f of s.fees) {
      if (!collector?.recipients.includes(lower(f.recipient)))
        return { problem: "UNEXPECTED_FEE_RECIPIENT", definitive: true };
      sum += f.amount;
    }
  }
  return { sum };
}
