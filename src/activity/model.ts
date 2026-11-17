import { z } from "zod";
export const activityInput = z
  .object({
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    chainId: z.enum(["8453", "42161"]),
    hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    consent: z.literal(true),
  })
  .strict();
export type ActivityInput = z.infer<typeof activityInput>;
export interface VerifiedTransaction {
  address: string;
  chainId: "8453" | "42161";
  hash: string;
  block: string;
  blockHash: string;
  timestamp: number;
  verifiedAt: number;
  confirmations: string;
  status: "CONFIRMED" | "FAILED";
  kind:
    | "Swap"
    | "Bridge"
    | "Approval"
    | "Destination settlement"
    | "Transfer"
    | "Transaction";
  from: string;
  to: string | null;
  explorer: string;
  operators: string[];
  amounts: {
    symbol: string;
    amount: string;
    direction: "in" | "out" | "permission";
  }[];
  gas?: {
    gasUsed: string;
    effectiveGasPriceWei: string;
    l1FeeWei: string | null;
    totalFeeWei: string | null;
  };
  spender?: string;
  deposit?: {
    id: string;
    origin: string;
    destination: string;
    recipient: string;
    inputAmount: string;
    outputAmount: string;
    inputToken: string;
    outputToken: string;
    depositor: string;
    messageHash: string;
    fillDeadline: number;
    exclusivityDeadline: number;
    exclusiveRelayer: string;
  };
  coverage: "Imported hash only; no indexed history";
}
export function matchingBridge(a: VerifiedTransaction, b: VerifiedTransaction) {
  return (
    a.kind === "Bridge" &&
    b.kind === "Destination settlement" &&
    a.status === "CONFIRMED" &&
    b.status === "CONFIRMED" &&
    a.address === b.address &&
    a.chainId !== b.chainId &&
    !!a.deposit &&
    !!b.deposit &&
    JSON.stringify(a.deposit) === JSON.stringify(b.deposit)
  );
}
