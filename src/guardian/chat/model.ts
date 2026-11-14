// VEINED Guardian chat: shared, browser-safe model of the conversational assistant. The assistant is a deterministic
// engine (no language model, no paid inference, no keys): words map to typed slots, slots become a structured draft,
// and every draft is reviewed by Guardian's existing policy on the server. The engine is never the authority for a
// financial decision and never produces anything executable.
import { z } from "zod";
import type { Level, Verdict } from "../model";

/** Networks chat drafts cover. `intents` names the NEAR Intents blockchain of the network's native asset. */
export const CHAT_CHAINS = Object.freeze({
  ethereum: {
    id: "1",
    name: "Ethereum",
    native: "ETH",
    swap: true,
    bridge: true,
    intents: "eth",
  },
  base: {
    id: "8453",
    name: "Base",
    native: "ETH",
    swap: true,
    bridge: true,
    intents: "base",
  },
  bsc: {
    id: "56",
    name: "BNB Chain",
    native: "BNB",
    swap: true,
    bridge: true,
    intents: null,
  },
  arbitrum: {
    id: "42161",
    name: "Arbitrum",
    native: "ETH",
    swap: false,
    bridge: true,
    intents: "arb",
  },
  optimism: {
    id: "10",
    name: "Optimism",
    native: "ETH",
    swap: false,
    bridge: true,
    intents: null,
  },
  polygon: {
    id: "137",
    name: "Polygon",
    native: "POL",
    swap: false,
    bridge: true,
    intents: null,
  },
  avalanche: {
    id: "43114",
    name: "Avalanche",
    native: "AVAX",
    swap: false,
    bridge: true,
    intents: null,
  },
  near: {
    id: "near",
    name: "NEAR",
    native: "NEAR",
    swap: false,
    bridge: false,
    intents: "near",
  },
} as const);
export type ChainKey = keyof typeof CHAT_CHAINS;
export const CHAIN_KEYS = Object.keys(CHAT_CHAINS) as ChainKey[];
export const chainName = (k: ChainKey) => CHAT_CHAINS[k].name;

export const DRAFT_KINDS = ["swap", "bridge", "near"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

// Chat-draft escalation policy (frozen; owner-adjustable only by a reviewed change). A draft prepared in conversation
// whose amount reaches the limit of its asset class is ESCALATED (Guardian WARNING → HOLD): the user must verify the
// amount before opening it. Limits apply only to assets whose identity Guardian trusts (native, canonical, curated).
export const CHAT_DRAFT_POLICY = Object.freeze({
  id: "chat-draft",
  version: "c1.2026-11",
  /** Draft lifetime: a draft is short-lived and is never reused after this. */
  draftTtlMs: 10 * 60_000,
  /** Explicit dry quotes per conversation (NEAR Intents, read-only). */
  quoteBudget: 3,
  /** Draft reviews per conversation in a rolling window (no loops, no polling). */
  reviewBudget: { count: 12, windowMs: 5 * 60_000 },
  limits: [
    {
      group: "USD",
      symbols: [
        "USDC",
        "USDT",
        "DAI",
        "USDBC",
        "AXLUSDC",
        "USDC.E",
        "USDT.E",
        "BUSD",
      ],
      limit: "10000",
    },
    { group: "ETH", symbols: ["ETH", "WETH"], limit: "5" },
    { group: "BTC", symbols: ["WBTC", "BTCB", "BTC", "WBTC.E"], limit: "0.25" },
    { group: "BNB", symbols: ["BNB", "WBNB"], limit: "25" },
    { group: "POL", symbols: ["POL", "WMATIC", "MATIC"], limit: "25000" },
    { group: "AVAX", symbols: ["AVAX", "WAVAX"], limit: "500" },
    { group: "SOL", symbols: ["SOL"], limit: "100" },
    { group: "NEAR", symbols: ["NEAR", "WNEAR"], limit: "5000" },
  ],
});

export type Decision = "ALLOW" | "WARN" | "ESCALATE" | "BLOCK";
/** Guardian levels and the decisions they mean (the same ladder as the Agent Gate). */
export const decisionOf = (level: Level): Decision =>
  level === "BLOCK"
    ? "BLOCK"
    : level === "HOLD"
      ? "ESCALATE"
      : level === "CAUTION"
        ? "WARN"
        : "ALLOW";

// ---- Wire schema of a draft review request (client → /api/guardian, action "chat-draft"). Strict: a client can
// never send a verdict, a level, a decision or any extra field; everything is re-derived on the server. ----
const symbol = z.string().regex(/^[A-Za-z0-9.$]{1,16}$/);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const tokenRef = z
  .object({ symbol: symbol.optional(), address: evmAddress.optional() })
  .strict()
  .refine((t) => !!t.symbol || !!t.address, "TOKEN_REQUIRED");
const decimal = z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,18})?$/);
const chainKey = z.enum(CHAIN_KEYS as [ChainKey, ...ChainKey[]]);
export const chatDraftRequestSchema = z
  .object({
    kind: z.enum(DRAFT_KINDS),
    source: chainKey,
    destination: chainKey,
    pay: tokenRef,
    receive: tokenRef,
    amount: decimal,
    recipient: z.string().min(2).max(128).optional(),
    sender: z.string().min(2).max(128).optional(),
    /** The pay token balance the user's own Portfolio scan read (display units). Can only add a finding. */
    balance: z
      .string()
      .regex(/^(0|[1-9]\d{0,29})(\.\d{1,18})?$/)
      .optional(),
  })
  .strict();
