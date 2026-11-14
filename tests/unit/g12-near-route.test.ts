// G12 H02: the reviewed "To NEAR" route (Swap / Bridge → NEAR Intents dry quote → Guardian). Pure functions only:
// reviewed asset identity (exact asset id + contract, never the symbol), the DRY request VEINED builds, the receipt
// read from a signed quote (unknown stays unknown, never 0) and Guardian's new source-asset identity rule.
// SYNTHETIC_TEST_ONLY apart from two recorded public 1Click dry quotes; nothing is signed, deposited or sent.
import { describe, expect, it } from "vitest";
import {
  INTENTS_KNOWN_ASSETS,
  INTENTS_REVIEWED_ORIGINS,
  intentsFacts,
  intentsQuoteRequestSchema,
  intentsQuoteResponseSchema,
  reviewedIntentsAsset,
} from "../../src/guardian/intents";
import {
  NEAR_ROUTE_CHAINS,
  NEAR_ROUTE_DEADLINE_MS,
  nearQuoteRequest,
  nearRouteChainOf,
  nearRouteDestinations,
  nearRouteOrigins,
  nearRouteReceipt,
  quoteMatchesRequest,
  validRefundAddress,
} from "../../src/guardian/near-route";
import { knownNearAccount } from "../../src/guardian/near";
import { reviewIntents } from "../../src/guardian/verdict";
import { quoteEcho } from "../../src/guardian/intents";
import { RECORDED_QUOTE } from "../../src/guardian/scenarios";
import usdcQuote from "../fixtures/g12-near-usdc-quote.json" with { type: "json" };

/** A signed 1Click quote as JSON, for deliberate edits in adversarial cases. */
type SignedQuote = {
  quote: Record<string, unknown>;
  quoteRequest: Record<string, unknown>;
} & Record<string, unknown>;

// Circle's published native USDC contracts (developers.circle.com/stablecoins/usdc-contract-addresses, read
// 2026-11-11). BNB Chain and Gnosis have no Circle-issued USDC, so VEINED offers none there.
const CIRCLE_USDC: Record<string, string> = {
  eth: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  arb: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  op: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
  pol: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  avax: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
  sol: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};
const NOW = Date.parse("2026-11-11T01:00:00.000Z");
const SENDER = "0xb6Ded1B18464aED61DB794dFC5cb031B45a7cA2c";
const origin = (chain: string, symbol: string) =>
  INTENTS_REVIEWED_ORIGINS.find(
    (t) => t.blockchain === chain && t.symbol === symbol,
  )!;
const near = (symbol: string) =>
  nearRouteDestinations().find((d) => d.symbol === symbol)!;

