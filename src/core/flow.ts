import {
  BridgeError,
  type State,
  type TransferRecord,
  sameAddress,
  addressSchema,
  hashSchema,
  unitsSchema,
  recordSchema,
  NATIVE,
} from "./model";
import { z } from "zod";
const transitions: Partial<Record<State, State[]>> = {
  DRAFT: ["QUOTING"],
  QUOTING: ["PREFLIGHT", "PROVIDER_UNAVAILABLE"],
  PREFLIGHT: ["READY_FOR_REVIEW", "UNSUPPORTED_ROUTE"],
  READY_FOR_REVIEW: ["AWAITING_WALLET", "QUOTE_EXPIRED"],
  AWAITING_WALLET: ["SOURCE_SUBMITTED", "SUBMISSION_UNKNOWN", "USER_REJECTED"],
  SOURCE_SUBMITTED: ["SOURCE_CONFIRMING", "SOURCE_REVERTED"],
  SOURCE_CONFIRMING: [
    "SOURCE_CONFIRMED",
    "SOURCE_REVERTED",
    "SOURCE_REPLACED",
    "SOURCE_CANCELLED",
  ],
  SOURCE_CONFIRMED: ["SETTLEMENT_PENDING"],
  SETTLEMENT_PENDING: [
    "DESTINATION_CONFIRMING",
    "HELD_FOR_REVIEW",
    "UNVERIFIED_COMPLETION",
  ],
  HELD_FOR_REVIEW: ["DESTINATION_CONFIRMING"],
  DESTINATION_CONFIRMING: ["COMPLETED", "SETTLEMENT_PENDING"],
  COMPLETED: ["UNVERIFIED_COMPLETION"],
};
export function transition(current: State, next: State): State {
  if (!transitions[current]?.includes(next))
    throw new BridgeError("INVALID_TRANSITION");
  return next;
}
export interface ReceiptEvidence {
  chain: number;
  contract: string;
  hash: string;
  blockHash: string;
  canonicalBlockHash: string;
  successful: boolean;
  confirmations: number;
  blockNumber: number;
  txFrom: string;
  txTo: string;
  finalizedBlockNumber?: number;
}
export interface SourceEvidence extends ReceiptEvidence {
  // A reverted receipt has no event. Its transaction identity is checked separately.
  index?: string;
  recipient?: string;
  amount?: string;
  destinationChain?: number;
  sender?: string;
  token?: string;
  eventLogIndex?: number;
}
export interface PayoutEvidence {
  chain: number;
  transactionHash: string;
  blockHash: string;
  logIndex: number;
  token: string;
  from: string;
  recipient: string;
  amount: string;
  transferIndex: string;
}
export interface DestinationEvidence extends ReceiptEvidence {
  sourceChain: number;
  index: string;
  recipient: string;
  token: string;
  amount: string;
  // Legacy booleans are deliberately not accepted as payment evidence.
  payout: boolean | PayoutEvidence;
  held: boolean;
  eventLogIndex: number;
}
export interface SettlementPolicy {
  sourceContract: string;
  destinationContract: string;
  sourceConfirmations: number;
  destinationConfirmations: number;
  finality?: "node-finalized";
}
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveUnits = unitsSchema.refine((v) => BigInt(v) > 0n);
const receiptSchema = z.object({
  chain: safeInteger.positive(),
  contract: addressSchema,
  hash: hashSchema,
  blockHash: hashSchema,
  canonicalBlockHash: hashSchema,
  blockNumber: safeInteger,
  successful: z.boolean(),
  confirmations: safeInteger,
  txFrom: addressSchema,
  txTo: addressSchema,
});
const sourceEventSchema = z.object({
  index: unitsSchema,
  recipient: addressSchema,
  amount: positiveUnits,
  destinationChain: safeInteger.positive(),
  sender: addressSchema,
  token: addressSchema,
  eventLogIndex: safeInteger,
});
const destinationEventSchema = z.object({
  sourceChain: safeInteger.positive(),
  index: unitsSchema,
  recipient: addressSchema,
  token: addressSchema,
  amount: positiveUnits,
  held: z.boolean(),
  eventLogIndex: safeInteger,
});
const payoutSchema = z.object({
  chain: safeInteger.positive(),
  transactionHash: hashSchema,
  blockHash: hashSchema,
  logIndex: safeInteger,
  token: addressSchema,
  from: addressSchema,
  recipient: addressSchema,
  amount: positiveUnits,
  transferIndex: unitsSchema,
});
const policySchema = z.object({
  sourceContract: addressSchema,
  destinationContract: addressSchema,
  sourceConfirmations: safeInteger.positive(),
  destinationConfirmations: safeInteger.positive(),
  finality: z.literal("node-finalized").optional(),
});
export function verifySettlement(
  record: TransferRecord,
  source: SourceEvidence | undefined,
  destination: DestinationEvidence | undefined,
  policy: SettlementPolicy,
  payoutOwners?: ReadonlyMap<string, string>,
): State {
  if (
    !recordSchema.safeParse(record).success ||
    !policySchema.safeParse(policy).success
  )
    return "UNVERIFIED_COMPLETION";
  if (!source) return "TRACKING_UNAVAILABLE";
  if (!receiptSchema.safeParse(source).success) return "UNVERIFIED_COMPLETION";
  if (
    policy.finality === "node-finalized" &&
    (!safeInteger.safeParse(source.finalizedBlockNumber).success ||
      source.confirmations !==
        Math.max(0, source.finalizedBlockNumber! - source.blockNumber + 1))
  )
    return "UNVERIFIED_COMPLETION";
  if (
    source.chain !== record.sourceChain ||
    !sameAddress(source.contract, policy.sourceContract) ||
    source.hash !== record.sourceHash ||
    source.blockHash !== source.canonicalBlockHash ||
    !sameAddress(source.txFrom, record.account) ||
    !sameAddress(source.txTo, policy.sourceContract)
  )
    return "UNVERIFIED_COMPLETION";
  if (source.confirmations < policy.sourceConfirmations)
    return "SOURCE_CONFIRMING";
  if (!source.successful) return "SOURCE_REVERTED";
  if (
    !sourceEventSchema.safeParse(source).success ||
    source.index !== record.index ||
    source.amount !== record.amount ||
    source.destinationChain !== record.destinationChain ||
    !sameAddress(source.sender!, record.account) ||
    !sameAddress(source.token!, NATIVE) ||
    !sameAddress(source.recipient!, record.recipient)
  )
    return "UNVERIFIED_COMPLETION";
  if (!destination) return "SETTLEMENT_PENDING";
  if (
    !receiptSchema.safeParse(destination).success ||
    !destinationEventSchema.safeParse(destination).success
  )
    return "UNVERIFIED_COMPLETION";
  if (
    policy.finality === "node-finalized" &&
    (!safeInteger.safeParse(destination.finalizedBlockNumber).success ||
      destination.confirmations !==
        Math.max(
          0,
          destination.finalizedBlockNumber! - destination.blockNumber + 1,
        ))
  )
    return "UNVERIFIED_COMPLETION";
  if (
    !destination.successful ||
    destination.chain !== record.destinationChain ||
    !sameAddress(destination.contract, policy.destinationContract) ||
    !sameAddress(destination.txTo, policy.destinationContract) ||
    destination.sourceChain !== record.sourceChain ||
    destination.index !== source.index ||
    !sameAddress(destination.recipient, record.recipient) ||
    !sameAddress(destination.token, record.token) ||
    destination.amount !== record.expected ||
    destination.blockHash !== destination.canonicalBlockHash
  )
    return "UNVERIFIED_COMPLETION";
  if (destination.confirmations < policy.destinationConfirmations)
    return "DESTINATION_CONFIRMING";
  if (destination.held && destination.payout === false)
    return "HELD_FOR_REVIEW";
  const payout = payoutSchema.safeParse(destination.payout);
  if (!payout.success) return "UNVERIFIED_COMPLETION";
  const p = payout.data;
  if (
    p.chain !== record.destinationChain ||
    p.transactionHash !== destination.hash ||
    p.blockHash !== destination.blockHash ||
    p.transferIndex !== source.index ||
    !sameAddress(p.token, record.token) ||
    !sameAddress(p.from, policy.destinationContract) ||
    !sameAddress(p.recipient, record.recipient) ||
    p.amount !== record.expected ||
    p.logIndex === destination.eventLogIndex
  )
    return "UNVERIFIED_COMPLETION";
  const proofId = `${p.chain}:${p.transactionHash}:${p.logIndex}`;
  const owner = payoutOwners?.get(proofId);
  if (
    owner &&
    owner !== `${record.sourceChain}:${record.sourceHash}:${source.index}`
  )
    return "UNVERIFIED_COMPLETION";
  return "COMPLETED";
}
export function classifyReplacement(
  original: {
    from: string;
    chainId: number;
    to: string;
    data: string;
    value: string;
    nonce: number;
  },
  replacement: {
    from: string;
    chainId: number;
    to: string;
    data: string;
    value: string;
    nonce: number;
  },
  account: string,
): State {
  if (
    !addressSchema.safeParse(account).success ||
    !addressSchema.safeParse(original.from).success ||
    !addressSchema.safeParse(replacement.from).success ||
    !sameAddress(original.from, account) ||
    !sameAddress(replacement.from, account) ||
    !safeInteger.positive().safeParse(original.chainId).success ||
    replacement.chainId !== original.chainId ||
    !safeInteger.safeParse(original.nonce).success ||
    !safeInteger.safeParse(replacement.nonce).success
  )
    throw new BridgeError("IDENTITY_CHANGED");
  if (
    ![original, replacement].every(
      (tx) =>
        addressSchema.safeParse(tx.to).success &&
        unitsSchema.safeParse(tx.value).success &&
        typeof tx.data === "string" &&
        /^0x(?:[0-9a-f]{2})*$/i.test(tx.data) &&
        tx.data.length <= 32770,
    )
  )
    throw new BridgeError("INVALID_TRANSACTION");
  if (replacement.nonce !== original.nonce)
    throw new BridgeError("NONCE_MISMATCH");
  if (
    sameAddress(replacement.to, account) &&
    replacement.data === "0x" &&
    replacement.value === "0"
  )
    return "SOURCE_CANCELLED";
  return sameAddress(original.to, replacement.to) &&
    original.data === replacement.data &&
    original.value === replacement.value
    ? "SOURCE_REPLACED"
    : "MANUAL_ACTION_REQUIRED";
}
