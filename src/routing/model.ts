import { z } from "zod";
// otherbridge-data: portfolio-only descriptor for a catalog chain outside routing; never routable.
export type ProviderId =
  "routing-core" | "otherbridge-onebridge" | "otherbridge-data";
export type Ecosystem = "EVM" | "SVM" | "UTXO" | "MVM" | "TVM" | "STL";
export interface ThemeTokens {
  logo: string;
  primary: string;
  accent: string;
  glow: string;
  badgeDark: string;
  badgeLight: string;
  logoSurface: string;
  provenance: string;
}
export interface Asset {
  chainId: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}
export interface Network {
  id: string;
  key: string;
  name: string;
  ecosystem: Ecosystem;
  mainnet: boolean;
  nativeAsset: Asset;
  provider: ProviderId;
  theme: ThemeTokens;
}
export interface Tool {
  id: string;
  name: string;
  kind: "bridge" | "exchange";
}
export interface Catalog {
  networks: Network[];
  tools: Tool[];
  generation: string;
  observedAt: number;
  stale: boolean;
  error?: string;
}
export interface Connection {
  from: string;
  to: string;
  sourceAssets: Asset[];
  destinationAssets: Asset[];
  provider: ProviderId;
  executable: false;
}
export const quoteInputSchema = z
  .object({
    source: z.string().regex(/^\d{1,18}$/),
    destination: z.string().regex(/^\d{1,18}$/),
    sourceAsset: z.string().min(1).max(128),
    destinationAsset: z.string().min(1).max(128),
    amount: z.string().regex(/^[1-9]\d{0,77}$/),
    sourceAddress: z.string().min(1).max(128),
    destinationAddress: z.string().min(1).max(128),
    generation: z.string().min(1).max(80),
    slippage: z.number().min(0.001).max(0.03),
    preference: z.enum(["receive", "time"]),
    walletRevision: z.number().int().nonnegative(),
    mode: z.enum(["bridge", "swap"]).optional(),
    portfolioRevision: z.string().max(100).optional(),
  })
  .strict();
export type QuoteInput = z.infer<typeof quoteInputSchema>;
export interface Fee {
  name: string;
  amount: string;
  usd?: string;
  asset: Asset;
  included: boolean;
  kind: "gas" | "fee";
}
export interface RouteStep {
  id: string;
  tool: string;
  toolName: string;
  catalogBound: boolean;
  type: string;
  sourceAsset: Asset;
  destinationAsset: Asset;
  amount: string;
  expected: string;
  minimum: string;
  duration: number;
  approvalAddress?: string;
  destinationSignature: boolean;
}
export interface ExecutionRequirement {
  approvals: number;
  signatures: number | null;
  chainSwitches: number | null;
  destinationSignature: boolean;
  balance: "UNVERIFIED";
  allowance: "UNVERIFIED";
  reason: "WRITE_DISABLED";
}
export interface RoutingQuote {
  id: string;
  provider: ProviderId;
  binding: string;
  input: QuoteInput;
  observedAt: number;
  expiresAt: number;
  steps: RouteStep[];
  fees: Fee[];
  expected: string;
  minimum: string;
  duration: number;
  priceImpact: number | null;
  outputUsd?: string;
  platformFee?: { bps: 0; amount: "0"; policy: "v13-disabled" };
  requirements: ExecutionRequirement;
  executable: false;
  warnings: string[];
}
export interface RouteStatus {
  status:
    "PENDING" | "COMPLETED" | "PARTIAL" | "REFUNDED" | "FAILED" | "UNKNOWN";
  observedAt: number;
  provider: ProviderId;
  authoritative: boolean;
  sourceHash?: string;
  destinationHash?: string;
}
export interface StatusInput {
  source: string;
  destination: string;
  hash: string;
  context?: QuoteInput & { minimum: string };
}
export type RoutingRoute = Pick<
  RoutingQuote,
  | "id"
  | "provider"
  | "input"
  | "steps"
  | "fees"
  | "requirements"
  | "observedAt"
  | "expiresAt"
>;
export interface NetworkCatalogProvider {
  listNetworks(signal?: AbortSignal): Promise<Catalog>;
  getNetwork(id: string, signal?: AbortSignal): Promise<Network | undefined>;
}
export interface RouteProvider {
  id: ProviderId;
  capabilities: { quote: boolean; status: boolean; execution: false };
  getConnections(
    source: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<Connection[]>;
  getQuotes(input: QuoteInput, signal?: AbortSignal): Promise<RoutingQuote[]>;
  getStatus(input: StatusInput, signal?: AbortSignal): Promise<RouteStatus>;
}
export class RoutingError extends Error {
  constructor(
    public code: string,
    public httpStatus?: number,
  ) {
    super(code);
    this.name = "RoutingError";
  }
}
export const executionGate = Object.freeze({
  enabled: false as const,
  sign: null,
  approve: null,
  broadcast: null,
  deploy: null,
});
export function requestExecution(): never {
  throw new RoutingError("WRITE_DISABLED");
}
export function quoteBinding(input: QuoteInput): string {
  // Fixed order, including wallet identity revision. Native case is significant.
  return JSON.stringify([
    "routing-core",
    input.source,
    input.destination,
    input.sourceAsset,
    input.destinationAsset,
    input.amount,
    input.sourceAddress,
    input.destinationAddress,
    input.generation,
    input.slippage,
    input.preference,
    input.walletRevision,
    input.mode ?? "bridge",
    input.portfolioRevision ?? "",
  ]);
}
export function reviewValid(
  quote: RoutingQuote,
  input: QuoteInput,
  catalog: Catalog,
  now: number,
) {
  return (
    !catalog.stale &&
    now - catalog.observedAt < 300000 &&
    quote.binding === quoteBinding(input) &&
    quote.input.generation === catalog.generation &&
    now >= quote.observedAt &&
    now < quote.expiresAt &&
    quote.steps.every((s) =>
      s.catalogBound
        ? catalog.tools.some((t) => t.id === s.tool)
        : s.type === "protocol" && s.tool === "feeCollection",
    )
  );
}
export function compareQuotes(
  quotes: RoutingQuote[],
  by: "receive" | "confirmations",
) {
  return [...quotes].sort((a, b) =>
    by === "receive"
      ? BigInt(a.expected) > BigInt(b.expected)
        ? -1
        : BigInt(a.expected) < BigInt(b.expected)
          ? 1
          : 0
      : (a.requirements.signatures ?? Infinity) -
        (b.requirements.signatures ?? Infinity),
  );
}
