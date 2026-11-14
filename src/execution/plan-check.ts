// G13 (review round 3, R7): one strict shape for an execution plan. Every amount is a canonical decimal digit string,
// every time and basis-point value a safe integer, every address well formed — so a malformed plan is refused with a
// code (at QUOTE_READ and at the preflight entry), never thrown on later as a SyntaxError / RangeError. Pure.
import { z } from "zod";

const digits = z.string().regex(/^(0|[1-9]\d{0,77})$/);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.number().int().min(min).max(max);
const asset = z.object({
  chainId: z.string().min(1).max(40),
  address: z.string().min(1).max(200),
  symbol: z.string().max(32),
  decimals: int(0, 77),
  native: z.boolean(),
});
const planSchema = z.object({
  version: z.string().min(1).max(40),
  kind: z.enum(["EVM_SWAP", "EVM_BRIDGE", "NEAR_INTENTS"]),
  provider: z.string().min(1).max(80),
  tool: z.string().max(80),
  quoteId: z.string().min(1).max(200),
  quotedAt: int(0),
  expiresAt: int(0),
  executable: z.boolean(),
  account: evmAddress,
  sourceChainId: z.string().regex(/^\d{1,18}$/),
  destinationChainId: z.string().min(1).max(40),
  pay: asset,
  receive: asset,
  amountIn: digits,
  expectedOut: digits,
  minimumOut: digits,
  recipient: z.string().min(1).max(200),
  refundTo: z.string().min(1).max(200).nullable(),
  slippageBps: int(0, 10000),
  platformFeeBps: int(0, 10000),
  fees: z
    .array(
      z.object({
        name: z.string().max(120),
        amount: digits,
        usd: z.string().max(40).nullable(),
        included: z.boolean(),
        kind: z.enum(["gas", "fee"]),
        asset,
      }),
    )
    .max(32),
  spender: evmAddress.nullable(),
  approval: z
    .object({ token: evmAddress, spender: evmAddress, amount: digits })
    .nullable(),
  transaction: z
    .object({
      chainId: z.string().regex(/^\d{1,18}$/),
      from: evmAddress,
      to: evmAddress,
      value: digits,
      data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
      gas: digits.optional(),
      maxFeePerGas: digits.optional(),
      maxPriorityFeePerGas: digits.optional(),
    })
    .nullable(),
});
const evidence = z.object({
  chainId: z.string(),
  address: z.string(),
  symbol: z.string(),
  decimals: int(0, 77),
  level: z.string().optional(),
  risk: z.array(z.string()).optional(),
});
const factsSchema = z.object({
  now: int(0),
  wallet: z.object({
    account: z.string().nullable(),
    chainId: z.string().nullable(),
    proven: z.boolean(),
  }),
  evidence: z.object({
    pay: evidence.nullable(),
    receive: evidence.nullable(),
  }),
  balances: z.object({
    pay: z.string().nullable(),
    native: z.string().nullable(),
    agreement: z.enum(["AGREE", "DISAGREE", "SINGLE"]).nullable(),
  }),
  allowance: z.string().nullable(),
  allowanceSpender: z.string().nullable(),
  gas: z.object({
    limit: z.string().nullable(),
    maxFeePerGas: z.string().nullable(),
  }),
  inputUsd: z.string().nullable(),
  simulation: z
    .object({
      success: z.boolean(),
      block: z.string(),
      payDelta: z.string(),
      receiveDelta: z.string().nullable(),
      unexpectedOutflows: z.number(),
      allowanceAfter: z.string().nullable(),
    })
    .nullable(),
  guardian: z
    .object({ level: z.string(), digest: z.string(), quoteId: z.string() })
    .nullable(),
  supportedDestinations: z.array(z.string()),
});
/** Null when the server's preflight facts have the expected shape; otherwise "FACTS_INVALID" (round 4, S4). */
export function factsProblem(facts: unknown): "FACTS_INVALID" | null {
  return factsSchema.safeParse(facts).success ? null : "FACTS_INVALID";
}
/** Null when the plan has the strict shape; otherwise "PLAN_INVALID". */
export function planProblem(plan: unknown): "PLAN_INVALID" | null {
  return planSchema.safeParse(plan).success ? null : "PLAN_INVALID";
}
