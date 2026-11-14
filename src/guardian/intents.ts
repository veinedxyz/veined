// NEAR Intents (1Click API) as a Guardian-reviewed route toward NEAR. Browser-safe: wire schemas, the facts Guardian
// reads from a dry quote and the rules for it. The server adapter (server/intents.ts) is the only code that talks to
// 1Click. A dry quote creates no deposit address and moves nothing; VEINED never requests a non-dry quote.
import { z } from "zod";
import { displayText, validIdentity } from "./support";
import { GUARDIAN_POLICY, finding, type Finding, type SafeStep } from "./model";
import { knownNearAccount, reviewNearAccount } from "./near";
import { recipientRules, valueLossBps, type RuleResult } from "./rules";

export const INTENTS_ORIGIN = "https://1click.chaindefuser.com";
const assetId = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z0-9_]+:[A-Za-z0-9._:-]+$/);
export const intentsTokenSchema = z
  .object({
    assetId,
    decimals: z.number().int().min(0).max(36),
    blockchain: z.string().min(1).max(24),
    symbol: z.string().min(1).max(32),
    price: z.number().finite().nonnegative().nullable().optional(),
    priceUpdatedAt: z.string().max(40).optional(),
    contractAddress: z.string().max(160).optional(),
  })
  .loose();
export type IntentsToken = z.infer<typeof intentsTokenSchema>;
// The list is read row by row: one malformed upstream row is dropped, it never hides the others.
export const intentsTokensSchema = z
  .array(z.unknown())
  .max(5000)
  .transform((rows) =>
    rows.flatMap((row) => {
      const r = intentsTokenSchema.safeParse(row);
      return r.success ? [r.data] : [];
    }),
  );

const units = z.string().regex(/^(0|[1-9]\d{0,77})$/);
// Request VEINED sends. `dry: true` is fixed by the schema: a review never opens a deposit address.
export const intentsQuoteRequestSchema = z
  .object({
    dry: z.literal(true),
    swapType: z.literal("EXACT_INPUT"),
    slippageTolerance: z.number().int().min(1).max(300),
    originAsset: assetId,
    depositType: z.literal("ORIGIN_CHAIN"),
    destinationAsset: assetId,
    amount: units.refine((v) => v !== "0"),
    refundTo: z.string().min(2).max(128),
    refundType: z.literal("ORIGIN_CHAIN"),
    recipient: z.string().min(2).max(128),
    recipientType: z.literal("DESTINATION_CHAIN"),
    deadline: z.string().max(40),
    quoteWaitingTimeMs: z.number().int().min(0).max(5000).optional(),
  })
  .strict();
export type IntentsQuoteRequest = z.infer<typeof intentsQuoteRequestSchema>;
const usd = z
  .union([
    z.string().regex(/^\d{1,18}(\.\d{1,18})?$/),
    z.number().finite().nonnegative(),
  ])
  .transform(Number)
  .nullable()
  .optional();
export const intentsQuoteResponseSchema = z
  .object({
    timestamp: z.string().max(40).optional(),
    signature: z.string().max(400).optional(),
    quote: z
      .object({
        depositAddress: z.string().max(160).optional(),
        amountIn: units,
        amountInFormatted: z.string().max(80).optional(),
        amountInUsd: usd,
        minAmountIn: units.optional(),
        amountOut: units,
        amountOutFormatted: z.string().max(80).optional(),
        amountOutUsd: usd,
        minAmountOut: units,
        timeEstimate: z.number().finite().nonnegative().optional(),
        deadline: z.string().max(40).optional(),
      })
      .loose(),
  })
  .loose();
export type IntentsQuoteResponse = z.infer<typeof intentsQuoteResponseSchema>;

export interface IntentsRouteFacts {
  origin: Pick<
    IntentsToken,
    "assetId" | "blockchain" | "symbol" | "contractAddress"
  >;
  destination: Pick<
    IntentsToken,
    "assetId" | "blockchain" | "symbol" | "contractAddress"
  >;
  sender: string;
  refundTo: string;
  recipient: string;
  quote?: {
    amountOut: string;
    minAmountOut: string;
    amountInUsd: number | null;
    amountOutUsd: number | null;
    timeEstimate: number | null;
    dry: boolean;
    /** The upstream opened a deposit address (never expected for a dry quote). */
    depositAddress: boolean;
    deadline: number | null;
  };
  /** Authenticity of the quote as received (checked on the raw response, server side). */
  authenticity?: {
    signature: "VALID" | "INVALID" | "MISSING";
    /** Signed fields that differ from what was requested (asset, amount, recipient, refund …). */
    mismatch: string[];
    /** When 1Click issued the quote (ms), when known. */
    issuedAt: number | null;
  };
}

