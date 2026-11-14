import { describe, it, expect, vi } from "vitest";
import {
  encodeFunctionData,
  decodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import {
  assertQuote,
  canonical,
  executeSwap,
  impactBps,
  parseIntent,
  quoteEligible,
  SwapError,
  ZERO,
} from "../../src/swap/model";
import { netValue, rankQuotes, stickySelection } from "../../src/swap/ranking";
import { digest } from "../../src/swap/server/digest";
import { buildEvm, decodeEvm, universalAbi } from "../../src/swap/server/evm";
import { routerPin, swapConfig } from "../../src/swap/server/config";
import { validatePermit } from "../../src/swap/server/approval";
import { QuoteCoordinator } from "../../src/swap/server/coordinator";
import { decodePcsx } from "../../src/swap/server/providers/pcsx";
import { normalizeJupiter } from "../../src/swap/server/providers/jupiter";
import { normalizeTitan } from "../../src/swap/server/providers/titan";
import {
  swapIntent,
  swapQuote,
  solIntent,
  jupiterPayload,
  wallet,
} from "../fixtures/swap";
import type { QuoteAdapter } from "../../src/swap/server/provider";

describe("V115 intent and ranking", () => {
  it("keeps 256-bit financial inputs exact through JSON", () => {
    const i = swapIntent({ amount: 2n ** 200n });
    const parsed = parseIntent(JSON.parse(canonical(i)));
    expect(parsed.amount).toBe(2n ** 200n);
  });
  it.each([
    "chain",
    "recipient",
    "walletEpoch",
    "portfolioRevision",
    "tokenIn",
    "tokenOut",
    "amount",
    "slippage",
    "expiresAt",
  ])("digest binds %s", (field) => {
    const i = swapIntent();
    expect(digest({ ...i, [field]: "changed" })).not.toBe(digest(i));
  });
  it.each([
    { chain: "8453" },
    { recipient: ZERO },
    { taker: "ETH" },
    { amount: "1.1" },
    { amount: "-1" },
    { amount: "01" },
    { slippage: { mode: "MANUAL", bps: 301 } },
    { ecosystem: "SVM" },
    { rpcUrl: "https://attacker.invalid" },
    { expiresAt: 1 },
  ])("rejects hostile intent %j", (value) =>
    expect(() => parseIntent({ ...swapIntent(), ...value })).toThrow(),
  );
  it("rejects cross-chain token identities", () => {
    const i = swapIntent();
    i.tokenOut.chain = "56";
    expect(() => parseIntent(i)).toThrow();
  });
  it("never treats symbol as token identity", () => {
    const i = swapIntent();
    i.tokenOut.symbol = "ETH";
    expect(parseIntent(i).tokenOut.address).not.toBe(i.tokenIn.address);
  });
  it("normalizes fraction and percentage impact", () => {
    expect(impactBps("0.02", "FRACTION")).toBe(200);
    expect(impactBps(2, "PERCENT")).toBe(200);
    expect(impactBps(-0.1, "PERCENT")).toBe(-10);
    expect(() => impactBps("NaN", "PERCENT")).toThrow();
  });
  it("blocks extreme negative and positive impacts", () => {
    for (const n of [-1500, 1500])
      expect(
        quoteEligible(swapQuote(undefined, undefined, { priceImpactBps: n })),
      ).toBe(false);
  });
  it("raw output is not net value when any cost is unknown", () => {
    const i = swapIntent(),
      q = swapQuote(i);
    expect(netValue(q, "EXACT_IN")).toBeNull();
    expect(rankQuotes([q], i).basis).toBe("RAW_OUTPUT");
  });
  it("subtracts external costs once and excludes already included fees", () => {
    const i = swapIntent(),
      q = swapQuote(i);
    q.valuation = "INDEPENDENT";
    q.outputUsdMicros = 1000n;
    q.costs = q.costs.map((c) => ({
      ...c,
      amount: 10n,
      usdMicros: 100n,
      evidence: "INDEPENDENT",
    }));
    expect(netValue(q, "EXACT_IN")).toBe(900n);
  });
  it("prefers lower total input on exact-out including costs", () => {
    const q = swapQuote();
    q.valuation = "INDEPENDENT";
    q.inputUsdMicros = 1000n;
    q.costs = q.costs.map((c) => ({
      ...c,
      amount: 0n,
      usdMicros: 0n,
      evidence: "INDEPENDENT",
    }));
    expect(netValue(q, "EXACT_OUT")).toBe(-1000n);
  });
  it("ranks output, latency and complexity independently", () => {
    const i = swapIntent(),
      a = swapQuote(i, undefined, {
        id: "a",
        amountOut: 20n,
        latencyMs: 100,
        hops: 3,
      }),
      b = swapQuote(i, undefined, {
        id: "b",
        amountOut: 10n,
        latencyMs: 1,
        hops: 1,
      });
    expect(
      rankQuotes([a, b], { ...i, preference: "OUTPUT" }).quotes[0].id,
    ).toBe(a.id);
    for (const preference of ["FASTEST", "DIRECT"] as const)
      expect(rankQuotes([a, b], { ...i, preference }).quotes[0].id).toBe(b.id);
  });
  it("counts providers, not multiple routes from a provider", () => {
    const i = swapIntent();
    expect(rankQuotes([swapQuote(i), swapQuote(i)], i).checkedProviders).toBe(
      1,
    );
  });
  it("selected version stays fixed when better quote arrives", () => {
    const a = swapQuote(),
      b = { ...a, id: "late", amountOut: a.amountOut * 2n };
    expect(stickySelection(a, [b, a])).toEqual({ selected: a, better: true });
  });
  it("expired selection is not silently replaced", () => {
    const a = swapQuote(undefined, undefined, { expiresAt: 1 }),
      b = swapQuote();
    expect(stickySelection(a, [b]).selected).toBe(a);
    expect(quoteEligible(a)).toBe(false);
  });
  it("lower exact-output input is a material improvement without replacing selection", () => {
    const a = swapQuote(),
      b = { ...a, id: "b", amountIn: (a.amountIn * 99n) / 100n };
    expect(stickySelection(a, [b, a])).toEqual({ selected: a, better: true });
  });
  it.each(["minAmountOut", "amountIn", "maxAmountIn"])(
    "rejects mutated quote bound %s",
    (key) => {
      const i = swapIntent(),
        q = swapQuote(i);
      expect(() => assertQuote({ ...q, [key]: 0n }, i, digest(i))).toThrow();
    },
  );
  it("execution cannot be activated with configuration", () => {
    expect(executeSwap).toThrow("EXECUTION_CLOSED");
    expect(() => swapConfig({ SWAP_EXECUTION_ENABLED: "true" })).toThrow();
  });
});
describe("V115 EVM firewall", () => {
  for (const chain of ["1", "56", "8453"] as const)
    for (const mode of ["UNISWAP", "PANCAKESWAP_SMART"] as const)
      it(`${mode} router pinned on ${chain}`, () => {
        const i = swapIntent();
        i.chain = chain;
        i.tokenIn.chain = chain;
        i.tokenOut.chain = chain;
        const q = swapQuote(i, mode),
          tx = buildEvm(q, i);
        expect(decodeEvm(tx, q, i).router).toBe(
          routerPin(mode, chain).address.toLowerCase(),
        );
      });
  it.each(["V2", "V3"] as const)(
    "decodes %s with native wrapping",
    (poolType) => {
      const i = swapIntent(),
        q = swapQuote(i);
      q.route[0].poolType = poolType;
      const tx = buildEvm(q, i),
        d = decodeEvm(tx, q, i);
      expect(d.commands).toEqual([11, poolType === "V2" ? 8 : 0]);
      expect(d.approval.kind).toBe("NONE");
    },
  );
  it("handles exact-output reversed path and max input", () => {
    const i = swapIntent();
    i.tokenIn.native = false;
    i.tokenIn.address = wallet;
    i.kind = "EXACT_OUT";
    const q = swapQuote(i, undefined, {
      amountIn: 30n,
      amountOut: i.amount,
      minAmountOut: i.amount,
      maxAmountIn: 31n,
    });
    expect(decodeEvm(buildEvm(q, i), q, i).maxIn).toBe(31n);
  });
  it.each(["STABLE", "VOLATILE"] as const)(
    "Aerodrome %s never builds unsafe methods",
    (poolType) => {
      const i = swapIntent();
      i.chain = "8453";
      i.tokenIn.chain = i.tokenOut.chain = "8453";
      const q = swapQuote(i, "AERODROME_CLASSIC");
      q.route[0].poolType = poolType;
      expect(decodeEvm(buildEvm(q, i), q, i).minOut).toBe(q.minAmountOut);
    },
  );
  it.each(["to", "from", "chainId", "value", "data"])(
    "refuses transaction %s mutation",
    (field) => {
      const i = swapIntent(),
        q = swapQuote(i),
        tx = buildEvm(q, i);
      expect(() =>
        decodeEvm(
          {
            ...tx,
            [field]:
              field === "data"
                ? "0xdeadbeef"
                : field === "value"
                  ? "1"
                  : "0x5555555555555555555555555555555555555555",
          },
          q,
          i,
        ),
      ).toThrow();
    },
  );
  it("refuses unknown transaction fields", () => {
    const i = swapIntent(),
      q = swapQuote(i);
    expect(() =>
      decodeEvm({ ...buildEvm(q, i), gas: "1" } as never, q, i),
    ).toThrow();
  });
  it.each([0x04, 0x05, 0x06, 0x0a, 0x21, 0x80, 0x10])(
    "rejects injected command %i",
    (command) => {
      const i = swapIntent(),
        q = swapQuote(i),
        tx = buildEvm(q, i),
        d = decodeFunctionData({ abi: universalAbi, data: tx.data });
      const data = encodeFunctionData({
        abi: universalAbi,
        functionName: "execute",
        args: [
          `0x${command.toString(16).padStart(2, "0")}`,
          [d.args[1][1]],
          d.args[2],
        ],
      });
      expect(() => decodeEvm({ ...tx, data }, q, i)).toThrow();
    },
  );
  it.each(["recipient", "amount", "minimum", "token", "payer"])(
    "refuses calldata %s substitution",
    (field) => {
      const i = swapIntent(),
        q = swapQuote(i),
        tx = buildEvm(q, i),
        d = decodeFunctionData({ abi: universalAbi, data: tx.data });
      const path =
        `0x${q.route[0].tokenIn.slice(2)}0001f4${(field === "token" ? wallet : i.tokenOut.address).slice(2)}` as `0x${string}`;
      const input = encodeAbiParameters(
        parseAbiParameters("address,uint256,uint256,bytes,bool"),
        [
          field === "recipient" ? ZERO : (i.recipient as `0x${string}`),
          field === "amount" ? 1n : i.amount,
          field === "minimum" ? 1n : q.minAmountOut,
          path,
          field === "payer",
        ],
      );
      const data = encodeFunctionData({
        abi: universalAbi,
        functionName: "execute",
        args: [d.args[0], [d.args[1][0], input], d.args[2]],
      });
      expect(() => decodeEvm({ ...tx, data }, q, i)).toThrow();
    },
  );
  it("rejects trailing calldata", () => {
    const i = swapIntent(),
      q = swapQuote(i),
      tx = buildEvm(q, i);
    expect(() => decodeEvm({ ...tx, data: `${tx.data}00` }, q, i)).toThrow();
  });
  it("rejects provider fee injection", () => {
    const i = swapIntent(),
      q = swapQuote(i),
      tx = buildEvm(q, i);
    q.costs[1].amount = 1n;
    expect(() => decodeEvm(tx, q, i)).toThrow();
  });
  it("refuses V4 and Infinity until full command semantics are reviewed", () => {
    for (const poolType of ["V4", "INFINITY_CL", "INFINITY_BIN"] as const) {
      const i = swapIntent(),
        q = swapQuote(i);
      q.route[0].poolType = poolType;
      expect(() => buildEvm(q, i)).toThrow("BUILD_REVIEW_REQUIRED");
    }
  });
  it("expires built transactions", () => {
    const i = swapIntent(),
      q = swapQuote(i),
      tx = buildEvm(q, i);
    expect(() => decodeEvm(tx, q, i, q.expiresAt + 1)).toThrow("QUOTE_STALE");
  });
});
describe("V115 Permit2 and provider drift", () => {
  function fixture() {
    const i = swapIntent();
    i.tokenIn.native = false;
    i.tokenIn.address = wallet;
    const q = swapQuote(i),
      pin = routerPin(q.mode, i.chain);
    const p = {
      quoteId: q.id,
      intentDigest: q.intentDigest,
      owner: i.taker,
      domain: { name: "Permit2", chainId: 1, verifyingContract: pin.permit2 },
      details: {
        token: wallet,
        amount: i.amount,
        expiration: Math.floor(q.expiresAt / 1000),
        nonce: 0n,
      },
      spender: pin.address,
      sigDeadline: Math.floor(q.expiresAt / 1000),
    };
    return { i, q, p };
  }
  it("valid normalized permit is never signable", () => {
    const { i, q, p } = fixture();
    expect(validatePermit(p, q, i).signable).toBe(false);
  });
  it.each(["quoteId", "owner", "spender", "intentDigest"])(
    "refuses permit %s mutation",
    (key) => {
      const { i, q, p } = fixture();
      expect(() => validatePermit({ ...p, [key]: "mutated" }, q, i)).toThrow();
    },
  );
  it("refuses unlimited authorization and expired deadlines", () => {
    const { i, q, p } = fixture();
    expect(() =>
      validatePermit(
        { ...p, details: { ...p.details, amount: 2n ** 160n - 1n } },
        q,
        i,
      ),
    ).toThrow();
    expect(() => validatePermit({ ...p, sigDeadline: 1 }, q, i)).toThrow();
  });
  it("old permit cannot survive requote or wallet change", () => {
    const { i, q, p } = fixture();
    expect(() => validatePermit(p, { ...q, id: "requote" }, i)).toThrow();
    expect(() => validatePermit(p, q, { ...i, walletEpoch: 99 })).toThrow();
  });
  it("Jupiter V2 meta percentage differs from router fraction", () => {
    const i = solIntent(),
      raw = jupiterPayload(i);
    expect(normalizeJupiter(raw, i, "JUPITER_META").q.priceImpactBps).toBe(-10);
    expect(normalizeJupiter(raw, i, "JUPITER_ROUTER").q.priceImpactBps).toBe(
      -10,
    );
  });
  it.each([
    { inputMint: "wrong" },
    { transactionVersion: 1 },
    { slippageBps: 999 },
    { swapMode: "ExactOut" },
  ])("Jupiter drift %j fails closed", (change) =>
    expect(() =>
      normalizeJupiter(
        { ...jupiterPayload(), ...change },
        solIntent(),
        "JUPITER_META",
      ),
    ).toThrow(),
  );
  it("provider platform fee is not Otherbridge platform fee", () => {
    const i = solIntent(),
      q = normalizeJupiter(
        {
          ...jupiterPayload(i),
          feeBps: 10,
          platformFee: { amount: "1000", feeBps: 10 },
        },
        i,
        "JUPITER_META",
      ).q;
    expect(q.costs.find((c) => c.kind === "PLATFORM")?.amount).toBe(0n);
    expect(q.costs.find((c) => c.kind === "PROVIDER")?.amount).toBe(1000n);
  });
  it("unknown PCSX order fails closed", () =>
    expect(() => decodePcsx("0xdeadbeef", swapIntent())).toThrow());
  it("malformed Titan frame fails without echoing secrets", () => {
    expect(() =>
      normalizeTitan({ secret: "never echo" } as never, solIntent()),
    ).toThrow("INVALID_SCHEMA");
  });
});
describe("V115 quote isolation", () => {
  const adapter = (
    mode: "UNISWAP" | "PANCAKESWAP_SMART",
    quote: QuoteAdapter["quote"],
  ): QuoteAdapter => ({
    mode,
    provider: mode === "UNISWAP" ? "Uniswap" : "PancakeSwap",
    chains: ["1"],
    exactOut: true,
    quote,
  });
  it("first valid quote arrives before slowest provider, timeout is isolated", async () => {
    const i = swapIntent(),
      events: string[] = [];
    let first = 0;
    const started = Date.now();
    const c = new QuoteCoordinator(
      [
        adapter("UNISWAP", async () => [swapQuote(i)]),
        adapter("PANCAKESWAP_SMART", () => new Promise(() => {})),
      ],
      80,
    );
    await c.compete(i, new AbortController().signal, (e) => {
      events.push(e.type);
      if (e.type === "quote") first = Date.now() - started;
    });
    expect(first).toBeLessThan(60);
    expect(c.health().find((p) => p.mode === "PANCAKESWAP_SMART")?.status).toBe(
      "PROVIDER_TIMEOUT",
    );
    expect(events.at(-1)).toBe("settled");
  });
  it("shared flight and cache bound ten concurrent callers to one request", async () => {
    const i = swapIntent(),
      fn = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return [swapQuote(i)];
      }),
      c = new QuoteCoordinator([adapter("UNISWAP", fn)]);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        c.compete(i, new AbortController().signal, () => {}),
      ),
    );
    await c.compete(i, new AbortController().signal, () => {});
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("cancelled client cannot receive late results; another still can", async () => {
    const i = swapIntent(),
      abort = new AbortController(),
      a: unknown[] = [],
      b: unknown[] = [],
      c = new QuoteCoordinator([
        adapter("UNISWAP", async () => {
          await new Promise((r) => setTimeout(r, 20));
          return [swapQuote(i)];
        }),
      ]);
    const p = c.compete(i, abort.signal, (e) => a.push(e));
    const p2 = c.compete(i, new AbortController().signal, (e) => b.push(e));
    abort.abort();
    await Promise.all([p, p2]);
    expect(a).toHaveLength(1);
    expect(b.length).toBeGreaterThan(1);
  });
  it("429 cooldown prevents a retry storm", async () => {
    const fn = vi.fn(async () => {
        throw new SwapError("RATE_LIMITED");
      }),
      c = new QuoteCoordinator([adapter("UNISWAP", fn)]),
      i = swapIntent();
    for (let n = 0; n < 10; n++)
      await c.compete(i, new AbortController().signal, () => {});
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("exact-out skips unsupported providers", async () => {
    const fn = vi.fn(),
      a = adapter("UNISWAP", fn);
    a.exactOut = false;
    await new QuoteCoordinator([a]).compete(
      swapIntent({ kind: "EXACT_OUT" }),
      new AbortController().signal,
      () => {},
    );
    expect(fn).not.toHaveBeenCalled();
  });
});
