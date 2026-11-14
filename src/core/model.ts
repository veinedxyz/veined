import { z } from "zod";
// Zod's optional JIT probes eval. Use its supported CSP-compatible interpreter.
z.config({ jitless: true });
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const unitsSchema = z.string().regex(/^(0|[1-9]\d{0,77})$/);
export const modeSchema = z.enum(["local-test", "mainnet-readonly"]);
export type Mode = z.infer<typeof modeSchema>;
export const CROSS = "0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510" as const;
export const NATIVE = "0x0000000000000000000000000000000000000001" as const;
export const ROUTE = {
  id: "one-native-to-bsc-cross",
  version: "1",
  sourceChain: 612055,
  destinationChain: 56,
  sourceAsset: "native:ONE",
  destinationAsset: CROSS,
  decimals: 18,
  provider: "ONEbridge",
  sourceContract: null,
  destinationContract: null,
  abiEvidence: "documented-generic-only",
  deploymentEvidence: "unverified",
  audit: "unknown",
  capabilities: {
    bridge: "unknown",
    requiresSourceGas: "supported",
    gasSponsorship: "unsupported",
    destinationGasTopup: "unsupported",
    swap: "unsupported",
  },
} as const;
export const stateSchema = z.enum([
  "DRAFT",
  "QUOTING",
  "PREFLIGHT",
  "READY_FOR_REVIEW",
  "AWAITING_WALLET",
  "SUBMISSION_UNKNOWN",
  "SOURCE_SUBMITTED",
  "SOURCE_CONFIRMING",
  "SOURCE_CONFIRMED",
  "SETTLEMENT_PENDING",
  "DESTINATION_CONFIRMING",
  "COMPLETED",
  "USER_REJECTED",
  "SOURCE_REVERTED",
  "SOURCE_REPLACED",
  "SOURCE_CANCELLED",
  "PROVIDER_UNAVAILABLE",
  "QUOTE_EXPIRED",
  "HELD_FOR_REVIEW",
  "MANUAL_ACTION_REQUIRED",
  "TRACKING_UNAVAILABLE",
  "UNVERIFIED_COMPLETION",
  "UNSUPPORTED_ROUTE",
]);
export type State = z.infer<typeof stateSchema>;
export const recordSchema = z
  .object({
    schema: z.literal(1),
    id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
    mode: modeSchema,
    route: z.literal(ROUTE.id),
    config: z.literal("1"),
    sourceChain: z.number().int(),
    destinationChain: z.number().int(),
    account: addressSchema,
    recipient: addressSchema,
    sourceAsset: z.literal("native:ONE"),
    token: z.literal(CROSS),
    amount: unitsSchema,
    expected: unitsSchema,
    sourceHash: hashSchema.optional(),
    destinationHash: hashSchema.optional(),
    index: unitsSchema.optional(),
    state: stateSchema,
    updatedAt: z.number().int().positive(),
    observedBlock: unitsSchema.optional(),
    blockHash: hashSchema.optional(),
    error: z
      .string()
      .regex(/^[A-Z0-9_]{1,60}$/)
      .optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const expected = r.mode === "local-test" ? [31337, 31338] : [612055, 56];
    if (
      r.sourceChain !== expected[0] ||
      r.destinationChain !== expected[1] ||
      r.account.toLowerCase() !== r.recipient.toLowerCase() ||
      BigInt(r.amount) <= 0n ||
      BigInt(r.expected) <= 0n
    )
      ctx.addIssue({ code: "custom", message: "Invalid route identity" });
  });
export type TransferRecord = z.infer<typeof recordSchema>;
export interface Quote {
  id: string;
  mode: Mode;
  account: string;
  recipient: string;
  route: string;
  config: string;
  sourceChain: number;
  destinationChain: number;
  token: string;
  amount: bigint;
  networkFee: bigint;
  serviceFee: bigint;
  gasBudget: bigint;
  expected: bigint;
  min: bigint;
  max: bigint;
  expiresAt: number;
  observedAt: number;
}
export interface Health {
  mode: Mode;
  observedAt: number;
  status: "unknown" | "blocked" | "local";
  reasons: string[];
  limits?: {
    minimum: string;
    maximumBound: string;
    conservativeReserveBound: string;
    reserveVerified: boolean;
    paused: boolean;
    sourceBlockHash: string;
    destinationBlockHash: string;
  };
  source?: { chainId: number; block: string; timestamp: string };
  destination?: { chainId: number; block: string; timestamp: string };
  token?: { name: string; symbol: string; decimals: number; code: boolean };
}
export class BridgeError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();
