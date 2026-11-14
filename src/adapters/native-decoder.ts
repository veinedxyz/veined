import { decodeEventLog, decodeFunctionData, erc20Abi, type Hex } from "viem";
import { z } from "zod";
import {
  BridgeError,
  CROSS,
  NATIVE,
  addressSchema,
  hashSchema,
  sameAddress,
  type TransferRecord,
} from "../core/model";
import {
  type ReceiptEvidence,
  type SourceEvidence,
  type DestinationEvidence,
  type PayoutEvidence,
} from "../core/flow";
import { nativeReadAbi } from "./native-abi";
import { bridgeAbi } from "./onebridge";
import { READ_ONLY_DEPLOYMENT as deployment } from "./deployment";

export const quantitySchema = z
  .string()
  .regex(/^0x(?:0|[1-9a-f][0-9a-f]*)$/i)
  .max(66);
const dataSchema = z
  .string()
  .regex(/^0x(?:[0-9a-f]{2})*$/i)
  .max(32770);
export const blockSchema = z
  .object({
    number: quantitySchema,
    hash: hashSchema,
    timestamp: quantitySchema,
  })
  .passthrough();
export const logSchema = z
  .object({
    address: addressSchema,
    data: dataSchema,
    topics: z.array(hashSchema).min(1).max(4),
    transactionHash: hashSchema,
    blockHash: hashSchema,
    blockNumber: quantitySchema,
    logIndex: quantitySchema,
    removed: z.literal(false),
  })
  .passthrough();
export const receiptSchema = z
  .object({
    transactionHash: hashSchema,
    blockHash: hashSchema,
    blockNumber: quantitySchema,
    status: z.enum(["0x0", "0x1"]),
    from: addressSchema,
    to: addressSchema,
    logs: z.array(logSchema).max(2048),
  })
  .passthrough();
export const transactionSchema = z
  .object({
    hash: hashSchema,
    from: addressSchema,
    to: addressSchema,
    input: dataSchema,
    value: quantitySchema,
    blockHash: hashSchema,
    blockNumber: quantitySchema,
    chainId: quantitySchema,
  })
  .passthrough();