describe("G12 reviewed NEAR route assets", () => {
  it("NR1 every reviewed source asset is exact: one per id, a route chain, sane decimals, a real contract or the native coin", () => {
    const ids = INTENTS_REVIEWED_ORIGINS.map((t) => t.assetId);
    expect(new Set(ids).size).toBe(ids.length);
    const chains = NEAR_ROUTE_CHAINS.map((c) => c.key as string);
    for (const t of INTENTS_REVIEWED_ORIGINS) {
      expect(chains).toContain(t.blockchain);
      expect(t.assetId).toMatch(/^[a-z0-9_]+:[A-Za-z0-9._:-]+$/);
      expect([6, 9, 18]).toContain(t.decimals);
      if (t.contractAddress && t.blockchain !== "sol") {
        expect(t.contractAddress).toMatch(/^0x[0-9a-f]{40}$/);
        // omft/omdep ids embed the exact contract they bridge from.
        if (/\.(omft|omdep)\.near$/.test(t.assetId))
          expect(t.assetId).toContain(t.contractAddress);
      }
    }
    // Each route chain offers at least its native coin first.
    for (const c of NEAR_ROUTE_CHAINS) {
      const list = nearRouteOrigins(c.key);
      expect(list.length).toBeGreaterThan(0);
      expect(list[0].contractAddress).toBeUndefined();
    }
  });
  it("NR2 USDC is Circle's native contract on every chain that offers it; no bridged or pegged USDC is offered", () => {
    const usdc = INTENTS_REVIEWED_ORIGINS.filter((t) => t.symbol === "USDC");
    expect(usdc.map((t) => t.blockchain).sort()).toEqual(
      Object.keys(CIRCLE_USDC).sort(),
    );
    for (const t of usdc) {
      expect(t.decimals).toBe(6);
      expect(t.contractAddress).toBe(CIRCLE_USDC[t.blockchain]);
    }
    expect(
      INTENTS_REVIEWED_ORIGINS.some(
        (t) =>
          t.contractAddress === "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" ||
          t.contractAddress === "0x2a22f9c3b484c3629090feed35f17ff8f88f76f0" ||
          // Binance-Peg USDT on BNB Chain (pegged by Binance, not issued by Tether).
          t.contractAddress === "0x55d398326f99059ff775485246999027b3197955",
      ),
    ).toBe(false);
  });
  it("NR3 NEAR targets: wNEAR is labelled wrapped, USDC and USDT are the native NEAR tokens (never a bridged variant)", () => {
    const d = nearRouteDestinations();
    expect(d.map((x) => [x.symbol, x.kind])).toEqual([
      ["wNEAR", "wrapped"],
      ["USDC", "native"],
      ["USDT", "native"],
    ]);
    for (const x of d) {
      const account = knownNearAccount(x.contractAddress!);
      expect(account).toBeDefined();
      expect(account!.variantOf).toBeUndefined();
      expect(INTENTS_KNOWN_ASSETS).toContainEqual(
        expect.objectContaining({ assetId: x.assetId }),
      );
    }
  });
  it("NR4 identity is the asset id plus the exact contract: same symbol, other contract or other chain is not reviewed", () => {
    const base = origin("base", "USDC");
    expect(reviewedIntentsAsset(base)).toBe(base);
    expect(
      reviewedIntentsAsset({
        ...base,
        contractAddress: base
          .contractAddress!.toUpperCase()
          .replace("0X", "0x"),
      }),
    ).toBe(base);
    expect(
      reviewedIntentsAsset({
        ...base,
        contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02914",
      }),
    ).toBeUndefined();
    expect(
      reviewedIntentsAsset({ ...base, blockchain: "arb" }),
    ).toBeUndefined();
    expect(
      reviewedIntentsAsset({
        assetId:
          "nep141:bnb-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omdep.near",
        blockchain: "bsc",
        contractAddress: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
      }),
    ).toBeUndefined();
    // A native coin with an injected contract is not the native coin.
    expect(
      reviewedIntentsAsset({
        assetId: "nep141:base.omft.near",
        blockchain: "base",
        contractAddress: "0x0000000000000000000000000000000000000001",
      }),
    ).toBeUndefined();
  });
  it("NR5 wallet and address types: the connected EVM chain maps to its route chain; refunds need the source chain's format", () => {
    expect(nearRouteChainOf(8453)).toBe("base");
    expect(nearRouteChainOf(42161)).toBe("arb");
    expect(nearRouteChainOf(324)).toBeUndefined();
    expect(nearRouteChainOf(undefined)).toBeUndefined();
    expect(validRefundAddress("base", SENDER)).toBe(true);
    expect(validRefundAddress("sol", SENDER)).toBe(false);
    expect(
      validRefundAddress("sol", "7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs"),
    ).toBe(true);
    expect(validRefundAddress("eth", "veinedxyz.near")).toBe(false);
    // Never the zero address, a broken checksum or the Solana system program; all-lowercase EVM is accepted.
    expect(
      validRefundAddress("base", "0x0000000000000000000000000000000000000000"),
    ).toBe(false);
    expect(validRefundAddress("base", SENDER.toLowerCase())).toBe(true);
    expect(validRefundAddress("base", SENDER.replace("b6Ded1", "b6DeD1"))).toBe(
      false,
    );
    expect(validRefundAddress("sol", "11111111111111111111111111111111")).toBe(
      false,
    );
  });
});

