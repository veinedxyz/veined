import {
  decodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  hexToString,
  keccak256,
  toHex,
  type Hex,
} from "viem";
import { z } from "zod";
import { sanitizeText, suspiciousText } from "../core/sanitize";
export const TRANSFER_TOPIC = keccak256(
  toHex("Transfer(address,address,uint256)"),
);
export const SELECTORS = {
  balanceOf: "0x70a08231",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  aggregate3: "0x82ad56cb",
} as const;
// Multicall3 is used only at a per-chain verified runtime code hash; see multicall.ts.
export const multicall3Abi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;
const hex32 = /^0x[0-9a-fA-F]{64}$/;
const addressHex = /^0x[0-9a-fA-F]{40}$/;
const quantity = /^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/;
export const rawLogSchema = z
  .object({
    address: z.string().regex(addressHex),
    topics: z.array(z.string().regex(hex32)).max(4),
    data: z.string().regex(/^0x([0-9a-fA-F]{2}){0,4096}$/),
    blockNumber: z.string().regex(quantity),
    blockHash: z.string().regex(hex32),
    transactionHash: z.string().regex(hex32),
    logIndex: z.string().regex(quantity),
    removed: z.boolean().optional(),
  })
  .passthrough();
export interface TransferRow {
  chainId: string;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  token: string;
  from: string;
  to: string;
  value: bigint;
}
const topicAddress = (topic: string) =>
  /^0x0{24}[0-9a-fA-F]{40}$/.test(topic)
    ? `0x${topic.slice(26).toLowerCase()}`
    : null;
// Strict ERC20 Transfer decoding. ERC721 (4 topics), removed logs and malformed data are rejected.
export function decodeTransfer(
  raw: unknown,
  chainId: string,
): { ok: true; row: TransferRow } | { ok: false; reason: string } {
  const parsed = rawLogSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "MALFORMED_LOG" };
  const log = parsed.data;
  if (log.removed) return { ok: false, reason: "REMOVED_LOG" };
  if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC)
    return { ok: false, reason: "WRONG_TOPIC" };
  if (log.topics.length !== 3) return { ok: false, reason: "NOT_ERC20_SHAPE" };
  if (log.data.length !== 66) return { ok: false, reason: "BAD_DATA_SIZE" };
  const from = topicAddress(log.topics[1]),
    to = topicAddress(log.topics[2]);
  if (!from || !to) return { ok: false, reason: "BAD_TOPIC_ADDRESS" };
  const logIndex = Number(BigInt(log.logIndex));
  if (!Number.isSafeInteger(logIndex) || logIndex > 1000000)
    return { ok: false, reason: "BAD_LOG_INDEX" };
  return {
    ok: true,
    row: {
      chainId,
      blockNumber: BigInt(log.blockNumber),
      blockHash: log.blockHash.toLowerCase(),
      txHash: log.transactionHash.toLowerCase(),
      logIndex,
      token: log.address.toLowerCase(),
      from,
      to,
      value: BigInt(log.data),
    },
  };
}
export const walletTopic = (wallet: string) =>
  `0x${"0".repeat(24)}${wallet.slice(2).toLowerCase()}`;
export function balanceOfData(wallet: string): Hex {
  return `${SELECTORS.balanceOf}${walletTopic(wallet).slice(2)}` as Hex;
}
export function decodeUint256(data: unknown): bigint | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data))
    return null;
  return BigInt(data);
}
export function decodeDecimals(data: unknown): number | null {
  const value = decodeUint256(data);
  return value !== null && value <= 36n ? Number(value) : null;
}
// symbol()/name() may be ABI string or legacy bytes32. Bounded, sanitized, never executable.
export function decodeMetadataString(
  data: unknown,
  limit: number,
): string | null {
  if (typeof data !== "string" || !/^0x([0-9a-fA-F]{2}){32,1024}$/.test(data))
    return null;
  try {
    if (data.length === 66) {
      const text = hexToString(data as Hex).replace(/\u0000+$/g, "");
      return sanitizeText(text, limit) || null;
    }
    const [text] = decodeAbiParameters([{ type: "string" }], data as Hex);
    return sanitizeText(text, limit) || null;
  } catch {
    return null;
  }
}
export function tokenMetadataFlags(symbol: string | null, name: string | null) {
  return {
    suspicious: !symbol || suspiciousText(symbol ?? "", name ?? ""),
  };
}
export interface InnerCall {
  target: string;
  callData: Hex;
}
export function encodeAggregate3(calls: InnerCall[]): Hex {
  return encodeFunctionData({
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [
      calls.map((c) => ({
        target: c.target as Hex,
        allowFailure: true,
        callData: c.callData,
      })),
    ],
  });
}
export function decodeAggregate3Calls(data: Hex) {
  const decoded = decodeFunctionData({ abi: multicall3Abi, data });
  if (decoded.functionName !== "aggregate3") throw Error("NOT_AGGREGATE3");
  return decoded.args[0];
}
export function decodeAggregate3Result(
  data: unknown,
  expected: number,
): { success: boolean; returnData: Hex }[] | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data)) return null;
  try {
    const rows = decodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      data: data as Hex,
    });
    return rows.length === expected ? [...rows] : null;
  } catch {
    return null;
  }
}