export interface ReceiptRead {
  receipt: unknown;
  transaction: unknown;
  block: unknown;
  finalized: unknown;
  chainId: number;
}
export function safeBlock(value: string) {
  const n = Number(BigInt(quantitySchema.parse(value)));
  if (!Number.isSafeInteger(n) || n < 0) throw new BridgeError("INVALID_BLOCK");
  return n;
}
function identity(read: ReceiptRead, contract: string) {
  const receipt = receiptSchema.parse(read.receipt);
  const transaction = transactionSchema.parse(read.transaction);
  const block = blockSchema.parse(read.block);
  const finalized = blockSchema.parse(read.finalized);
  if (
    receipt.transactionHash !== transaction.hash ||
    receipt.blockHash !== transaction.blockHash ||
    receipt.blockNumber !== transaction.blockNumber ||
    receipt.blockNumber !== block.number ||
    !sameAddress(receipt.from, transaction.from) ||
    !sameAddress(receipt.to, transaction.to) ||
    !sameAddress(transaction.to, contract) ||
    BigInt(transaction.chainId) !== BigInt(read.chainId)
  )
    throw new BridgeError("UNRELATED_RECEIPT");
  const indices = new Set<number>();
  for (const log of receipt.logs) {
    if (
      log.transactionHash !== receipt.transactionHash ||
      log.blockHash !== receipt.blockHash ||
      log.blockNumber !== receipt.blockNumber ||
      indices.has(safeBlock(log.logIndex))
    )
      throw new BridgeError("UNRELATED_LOG");
    indices.add(safeBlock(log.logIndex));
    safeBlock(log.logIndex);
  }
  const blockNumber = safeBlock(receipt.blockNumber);
  const finalizedBlockNumber = safeBlock(finalized.number);
  const evidence: ReceiptEvidence = {
    chain: read.chainId,
    contract,
    hash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    canonicalBlockHash: block.hash,
    blockNumber,
    finalizedBlockNumber,
    confirmations: Math.max(0, finalizedBlockNumber - blockNumber + 1),
    successful: receipt.status === "0x1",
    txFrom: transaction.from,
    txTo: transaction.to,
  };
  return { receipt, transaction, evidence };
}
function decode(log: z.infer<typeof logSchema>, token = false) {
  try {
    return decodeEventLog({
      abi: token ? erc20Abi : nativeReadAbi,
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
  } catch {
    return undefined;
  }
}
export function decodeNativeSource(
  claim: TransferRecord,
  read: ReceiptRead,
): SourceEvidence {
  if (read.chainId !== 612055) throw new BridgeError("CHAIN_MISMATCH");
  const { receipt, transaction, evidence } = identity(read, deployment.source);
  const call = decodeFunctionData({
    abi: bridgeAbi,
    data: transaction.input as Hex,
  });
  if (
    evidence.hash !== claim.sourceHash ||
    !sameAddress(transaction.from, claim.account) ||
    call.functionName !== "bridgeToken" ||
    call.args[0] !== 56n ||
    !sameAddress(call.args[1], NATIVE) ||
    !sameAddress(call.args[2], claim.recipient) ||
    call.args[3].toString() !== claim.amount ||
    call.args[6] !== "0x"
  )
    throw new BridgeError("UNRELATED_SOURCE_INTENT");
  if (!evidence.successful) return evidence;
  if (BigInt(transaction.value) !== call.args[3] + call.args[4] + call.args[5])
    throw new BridgeError("NATIVE_VALUE_MISMATCH");
  const matches = receipt.logs
    .filter((log) => sameAddress(log.address, deployment.source))
    .map((log) => ({ log, event: decode(log) }))
    .filter((item) => item.event?.eventName === "BridgeInitiated");
  if (matches.length !== 1) throw new BridgeError("AMBIGUOUS_SOURCE_EVENT");
  const { log, event } = matches[0];
  if (!event || event.eventName !== "BridgeInitiated")
    throw new BridgeError("SOURCE_EVENT_REQUIRED");
  const a = event.args;
  if (
    a.toChainID !== 56n ||
    !sameAddress(a.fromToken, NATIVE) ||
    !sameAddress(a.toToken, CROSS) ||
    !sameAddress(a.from, claim.account) ||
    !sameAddress(a.to, claim.recipient) ||
    a.value.toString() !== claim.amount ||
    a.networkFee !== call.args[4] ||
    a.exFee !== call.args[5] ||
    a.extraData !== "0x" ||
    (claim.index !== undefined && a.index.toString() !== claim.index)
  )
    throw new BridgeError("UNRELATED_SOURCE_EVENT");
  return {
    ...evidence,
    index: a.index.toString(),
    sender: a.from,
    recipient: a.to,
    token: a.fromToken,
    amount: a.value.toString(),
    destinationChain: 56,
    eventLogIndex: safeBlock(log.logIndex),
  };
}
export function decodeNativeDestination(
  claim: TransferRecord,
  source: SourceEvidence,
  read: ReceiptRead,
): DestinationEvidence {
  if (read.chainId !== 56 || !source.index)
    throw new BridgeError("CHAIN_MISMATCH");
  const { receipt, evidence } = identity(read, deployment.destination);
  const events = receipt.logs
    .filter((log) => sameAddress(log.address, deployment.destination))
    .map((log) => ({ log, event: decode(log) }))
    .filter(
      (item) =>
        item.event?.eventName === "BridgeFinalized" ||
        item.event?.eventName === "BridgePending",
    )
    .sort((a, b) => safeBlock(a.log.logIndex) - safeBlock(b.log.logIndex));
  const related = events.filter(
    ({ event }) =>
      event &&
      (event.eventName === "BridgeFinalized" ||
        event.eventName === "BridgePending") &&
      event.args.fromChainID === 612055n &&
      event.args.index.toString() === source.index,
  );
  if (related.length !== 1)
    throw new BridgeError("AMBIGUOUS_DESTINATION_EVENT");
  const { log, event } = related[0];
  if (
    !event ||
    (event.eventName !== "BridgeFinalized" &&
      event.eventName !== "BridgePending")
  )
    throw new BridgeError("DESTINATION_EVENT_REQUIRED");
  const a = event.args;
  if (
    !sameAddress(a.toToken, CROSS) ||
    !sameAddress(a.to, claim.recipient) ||
    a.value.toString() !== claim.expected
  )
    throw new BridgeError("UNRELATED_DESTINATION_EVENT");
  const eventLogIndex = safeBlock(log.logIndex);
  let payout: PayoutEvidence | false = false;
  if (event.eventName === "BridgeFinalized") {
    // BaseBridge transfers first, then emits its terminal event. Each terminal event
    // closes its own log interval, so equal-value batch items cannot reuse a payout.
    const position = events.indexOf(related[0]);
    const previous =
      position === 0 ? -1 : safeBlock(events[position - 1].log.logIndex);
    const transfers = receipt.logs
      .filter(
        (item) =>
          sameAddress(item.address, CROSS) &&
          safeBlock(item.logIndex) > previous &&
          safeBlock(item.logIndex) < eventLogIndex,
      )
      .map((item) => ({ log: item, event: decode(item, true) }))
      .filter(
        (item) =>
          item.event?.eventName === "Transfer" &&
          sameAddress(item.event.args.from, deployment.destination) &&
          sameAddress(item.event.args.to, claim.recipient) &&
          item.event.args.value.toString() === claim.expected,
      );
    if (transfers.length !== 1)
      throw new BridgeError("AMBIGUOUS_OR_MISSING_PAYOUT");
    payout = {
      chain: 56,
      transactionHash: evidence.hash,
      blockHash: evidence.blockHash,
      logIndex: safeBlock(transfers[0].log.logIndex),
      token: CROSS,
      from: deployment.destination,
      recipient: a.to,
      amount: a.value.toString(),
      transferIndex: source.index,
    };
  }
  return {
    ...evidence,
    sourceChain: 612055,
    index: source.index,
    recipient: a.to,
    token: a.toToken,
    amount: a.value.toString(),
    held: event.eventName === "BridgePending",
    eventLogIndex,
    payout,
  };
}
