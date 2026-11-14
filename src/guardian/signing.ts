// Chain Signatures behind Guardian: the signing envelope a NEAR account (or the future Guardian vault contract) would
// send to the MPC signer. PREPARED ONLY: this module builds a plain object for review and display; nothing here
// calls a wallet, a relayer, an RPC or the signer. The envelope exists only when Guardian's verdict allows it, and it
// carries that verdict's digest so the signature request is bound to the exact review the user saw.
//
// Gate (fail closed; no verdict level silently grants a signing request):
//   BLOCK                                   → REFUSED_BY_GUARDIAN
//   any non-overridable finding             → REFUSED_BY_GUARDIAN (stale quote, invalid / mismatched signed quote)
//   HOLD    without an explicit human confirmation   → NEEDS_HUMAN_CONFIRMATION
//   CAUTION without an explicit acknowledgement      → NEEDS_ACKNOWLEDGEMENT
//   CLEAR, or the matching explicit consent above    → PREPARED_NOT_SUBMITTED
//
// Signer contracts: mainnet `v1.signer`, testnet `v1.signer-prod.testnet` (domain 0 = secp256k1 / ECDSA).
// The address a request signs for is derived from (predecessor account, path): the same account and path always
// give the same foreign address, and the account that calls the signer is the predecessor.
import type { FindingCode, Level, Verdict } from "./model";

export const MPC_SIGNER = Object.freeze({
  mainnet: "v1.signer",
  testnet: "v1.signer-prod.testnet",
});
export type SignerNetwork = keyof typeof MPC_SIGNER;
/** Findings no human confirmation can override: the reviewed data itself is not current or not authentic. */
export const NON_OVERRIDABLE: readonly FindingCode[] = [
  "ROUTE_STALE",
  "INTENTS_SIGNATURE_INVALID",
  "INTENTS_QUOTE_MISMATCH",
];
export interface SigningEnvelope {
  state: "PREPARED_NOT_SUBMITTED";
  network: SignerNetwork;
  /** The account whose derived key would sign (the predecessor of the signer call). */
  predecessor: string;
  receiverId: string;
  methodName: "sign";
  args: {
    request: { path: string; payload_v2: { Ecdsa: string }; domain_id: 0 };
  };
  /** The signer requires an attached deposit; function-call keys cannot attach one (see ARCHITECTURE.md). */
  deposit: "1";
  gas: "250000000000000";
  guardian: { policy: string; level: Level; digest: string };
}
type Refusal = {
  state:
    | "REFUSED_BY_GUARDIAN"
    | "NEEDS_HUMAN_CONFIRMATION"
    | "NEEDS_ACKNOWLEDGEMENT";
  level: Level;
  digest: string;
};
export type SigningGate = SigningEnvelope | Refusal;

const PATH = /^[a-z0-9][a-z0-9,._-]{0,63}$/;
export function prepareSigningEnvelope(
  verdict: Verdict,
  input: {
    predecessor: string;
    path: string;
    payloadHash: string;
    network?: SignerNetwork;
    /** The user explicitly acknowledged a CAUTION verdict. */
    acknowledged?: boolean;
    /** A human explicitly confirmed a HOLD verdict. */
    confirmedByHuman?: boolean;
  },
): SigningGate {
  if (!/^[0-9a-f]{64}$/.test(input.payloadHash)) throw Error("PAYLOAD_HASH");
  if (!PATH.test(input.path)) throw Error("DERIVATION_PATH");
  const refusal = (state: Refusal["state"]): Refusal => ({
    state,
    level: verdict.level,
    digest: verdict.digest,
  });
  if (
    verdict.level === "BLOCK" ||
    verdict.findings.some((f) => NON_OVERRIDABLE.includes(f.code))
  )
    return refusal("REFUSED_BY_GUARDIAN");
  if (verdict.level === "HOLD" && input.confirmedByHuman !== true)
    return refusal("NEEDS_HUMAN_CONFIRMATION");
  if (verdict.level === "CAUTION" && input.acknowledged !== true)
    return refusal("NEEDS_ACKNOWLEDGEMENT");
  const network = input.network ?? "testnet";
  return {
    state: "PREPARED_NOT_SUBMITTED",
    network,
    predecessor: input.predecessor,
    receiverId: MPC_SIGNER[network],
    methodName: "sign",
    args: {
      request: {
        path: input.path,
        payload_v2: { Ecdsa: input.payloadHash },
        domain_id: 0,
      },
    },
    deposit: "1",
    gas: "250000000000000",
    guardian: {
      policy: verdict.policy,
      level: verdict.level,
      digest: verdict.digest,
    },
  };
}