// Assets VEINED's console offers (and can review offline). Every entry was checked against the live 1Click token list
// (2026-11-08): exact asset id, chain and decimals. Identity is the asset id, never the symbol.
export const INTENTS_KNOWN_ASSETS: readonly IntentsToken[] = Object.freeze([
  {
    assetId: "nep141:wrap.near",
    decimals: 24,
    blockchain: "near",
    symbol: "wNEAR",
    contractAddress: "wrap.near",
  },
  {
    assetId:
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    decimals: 6,
    blockchain: "near",
    symbol: "USDC",
    contractAddress:
      "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  },
  {
    assetId: "nep141:usdt.tether-token.near",
    decimals: 6,
    blockchain: "near",
    symbol: "USDT",
    contractAddress: "usdt.tether-token.near",
  },
  {
    assetId: "nep141:base.omft.near",
    decimals: 18,
    blockchain: "base",
    symbol: "ETH",
  },
  {
    assetId: "nep141:eth.omft.near",
    decimals: 18,
    blockchain: "eth",
    symbol: "ETH",
  },
  {
    assetId: "nep141:arb.omft.near",
    decimals: 18,
    blockchain: "arb",
    symbol: "ETH",
  },
  {
    assetId: "nep141:sol.omft.near",
    decimals: 9,
    blockchain: "sol",
    symbol: "SOL",
  },
  {
    assetId: "nep141:btc.omft.near",
    decimals: 8,
    blockchain: "btc",
    symbol: "BTC",
  },
]);
// G12: source assets the VEINED Swap/Bridge "To NEAR" route offers. Each entry was checked on 2026-11-11 against the live
// 1Click token list (exact asset id, chain, contract, decimals); stablecoin contracts against Circle's published USDC
// addresses or VEINED's own curated registry (Tether USDT; USDT0 on Arbitrum and Polygon). Bridged or pegged look-alikes
// (Binance-Peg USDC and USDT on BNB Chain, USDC on Gnosis) are deliberately absent. Identity is the asset id plus the exact
// contract, never the symbol.
export const INTENTS_REVIEWED_ORIGINS: readonly IntentsToken[] = Object.freeze(
  (
    [
      ["nep141:eth.omft.near", 18, "eth", "ETH"],
      [
        "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
        6,
        "eth",
        "USDC",
        "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      ],
      [
        "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
        6,
        "eth",
        "USDT",
        "0xdac17f958d2ee523a2206206994597c13d831ec7",
      ],
      ["nep141:base.omft.near", 18, "base", "ETH"],
      [
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        6,
        "base",
        "USDC",
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      ],
      ["nep141:arb.omft.near", 18, "arb", "ETH"],
      [
        "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
        6,
        "arb",
        "USDC",
        "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      ],
      [
        "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near",
        6,
        "arb",
        "USDT0",
        "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
      ],
      ["nep245:v2_1.omni.hot.tg:10_11111111111111111111", 18, "op", "ETH"],
      [
        "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ",
        6,
        "op",
        "USDC",
        "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
      ],
      ["nep141:pol.omdep.near", 18, "pol", "POL"],
      [
        "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near",
        6,
        "pol",
        "USDC",
        "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      ],
      [
        "nep141:pol-0xc2132d05d31c914a87c6611c10748aeb04b58e8f.omdep.near",
        6,
        "pol",
        "USDT0",
        "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
      ],
      ["nep141:bnb.omdep.near", 18, "bsc", "BNB"],
      ["nep141:avax.omdep.near", 18, "avax", "AVAX"],
      [
        "nep141:avax-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e.omdep.near",
        6,
        "avax",
        "USDC",
        "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
      ],
      [
        "nep141:avax-0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7.omdep.near",
        6,
        "avax",
        "USDT",
        "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7",
      ],
      ["nep141:sol.omft.near", 9, "sol", "SOL"],
      [
        "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
        6,
        "sol",
        "USDC",
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      ],
    ] as const
  ).map(([assetId, decimals, blockchain, symbol, contractAddress]) => ({
    assetId,
    decimals,
    blockchain,
    symbol,
    ...(contractAddress ? { contractAddress } : {}),
  })),
);
const sameContract = (a?: string, b?: string) =>
  !a || !b
    ? !a && !b
    : /^0x[0-9a-fA-F]{40}$/.test(a)
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
/** The reviewed entry for an intents asset: exact asset id, chain and contract (never the symbol). */
export function reviewedIntentsAsset(
  t: Pick<IntentsToken, "assetId" | "blockchain" | "contractAddress">,
) {
  return [...INTENTS_KNOWN_ASSETS, ...INTENTS_REVIEWED_ORIGINS].find(
    (r) =>
      r.assetId === t.assetId &&
      r.blockchain === t.blockchain &&
      (t.blockchain === "near" ||
        sameContract(r.contractAddress, t.contractAddress)),
  );
}
/** Oldest quote Guardian reviews as current (1Click issue timestamp → now). */
export const MAX_QUOTE_AGE_MS = 120_000;
const ECHO = [
  "dry",
  "swapType",
  "slippageTolerance",
  "originAsset",
  "depositType",
  "destinationAsset",
  "amount",
  "refundTo",
  "refundType",
  "recipient",
  "recipientType",
] as const;
const UNSENT = [
  "referral",
  "virtualChainRecipient",
  "virtualChainRefundRecipient",
  "customRecipientMsg",
  "rebates",
] as const;
/** Fields of the signed quote that differ from the request the user (or agent) actually made. */
export function quoteEcho(
  request: IntentsQuoteRequest,
  response: unknown,
): string[] {
  const r =
    response && typeof response === "object"
      ? (response as Record<string, unknown>)
      : {};
  const q =
    r.quoteRequest && typeof r.quoteRequest === "object"
      ? (r.quoteRequest as Record<string, unknown>)
      : {};
  const o =
    r.quote && typeof r.quote === "object"
      ? (r.quote as Record<string, unknown>)
      : {};
  const out: string[] = ECHO.filter((k) => q[k] !== request[k]);
  // Signed fields VEINED never sends must be absent: a quote carrying them was made for another request.
  for (const k of UNSENT)
    if (
      q[k] !== undefined &&
      q[k] !== null &&
      !(Array.isArray(q[k]) && !(q[k] as unknown[]).length)
    )
      out.push(k);
  // EXACT_INPUT: the quoted input must be exactly the requested amount.
  if (o.amountIn !== request.amount) out.push("amountIn");
  if (o.depositAddress) out.push("depositAddress");
  return out;
}

/** The NEAR account behind an intents asset id (`nep141:wrap.near` → `wrap.near`). */
export function intentsNearContract(
  t: Pick<IntentsToken, "assetId" | "blockchain" | "contractAddress">,
) {
  if (t.blockchain !== "near") return undefined;
  const m = /^nep141:(.+)$/.exec(t.assetId);
  return t.contractAddress && t.contractAddress !== "native"
    ? t.contractAddress
    : m?.[1];
}

export function intentsRules(f: IntentsRouteFacts, now: number): RuleResult {
  const findings: Finding[] = [],
    steps = new Set<SafeStep>();
  let checks = 2;
  const sym = (s: string) => displayText(s, 16) || "?";
  // G12: the asset paid on the source chain is identified exactly (asset id + contract), never by its symbol: a
  // bridged or pegged token that only shares the name is not the reviewed one.
  checks++;
  if (reviewedIntentsAsset(f.origin))
    findings.push(
      finding("ASSET_EVIDENCE", "PASS", "ASSET", {
        symbol: sym(f.origin.symbol),
        role: "pay",
        level: "CURATED",
      }),
    );
  else {
    findings.push(
      finding("ASSET_UNVERIFIED", "CAUTION", "ASSET", {
        symbol: sym(f.origin.symbol),
        role: "pay",
      }),
    );
    steps.add("PICK_CURATED");
  }
  // Destination asset identity on NEAR: the exact token account, never the symbol.
  const contract = intentsNearContract(f.destination);
  if (contract) {
    checks++;
    const known = knownNearAccount(contract);
    if (known)
      findings.push(
        ...reviewNearAccount(contract).map((x) =>
          x.code === "NEAR_ACCOUNT_KNOWN"
            ? finding("ASSET_EVIDENCE", "PASS", "ASSET", {
                symbol: sym(f.destination.symbol),
                role: "receive",
                level: "CURATED",
              })
            : x,
        ),
      );
    else {
      findings.push(
        finding("ASSET_UNVERIFIED", "CAUTION", "ASSET", {
          symbol: sym(f.destination.symbol),
          role: "receive",
        }),
      );
      findings.push(
        ...reviewNearAccount(contract, { role: "receiver" }).filter(
          (x) => x.severity === "CRITICAL" || x.severity === "WARNING",
        ),
      );
      steps.add("PICK_CURATED");
    }
  }
  // Recipient on the destination chain.
  checks++;
  if (f.destination.blockchain === "near") {
    const r = reviewNearAccount(f.recipient, {
      role: "recipient",
      known: [f.sender],
    });
    findings.push(...r);
    if (r.some((x) => x.severity === "CRITICAL"))
      steps.add("STOP").add("CHECK_RECIPIENT");
    else if (r.some((x) => x.code === "NEAR_ACCOUNT_IMPLICIT"))
      steps.add("TEST_TRANSFER");
  } else if (
    validIdentity(f.recipient, "EVM") ||
    validIdentity(f.recipient, "SVM")
  ) {
    const r = recipientRules(f.sender, f.recipient);
    findings.push(...r.findings);
    r.steps.forEach((s) => steps.add(s));
  }
  // Refunds go back to the origin chain: they must reach the sender, not a third party.
  // EVM addresses compare case-insensitively; Solana base58 and NEAR accounts exactly.
  const evm = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
  if (
    f.refundTo &&
    f.sender &&
    (evm(f.refundTo) && evm(f.sender)
      ? f.refundTo.toLowerCase() !== f.sender.toLowerCase()
      : f.refundTo !== f.sender)
  ) {
    findings.push(
      finding("INTENTS_REFUND_EXTERNAL", "WARNING", "RECIPIENT", {
        address: displayText(f.refundTo, 20),
      }),
    );
    steps.add("CHECK_RECIPIENT");
  }
  const a = f.authenticity;
  if (a) {
    checks += 3;
    if (a.signature === "VALID")
      findings.push(
        finding("INTENTS_SIGNATURE_VALID", "PASS", "EXECUTION", {}),
      );
    else {
      findings.push(
        finding("INTENTS_SIGNATURE_INVALID", "CRITICAL", "EXECUTION", {}),
      );
      steps.add("STOP").add("REQUOTE");
    }
    const future = a.issuedAt !== null && a.issuedAt > now + 30_000;
    const fields = [...a.mismatch, ...(future ? ["timestamp"] : [])];
    if (fields.length) {
      findings.push(
        finding("INTENTS_QUOTE_MISMATCH", "CRITICAL", "EXECUTION", {
          fields: fields.slice(0, 6).join(", "),
        }),
      );
      steps.add("STOP").add("REQUOTE");
    }
    if (a.issuedAt !== null && !future && now - a.issuedAt > MAX_QUOTE_AGE_MS) {
      findings.push(finding("ROUTE_STALE", "WARNING", "ROUTE", {}));
      steps.add("REQUOTE");
    }
  }
  const q = f.quote;
  if (q) {
    checks += 4;
    const loss = valueLossBps(q.amountInUsd, q.amountOutUsd);
    if (loss !== null) {
      const [c, w, x] = GUARDIAN_POLICY.valueLossBps;
      const s =
        loss >= x
          ? "CRITICAL"
          : loss >= w
            ? "WARNING"
            : loss >= c
              ? "CAUTION"
              : null;
      if (s) {
        findings.push(
          finding("ROUTE_VALUE_LOSS", s, "ROUTE", {
            loss: `${(loss / 100).toFixed(2)}%`,
          }),
        );
        steps.add("REDUCE_AMOUNT");
      }
    } else
      findings.push(finding("ROUTE_IMPACT_UNKNOWN", "CAUTION", "ROUTE", {}));
    if (
      q.timeEstimate !== null &&
      q.timeEstimate >= GUARDIAN_POLICY.slowBridgeSeconds
    )
      findings.push(
        finding("BRIDGE_SLOW", "INFO", "ROUTE", {
          minutes: Math.round(q.timeEstimate / 60),
        }),
      );
    if (q.deadline !== null && q.deadline <= now) {
      findings.push(finding("ROUTE_STALE", "WARNING", "ROUTE", {}));
      steps.add("REQUOTE");
    }
    if (q.dry && !q.depositAddress)
      findings.push(finding("INTENTS_DRY_QUOTE", "INFO", "EXECUTION", {}));
  }
  return { findings, steps: [...steps], checks };
}

/** Facts from a validated dry quote response. */
export function intentsFacts(
  request: IntentsQuoteRequest,
  origin: IntentsToken,
  destination: IntentsToken,
  response: IntentsQuoteResponse,
  sender: string,
  authenticity?: IntentsRouteFacts["authenticity"],
): IntentsRouteFacts {
  const deadline = response.quote.deadline
    ? Date.parse(response.quote.deadline)
    : NaN;
  return {
    origin: {
      assetId: origin.assetId,
      blockchain: origin.blockchain,
      symbol: origin.symbol,
      contractAddress: origin.contractAddress,
    },
    destination: {
      assetId: destination.assetId,
      blockchain: destination.blockchain,
      symbol: destination.symbol,
      contractAddress: destination.contractAddress,
    },
    sender,
    refundTo: request.refundTo,
    recipient: request.recipient,
    quote: {
      amountOut: response.quote.amountOut,
      minAmountOut: response.quote.minAmountOut,
      amountInUsd: response.quote.amountInUsd ?? null,
      amountOutUsd: response.quote.amountOutUsd ?? null,
      timeEstimate: response.quote.timeEstimate ?? null,
      dry: request.dry,
      depositAddress: !!response.quote.depositAddress,
      deadline: Number.isFinite(deadline) ? deadline : null,
    },
    ...(authenticity ? { authenticity } : {}),
  };
}