export type ChatDraftRequest = z.infer<typeof chatDraftRequestSchema>;

export const chatTokenRequestSchema = z
  .object({
    chain: chainKey,
    token: tokenRef,
  })
  .strict();
export type ChatTokenRequest = z.infer<typeof chatTokenRequestSchema>;

export interface ResolvedToken {
  chainId: string;
  address: string;
  symbol: string;
  name: string | null;
  /** null: the contract is not in VEINED's registry, so its decimals are not known without a lookup. */
  decimals: number | null;
  native: boolean;
  /** Registry evidence level of the exact contract; null when the registry has no entry. */
  level: string | null;
  /** NEAR Intents asset id (route-to-NEAR drafts only). */
  assetId?: string;
}
export interface TokenOption {
  symbol: string;
  name: string | null;
  address: string;
  level: string;
}
export type NeedReason = "AMBIGUOUS" | "UNKNOWN_SYMBOL" | "AMOUNT_PRECISION";
export interface DraftNeed {
  slot: "pay" | "receive" | "amount";
  reason: NeedReason;
  symbol?: string;
  chain: ChainKey;
  options: TokenOption[];
}
export interface ChatDraft {
  id: string;
  kind: DraftKind;
  source: ChainKey;
  destination: ChainKey;
  pay: ResolvedToken;
  receive: ResolvedToken;
  /** Display units as the user typed them (normalized). */
  amount: string;
  /** Smallest units, when the pay token's decimals are known. */
  rawAmount: string | null;
  recipient: string | null;
  sender: string | null;
  /** Always false: a chat draft carries no signing, approval or sending capability. */
  executable: false;
}
export type ChatDraftResult =
  | { state: "NEEDS"; needs: DraftNeed[] }
  | { state: "UNSUPPORTED"; reason: UnsupportedReason }
  | {
      state: "DRAFT";
      draft: ChatDraft;
      verdict: Verdict;
      decision: Decision;
      policy: string;
    };
export type UnsupportedReason =
  | "SWAP_CHAIN"
  | "BRIDGE_CHAIN"
  | "SAME_CHAIN"
  | "INTENTS_ORIGIN"
  | "INTENTS_ASSET"
  | "TOKEN_ON_NEAR";
export interface ChatTokenResult {
  token: ResolvedToken | null;
  needs?: DraftNeed;
  verdict?: Verdict;
}

/** Decimal string → smallest units (exact; no floating point). null when it has more places than the token. */
export function toUnits(amount: string, decimals: number): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!m) return null;
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > decimals) return null;
  return BigInt(m[1] + frac.padEnd(decimals, "0"));
}
/** Exact comparison of two non-negative decimal strings. */
export function compareDecimal(a: string, b: string): number {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const n = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(n, "0")),
    y = BigInt(bi + bf.padEnd(n, "0"));
  return x < y ? -1 : x > y ? 1 : 0;
}
export function draftLimit(symbol: string) {
  const s = symbol.toUpperCase();
  return CHAT_DRAFT_POLICY.limits.find((l) =>
    (l.symbols as readonly string[]).includes(s),
  );
}