describe("G12 the DRY request and the receipt", () => {
  it("NR6 VEINED's request is schema-valid, dry, exact input, refunds to the sender and expires in ten minutes", () => {
    const r = nearQuoteRequest({
      origin: origin("base", "USDC"),
      destination: near("USDC"),
      amount: 5_000_000n,
      sender: ` ${SENDER} `,
      recipient: " veinedxyz.near ",
      now: NOW,
    });
    expect(intentsQuoteRequestSchema.parse(r)).toEqual(r);
    expect(r).toMatchObject({
      dry: true,
      swapType: "EXACT_INPUT",
      depositType: "ORIGIN_CHAIN",
      refundType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      amount: "5000000",
      refundTo: SENDER,
      recipient: "veinedxyz.near",
      originAsset:
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      destinationAsset:
        "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    });
    expect(Date.parse(r.deadline)).toBe(NOW + NEAR_ROUTE_DEADLINE_MS);
    // A non-dry request can never pass the wire schema, and VEINED never adds a fee recipient.
    expect(() =>
      intentsQuoteRequestSchema.parse({ ...r, dry: false }),
    ).toThrow();
    expect(() =>
      intentsQuoteRequestSchema.parse({
        ...r,
        appFees: [{ recipient: "veined.near", fee: 30 }],
      }),
    ).toThrow();
  });
  it("NR7 the receipt reads the signed quote as received: exact units, provider fee, refund fee and the preview window", () => {
    const r = nearRouteReceipt(usdcQuote.response)!;
    expect(r.amountIn).toBe(5_000_000n);
    expect(r.amountOut).toBe(1390682321253991151351740n);
    expect(r.minAmountOut).toBe(1376775498041451239838222n);
    expect(r.minAmountOut <= r.amountOut).toBe(true);
    expect(r.providerFeeBps).toBe(20);
    expect(r.refundFee).toBe(2400n);
    expect(r.withdrawFee).toBe(0n);
    expect(r.amountInUsd).toBeCloseTo(4.997845, 6);
    expect(r.timeEstimate).toBe(35);
    expect(r.issuedAt).toBe(Date.parse("2026-11-10T22:24:20.158Z"));
    expect(r.previewUntil).toBe(r.issuedAt! + 120_000);
    // The recorded quote that the Guardian console replays reads the same way.
    expect(nearRouteReceipt(RECORDED_QUOTE.response)!.providerFeeBps).toBe(20);
  });
  it("NR8 unknown stays unknown: missing USD, fee or timestamp is null (never 0); malformed amounts give no receipt", () => {
    const q = structuredClone(usdcQuote.response) as SignedQuote;
    delete q.quote.amountInUsd;
    q.quote.amountOutUsd = "n/a";
    delete q.quote.refundFee;
    delete q.timestamp;
    q.quoteRequest.appFees = [{ recipient: "x", fee: "20" }];
    const r = nearRouteReceipt(q)!;
    expect(r.amountInUsd).toBeNull();
    expect(r.amountOutUsd).toBeNull();
    expect(r.refundFee).toBeNull();
    expect(r.providerFeeBps).toBeNull();
    expect(r.issuedAt).toBeNull();
    expect(r.previewUntil).toBeNull();
    for (const bad of [
      { ...q, quote: { ...q.quote, amountOut: "1.5" } },
      { ...q, quote: { ...q.quote, minAmountOut: -1 } },
      { ...q, quote: undefined },
      null,
      "quote",
    ])
      expect(nearRouteReceipt(bad)).toBeNull();
    // No fee field at all: the provider reported nothing, so the fee is unknown (null), never 0.
    const noFee = structuredClone(usdcQuote.response) as SignedQuote;
    delete noFee.quoteRequest.appFees;
    expect(nearRouteReceipt(noFee)!.providerFeeBps).toBeNull();
    // An empty fee list is a reported zero.
    noFee.quoteRequest.appFees = [];
    expect(nearRouteReceipt(noFee)!.providerFeeBps).toBe(0);
  });
});

describe("G12 receipts are shown only for the exact request", () => {
  it("NR12 a signed quote for another asset, amount, recipient or refund (or with a deposit address) is not displayable", () => {
    const request = intentsQuoteRequestSchema.parse(usdcQuote.request);
    expect(quoteMatchesRequest(request, usdcQuote.response)).toBe(true);
    const edit = (f: (r: SignedQuote) => void) => {
      const r = structuredClone(usdcQuote.response) as SignedQuote;
      f(r);
      return quoteMatchesRequest(request, r);
    };
    expect(
      edit(
        (r) =>
          (r.quoteRequest.destinationAsset = "nep141:usdt.tether-token.near"),
      ),
    ).toBe(false);
    expect(edit((r) => (r.quoteRequest.amount = "5000001"))).toBe(false);
    expect(edit((r) => (r.quote.amountIn = "4000000"))).toBe(false);
    expect(
      edit((r) => (r.quoteRequest.recipient = "veinedxyz-rewards.near")),
    ).toBe(false);
    expect(
      edit(
        (r) =>
          (r.quoteRequest.refundTo = String(
            r.quoteRequest.refundTo,
          ).toLowerCase()),
      ),
    ).toBe(false);
    expect(edit((r) => (r.quoteRequest.dry = false))).toBe(false);
    expect(edit((r) => (r.quote.depositAddress = "0xdead"))).toBe(false);
    expect(quoteMatchesRequest(request, null)).toBe(false);
    expect(
      quoteMatchesRequest({ ...request, amount: "1" }, usdcQuote.response),
    ).toBe(false);
  });
});

describe("G12 Guardian: source asset identity", () => {
  const parsed = intentsQuoteResponseSchema.parse(usdcQuote.response);
  const request = intentsQuoteRequestSchema.parse(usdcQuote.request);
  const issued = Date.parse(usdcQuote.response.timestamp);
  const facts = (o = origin("base", "USDC")) =>
    intentsFacts(request, o, near("wNEAR"), parsed, SENDER, {
      signature: "VALID",
      mismatch: [],
      issuedAt: issued,
    });
  it("NR9 a reviewed source asset passes with evidence; the recorded owner quote stays CLEAR while it is fresh", () => {
    const v = reviewIntents(facts(), issued + 10_000);
    expect(v.level).toBe("CLEAR");
    expect(v.findings).toContainEqual(
      expect.objectContaining({
        code: "ASSET_EVIDENCE",
        severity: "PASS",
        params: expect.objectContaining({ role: "pay", symbol: "USDC" }),
      }),
    );
  });
  it("NR10 a same-symbol source asset that is not the reviewed contract is a caution with the reviewed-list step", () => {
    const pegged = {
      assetId:
        "nep141:bnb-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omdep.near",
      decimals: 18,
      blockchain: "bsc",
      symbol: "USDC",
      contractAddress: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    };
    const v = reviewIntents(facts(pegged), issued + 10_000);
    expect(v.level).toBe("CAUTION");
    expect(v.findings).toContainEqual(
      expect.objectContaining({
        code: "ASSET_UNVERIFIED",
        severity: "CAUTION",
        params: expect.objectContaining({ role: "pay" }),
      }),
    );
    expect(v.steps).toContain("PICK_CURATED");
    expect(v.digest).not.toBe(reviewIntents(facts(), issued + 10_000).digest);
  });
  it("NR11 expiry fails closed: the same signed quote is a HOLD with a re-quote step after the preview window", () => {
    const v = reviewIntents(facts(), issued + 121_000);
    expect(v.level).toBe("HOLD");
    expect(v.findings.map((f) => f.code)).toContain("ROUTE_STALE");
    expect(v.steps).toContain("REQUOTE");
  });
});

describe("G12 Guardian review hardening", () => {
  it("NR13 a signed quote carrying fields VEINED never sends (referral, virtual recipients, custom message) is a mismatch", () => {
    const request = intentsQuoteRequestSchema.parse(usdcQuote.request);
    expect(quoteEcho(request, usdcQuote.response)).toEqual([]);
    for (const [k, v] of [
      ["referral", "someone-else"],
      ["virtualChainRecipient", "0x000000000000000000000000000000000000dEaD"],
      [
        "virtualChainRefundRecipient",
        "0x000000000000000000000000000000000000dEaD",
      ],
      ["customRecipientMsg", '{"receiver_id":"x.near"}'],
      ["rebates", [{ recipient: "x.near", share: 50 }]],
    ] as const) {
      const r = structuredClone(usdcQuote.response) as SignedQuote;
      r.quoteRequest[k] = v;
      expect(quoteEcho(request, r)).toContain(k);
    }
    const empty = structuredClone(usdcQuote.response) as SignedQuote;
    empty.quoteRequest.rebates = [];
    expect(quoteEcho(request, empty)).toEqual([]);
  });
  it("NR14 refunds: EVM addresses compare case-insensitively, Solana addresses exactly (base58 is case-sensitive)", () => {
    const sol = origin("sol", "SOL");
    const base = (
      refundTo: string,
      sender: string,
      o = origin("base", "USDC"),
    ) =>
      reviewIntents(
        {
          origin: o,
          destination: near("wNEAR"),
          sender,
          refundTo,
          recipient: "veinedxyz.near",
        },
        NOW,
      ).findings.map((f) => f.code);
    expect(base(SENDER.toLowerCase(), SENDER)).not.toContain(
      "INTENTS_REFUND_EXTERNAL",
    );
    const a = "7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs";
    expect(base(a, a, sol)).not.toContain("INTENTS_REFUND_EXTERNAL");
    expect(base(a.toLowerCase(), a, sol)).toContain("INTENTS_REFUND_EXTERNAL");
  });
});
