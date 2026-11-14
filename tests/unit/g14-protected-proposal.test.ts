// G14 PROTECTED PROPOSAL (B1–B5, C) — unit tests on the build exactly as proposed: the owner record is DISARMED.
// SYNTHETIC_TEST_ONLY: the account is 0x3333…3333, "owner approvals" are made-up records passed to the PURE validator,
// the wallet and the RPC operators are in-memory doubles. Nothing signs, sends or reaches a network.
// The positive paths (an armed record, substituted by a test double) live in the integration suite.
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
// G14 follow-up F2: installed BEFORE the wallet adapter module is evaluated (the adapter captures the page's fetch).
import { pageServer } from "../fixtures/g14-closure/page-server";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  toFunctionSelector,
  type Hex,
} from "viem";
import fx from "../fixtures/g14-canary-across.json" with { type: "json" };
import livePins from "../fixtures/g14-protected-proposal/live-pin-check-2.json" with { type: "json" };
import snapshot from "../../src/routing/catalog-snapshot.json" with { type: "json" };
import {
  ARB_A,
  ARB_B,
  BASE_A,
  BASE_B,
  BLOCK,
  DIAMOND,
  NOW,
  OTHER,
  QUOTED_AT,
  SELECTOR,
  SYN,
  USDC_ARB,
  USDC_BASE,
  approveData,
  fakeWallet,
  forbiddenWalletCalls,
  src,
  syntheticApproval,
} from "../fixtures/g14-protected-proposal/synthetic";
import {
  RoutingCore,
  isCanaryQuote,
  type CanaryQuoteInput,
} from "../../src/adapters/routing-core";
import {
  ACROSS_V4_ABI,
  decodeAcrossCall,
} from "../../src/execution/canary/across-decoder";
import { verifyCanaryQuote } from "../../src/execution/canary/quote-verify";
import { CANARY_PINS, pinValues } from "../../src/execution/canary/pins";
import { CANARY_SCOPE } from "../../src/execution/canary/scope";
import { APPROVE_SELECTOR } from "../../src/execution/erc20";
import { agree, agreeConfigured } from "../../src/execution/canary/chain-reads";
import {
  CANARY_APPROVAL_BOUNDS,
  OWNER_CANARY_APPROVAL,
  approvalRecordProblems,
  canaryApprovalCanonical,
  canarySendCalldataProblem,
  canaryWalletRequestProblem,
  evaluateCanaryApproval,
  exactApproveCalldata,
  readCanarySendCalldata,
  type CanaryApprovalFacts,
} from "../../src/security/canary-approval";
import {
  CANARY_PIN_SET_ID,
  SimulationGate,
  assertNotKilled,
  canaryContractEntry,
  canaryFirewallDecision,
  contractRegistry,
  killPolicy,
  routeHealth,
} from "../../src/security/firewall";
import {
  CANARY_TRUSTED_CHAINS,
  TRUSTED_CHAINS,
  WalletProviderAdapter,
} from "../../src/features/wallet/adapter";
import { submitCanary } from "../../src/features/bridge/submission";
import { CANARY_RPC_POOL, RPC_ORIGINS } from "../../src/swap/server/config";
import { assertSwapEgress } from "../../src/swap/server/egress";
import { CANARY_READ_METHODS, rpc } from "../../src/swap/server/transport";
import {
  POOL_READ_METHODS,
  commonBlock,
  poolRpc,
  readOwnerBalancesPair,
  readSourcePinsPair,
  readSourceReviewPair,
} from "../../src/execution/server/canary/rpc-pool";
import {
  CANARY_LIVE_WIRING,
  canaryGateState,
  executionGateState,
} from "../../src/execution/server/gate";
import { buildRegistry } from "../../src/data/registry/chains";

// No test in this file may reach the network: the adapter's own upstream transport (node:dns + node:https) is
// replaced by doubles that refuse unless a test installs a fake provider answer.
const net = vi.hoisted(() => {
  const refuse = (): never => {
    throw new Error("NETWORK_NOT_ALLOWED_IN_UNIT_TESTS");
  };
  return {
    refuse,
    lookup: refuse as (...a: unknown[]) => unknown,
    request: refuse as (...a: unknown[]) => unknown,
  };
});
vi.mock("node:dns/promises", () => ({
  lookup: (...a: unknown[]) => net.lookup(...a),
}));
vi.mock("node:https", () => ({
  request: (...a: unknown[]) => net.request(...a),
}));

const text = (rel: string) => readFileSync(rel, "utf8");
/** Source text without comments (so prose in a header never counts as code). */
const code = (rel: string) =>
  text(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  net.lookup = net.refuse;
  net.request = net.refuse;
});

// ---------------------------------------------------------------------------------------------------------- B1
const canaryInput = (
  over: Partial<CanaryQuoteInput> = {},
): CanaryQuoteInput => ({
  source: "8453",
  destination: "42161",
  sourceAsset: USDC_BASE,
  destinationAsset: USDC_ARB,
  amount: "5000000",
  sourceAddress: SYN,
  destinationAddress: SYN,
  ...over,
});
/** What the provider returns: the real public quote of the fixture, with the extra fields a provider adds. */
const providerQuote = (
  over: Record<string, unknown> = {},
  tr: Record<string, unknown> = {},
  est: Record<string, unknown> = {},
) => ({
  id: "provider-quote-id",
  type: "lifi",
  tool: fx.tool,
  toolDetails: { key: "across", name: "Across" },
  action: { fromChainId: 8453, toChainId: 42161 },
  includedSteps: [{ untrusted: true }],
  transactionRequest: {
    ...fx.transactionRequest,
    gasPrice: "0x1",
    nonce: 7,
    ...tr,
  },
  estimate: {
    ...fx.estimate,
    toAmount: "4990000",
    feeCosts: [{ untrusted: true }],
    ...est,
  },
  ...over,
});
function core(answer: unknown = providerQuote()) {
  const reads: { path: string; params: Record<string, string> }[] = [];
  const p = new RoutingCore(async (path, params) => {
    reads.push({ path, params });
    if (path === "chains") return snapshot.chains;
    if (path === "tools") return snapshot.tools;
    if (path === "quote") {
      if (answer instanceof Error) throw answer;
      return answer;
    }
    throw new Error("NOT_REACHED");
  });
  return { p, reads };
}

describe("B1 server-only executable canary quote (routing-core, on top of A)", () => {
  it("locks every request parameter to the canary scope and takes the answer narrowly", async () => {
    vi.spyOn(Date, "now").mockReturnValue(QUOTED_AT);
    const { p, reads } = core();
    const q = await p.canaryExecutableQuote(canaryInput());
    expect(reads).toEqual([
      {
        path: "quote",
        params: {
          fromChain: "8453",
          toChain: "42161",
          fromToken: USDC_BASE,
          toToken: USDC_ARB,
          fromAmount: "5000000",
          fromAddress: SYN,
          toAddress: SYN,
          slippage: "0.005",
          order: "CHEAPEST",
          fee: "0",
          allowDestinationCall: "false",
          allowBridges: "across",
        },
      },
    ]);
    // Exactly these fields — no provider id, gas price, nonce, steps, fee list or anything else.
    expect(q).toEqual({
      tool: "across",
      quotedAt: QUOTED_AT,
      transactionRequest: {
        to: fx.transactionRequest.to,
        from: SYN,
        data: fx.transactionRequest.data,
        value: "0x0",
        chainId: 8453,
        gasLimit: fx.transactionRequest.gasLimit,
      },
      estimate: {
        approvalAddress: DIAMOND,
        toAmountMin: "4979689",
        fromAmount: "5000000",
      },
    });
    // Its one consumer accepts it: every quote check passes against the calldata itself.
    const v = verifyCanaryQuote({
      quote: q,
      owner: SYN,
      amountIn: "5000000",
      minimumOut: "4900000",
      now: NOW,
    });
    expect(v.checks.filter((c) => c.status !== "PASS")).toEqual([]);
    expect(v.ready).toBe(true);
    // An instance built with an injected read (as here) returns the checked shape but never an "adapter quote".
    expect(isCanaryQuote(q)).toBe(false);
  });
  it("provenance: only the object returned from the adapter's own upstream read is an adapter quote", async () => {
    vi.spyOn(Date, "now").mockReturnValue(QUOTED_AT);
    // FAKE provider behind the REAL upstream transport: a public address from the fake resolver and one HTTPS answer.
    const seen: { url: string; method: string }[] = [];
    net.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    net.request = (url, options, callback) => {
      seen.push({
        url: String(url),
        method: (options as { method: string }).method,
      });
      const req = {
        on: () => req,
        end: () =>
          queueMicrotask(() => {
            const res = Object.assign(new EventEmitter(), {
              statusCode: 200,
              headers: { "content-type": "application/json" },
              resume: () => undefined,
              destroy: () => undefined,
            });
            (callback as (r: unknown) => void)(res);
            res.emit("data", Buffer.from(JSON.stringify(providerQuote())));
            res.emit("end");
          }),
      };
      return req;
    };
    const q = await new RoutingCore().canaryExecutableQuote(canaryInput());
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    const url = new URL(seen[0].url);
    expect(url.origin + url.pathname).toBe("https://li.quest/v1/quote");
    expect(url.searchParams.get("allowBridges")).toBe("across");
    expect(url.searchParams.get("fee")).toBe("0");
    expect(url.searchParams.get("allowDestinationCall")).toBe("false");
    expect(url.searchParams.get("fromAddress")).toBe(SYN);
    expect(url.searchParams.get("toAddress")).toBe(SYN);
    expect(isCanaryQuote(q)).toBe(true);
    for (const forged of [
      { ...q },
      { ...q, quotedAt: q.quotedAt + 20_000 },
      structuredClone(q),
      JSON.parse(JSON.stringify(q)),
      Object.freeze({ ...q }),
      // The same payload replayed an hour later through an instance with a caller-supplied read (review 2 G4).
      await new RoutingCore(async () => providerQuote()).canaryExecutableQuote(
        canaryInput(),
      ),
      providerQuote(),
      null,
      "quote",
    ])
      expect(isCanaryQuote(forged)).toBe(false);
  });
  it("refuses every out-of-scope request before anything is read", async () => {
    const cases: [string, unknown][] = [
      ["other source chain", canaryInput({ source: "1" })],
      ["other destination chain", canaryInput({ destination: "10" })],
      ["other pay token", canaryInput({ sourceAsset: OTHER })],
      ["other receive token", canaryInput({ destinationAsset: OTHER })],
      [
        "recipient is not the sender",
        canaryInput({ destinationAddress: OTHER }),
      ],
      [
        "zero owner",
        canaryInput({
          sourceAddress: "0x" + "0".repeat(40),
          destinationAddress: "0x" + "0".repeat(40),
        }),
      ],
      [
        "malformed owner",
        canaryInput({ sourceAddress: "0x33", destinationAddress: "0x33" }),
      ],
      ["amount above 5 USDC", canaryInput({ amount: "5000001" })],
      ["amount below 1 USDC", canaryInput({ amount: "999999" })],
      ["amount not decimal", canaryInput({ amount: "0x4c4b40" })],
      ["a fee parameter", { ...canaryInput(), fee: "0.01" }],
      [
        "a destination call parameter",
        { ...canaryInput(), allowDestinationCall: "true" },
      ],
      ["another bridge", { ...canaryInput(), allowBridges: "stargate" }],
      ["a refund address", { ...canaryInput(), refundAddress: OTHER }],
      ["a missing field", { source: "8453" }],
      ["not an object", "8453"],
      ["null", null],
    ];
    for (const [name, input] of cases) {
      const { p, reads } = core();
      await expect(
        p.canaryExecutableQuote(input as CanaryQuoteInput),
        name,
      ).rejects.toThrow("CANARY_SCOPE_REJECTED");
      expect(reads, name).toEqual([]);
    }
  });
  it("refuses a foreign target, chain, sender, value, selector, spender, amount, tool or malformed field", async () => {
    const start = "0xa1f1ce43" + fx.transactionRequest.data.slice(10);
    const cases: [string, unknown][] = [
      ["foreign target", providerQuote({}, { to: OTHER })],
      ["foreign chain", providerQuote({}, { chainId: 1 })],
      ["foreign sender", providerQuote({}, { from: OTHER })],
      ["native value", providerQuote({}, { value: "0x1" })],
      ["the out-of-scope start selector", providerQuote({}, { data: start })],
      [
        "approve calldata as the main call",
        providerQuote({}, { data: approveData() }),
      ],
      ["foreign spender", providerQuote({}, {}, { approvalAddress: OTHER })],
      ["another amount", providerQuote({}, {}, { fromAmount: "4000000" })],
      ["another tool", providerQuote({ tool: "stargate" })],
      ["no transaction request", providerQuote({ transactionRequest: null })],
      ["no estimate", providerQuote({ estimate: undefined })],
      [
        "odd-length calldata",
        providerQuote({}, { data: fx.transactionRequest.data + "0" }),
      ],
      [
        "gas limit above the bound",
        providerQuote({}, { gasLimit: "0x1e8481" }),
      ],
      ["zero gas limit", providerQuote({}, { gasLimit: "0x0" })],
      ["gas limit missing", providerQuote({}, { gasLimit: undefined })],
      [
        "minimum not decimal",
        providerQuote({}, {}, { toAmountMin: "0x4bfbe9" }),
      ],
      [
        "chain id as an object",
        providerQuote({}, { chainId: { valueOf: () => 8453 } }),
      ],
      ["an array", [providerQuote()]],
      ["a string", "ok"],
    ];
    for (const [name, answer] of cases) {
      const { p } = core(answer);
      await expect(
        p.canaryExecutableQuote(canaryInput()),
        name,
      ).rejects.toThrow("CANARY_QUOTE_REJECTED");
    }
  });
  it("cannot make an old quote fresh: the time is stamped once, on a frozen object, before the request leaves", async () => {
    let now = QUOTED_AT;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let release = () => {};
    const waiting = new Promise<void>((r) => (release = r));
    const p = new RoutingCore(async () => {
      await waiting;
      return providerQuote();
    });
    const pending = p.canaryExecutableQuote(canaryInput());
    now += 20_000; // the provider took 20 s: the quote is dated from the request, not from the answer
    release();
    const q = await pending;
    expect(q.quotedAt).toBe(QUOTED_AT);
    expect(Object.isFrozen(q)).toBe(true);
    expect(Object.isFrozen(q.transactionRequest)).toBe(true);
    expect(Object.isFrozen(q.estimate)).toBe(true);
    expect(() => {
      (q as { quotedAt: number }).quotedAt = now;
    }).toThrow();
    // 31 s after the request the same object is stale for the verifier; only a NEW request gives a newer time.
    const stale = verifyCanaryQuote({
      quote: q,
      owner: SYN,
      amountIn: "5000000",
      minimumOut: "4900000",
      now: QUOTED_AT + 31_000,
    });
    expect(stale.checks.find((c) => c.id === "QUOTE_FRESH")).toMatchObject({
      status: "FAIL",
      code: "QUOTE_STALE",
    });
    expect(stale.ready).toBe(false);
  });
  it("is not cached, retried or mixed with the catalog: one provider read per call, no catalog read, A's generation untouched", async () => {
    vi.spyOn(Date, "now").mockReturnValue(QUOTED_AT);
    const { p, reads } = core();
    const catalog = await p.listNetworks();
    const before = reads.length;
    const a = await p.canaryExecutableQuote(canaryInput());
    const b = await p.canaryExecutableQuote(canaryInput());
    expect(a).not.toBe(b);
    expect(reads.slice(before).map((r) => r.path)).toEqual(["quote", "quote"]);
    expect((await p.listNetworks()).generation).toBe(catalog.generation);
    // A provider failure is passed on, never retried and never answered from an earlier quote.
    const failing = core(new Error("PROVIDER_UNAVAILABLE"));
    await expect(
      failing.p.canaryExecutableQuote(canaryInput()),
    ).rejects.toThrow("PROVIDER_UNAVAILABLE");
    expect(failing.reads).toHaveLength(1);
  });
  it("refuses to run in a browser context", async () => {
    vi.stubGlobal("window", {});
    const { p, reads } = core();
    await expect(p.canaryExecutableQuote(canaryInput())).rejects.toThrow(
      "CANARY_SCOPE_REJECTED",
    );
    expect(reads).toEqual([]);
  });
  it("leaves the public routing surface alone: no route, API or normalizer mentions it", () => {
    for (const f of [
      "src/app/api/routing/route.ts",
      "src/app/api/execution/route.ts",
      "src/routing/normalize.ts",
      "src/execution/server/deps.ts",
      "src/execution/server/review.ts",
    ])
      expect(code(f), f).not.toMatch(/canaryExecutableQuote/);
    // The read-only capability flag of the adapter is unchanged.
    expect(new RoutingCore(async () => ({})).capabilities).toEqual({
      quote: true,
      status: true,
      execution: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------- A2
describe("A2 regression (synthetic snapshot): a native symbol is a name, never a price", () => {
  it("an EVM network whose catalog gas token is ETH is named ETH; nothing about its price is added", () => {
    const reg = buildRegistry(
      [],
      [
        {
          name: "Synthetic L2",
          chainId: "990001",
          tvlUsd: 1,
          symbol: "GOV",
          gasToken: "ethereum",
        },
        {
          name: "Synthetic L1",
          chainId: "990002",
          tvlUsd: 1,
          symbol: "OWN",
          gasToken: "own-coin",
        },
        {
          name: "Synthetic unknown",
          chainId: "990003",
          tvlUsd: 1,
          symbol: "ETH",
          gasToken: null,
        },
        { name: "Synthetic bare", chainId: "990004", tvlUsd: 1 },
      ],
    );
    const native = (id: string) => reg.find((c) => c.chainId === id)?.native;
    // Exactly { symbol, name, decimals }: no price, market id or value rides along with the name.
    expect(native("990001")).toEqual({ symbol: "ETH", name: "", decimals: 18 });
    expect(native("990002")).toEqual({ symbol: "OWN", name: "", decimals: 18 });
    // A catalog row that merely CALLS its coin "ETH" keeps that text as a label; it gains nothing else either.
    expect(native("990003")).toEqual({ symbol: "ETH", name: "", decimals: 18 });
    expect(native("990004")).toEqual({ symbol: "?", name: "", decimals: 18 });
    for (const c of reg)
      expect(JSON.stringify(c)).not.toMatch(
        /price|usdValue|coingecko|gasToken/i,
      );
  });
  it("the portfolio layer prices a native balance by address evidence only, never by the symbol", () => {
    const provider = code("src/data/portfolio/provider.ts");
    const at = provider.indexOf(
      "network.nativeAsset.symbol,\n          network.nativeAsset.name,",
    );
    expect(at).toBeGreaterThan(0);
    const priceArgument = provider.slice(at, at + 420);
    // The price argument of the native holding: live/known price rows keyed by address, else undefined (unknown).
    expect(priceArgument).toMatch(/live\.get\(ZERO\)/);
    expect(priceArgument).toMatch(/known\.get\(ZERO\)\?\.price/);
    expect(priceArgument).toMatch(/undefined,/);
    expect(priceArgument.split("{ native: true")[1]).not.toMatch(/symbol/);
  });
});

// ---------------------------------------------------------------------------------------------------------- B5
const facts = (
  over: Partial<CanaryApprovalFacts> = {},
): CanaryApprovalFacts => ({
  now: NOW,
  action: "SEND",
  account: SYN,
  chainId: "8453",
  pinSet: "g14-canary-pins.2026-11-12.2",
  pinsVerified: true,
  token: USDC_BASE,
  spender: DIAMOND,
  target: DIAMOND,
  selector: SELECTOR,
  amount: "5000000",
  expectedOut: "4979689",
  gas: {
    remaining: [
      { action: "SEND", gasLimit: "670622", maxFeePerGas: "10000000" },
    ],
    spentWei: "0",
    l1FeeWei: "1000",
  },
  use: { durable: true, approveConsumed: false, sendConsumed: false },
  ...over,
});
const approveFacts = (over: Partial<CanaryApprovalFacts> = {}) =>
  facts({
    action: "APPROVE",
    target: USDC_BASE,
    selector: "0x095ea7b3",
    gas: {
      remaining: [
        { action: "APPROVE", gasLimit: "25200", maxFeePerGas: "10000000" },
        { action: "SEND", gasLimit: "670622", maxFeePerGas: "10000000" },
      ],
      spentWei: "0",
      l1FeeWei: "1000",
    },
    ...over,
  });

describe("B5 owner canary record: disarmed constant, schema, fail-closed validator", () => {
  it("is disarmed in this build and nothing in the environment or a request can arm it", () => {
    expect(OWNER_CANARY_APPROVAL).toBeNull();
    expect(approvalRecordProblems(OWNER_CANARY_APPROVAL)).toEqual([
      "NO_OWNER_APPROVED_CANARY",
    ]);
    expect(evaluateCanaryApproval(OWNER_CANARY_APPROVAL, facts())).toEqual({
      status: "DISARMED",
      reasons: ["NO_OWNER_APPROVED_CANARY"],
    });
    const saved = { ...process.env };
    try {
      for (const k of [
        "VEINED_CANARY",
        "VEINED_OWNER_CANARY_APPROVAL",
        "OWNER_CANARY_APPROVAL",
        "CANARY_APPROVAL",
        "CANARY_LIVE_WIRING",
        "VEINED_EXECUTION",
        "EXECUTION_ENABLED",
        "NEXT_PUBLIC_VEINED_CANARY",
      ])
        process.env[k] = JSON.stringify(syntheticApproval());
      expect(canaryGateState().open).toBe(false);
      expect(executionGateState("8453").open).toBe(false);
      expect(canaryGateState().reasons).toContain("NO_OWNER_APPROVED_CANARY");
    } finally {
      process.env = saved;
    }
    // The protected file has no dependency and reads no environment, request, cookie, storage or global.
    const source = code("src/security/canary-approval.ts");
    expect(source).not.toMatch(/\bimport\b|\brequire\s*\(/);
    expect(source).not.toMatch(
      /process\.|globalThis|window|document|cookie|headers|searchParams|localStorage|sessionStorage|fetch\s*\(|Date\.now/,
    );
    expect(source).toMatch(
      /export const OWNER_CANARY_APPROVAL =\s+null as Readonly<OwnerCanaryApproval> \| null;/,
    );
  });
  it("mirrors the frozen scope and pins exactly", () => {
    const B = CANARY_APPROVAL_BOUNDS;
    expect(Object.isFrozen(B)).toBe(true);
    expect(B.scope).toBe(CANARY_SCOPE.id);
    expect(B.pinSet).toBe(CANARY_PINS.set);
    expect(B.sourceChainId).toBe(CANARY_SCOPE.sourceChainId);
    expect(B.destinationChainId).toBe(CANARY_SCOPE.destinationChainId);
    expect(B.token).toBe(CANARY_PINS.usdc["8453"].address);
    expect(B.destinationToken).toBe(CANARY_PINS.usdc["42161"].address);
    expect(B.target).toBe(CANARY_PINS.diamond.address);
    expect(B.spender).toBe(CANARY_PINS.diamond.address);
    expect(B.selector).toBe(CANARY_PINS.selector);
    expect(B.approveSelector).toBe(APPROVE_SELECTOR);
    expect(BigInt(B.minAmount)).toBe(CANARY_SCOPE.minAmount);
    expect(BigInt(B.maxAmount)).toBe(CANARY_SCOPE.maxAmount);
    expect(BigInt(B.maxGasLimit)).toBe(CANARY_SCOPE.maxGasLimit);
    expect(B.feeCollector).toBe(CANARY_PINS.feeCollector.address);
    expect(B.feeCollectorSelector).toBe(CANARY_PINS.feeCollector.selector);
    expect(exactApproveCalldata(DIAMOND, 5_000_000n)).toBe(
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [DIAMOND as Hex, 5_000_000n],
      }),
    );
  });
  it("a complete synthetic record covers exactly its own approve and send steps", () => {
    const r = syntheticApproval();
    expect(approvalRecordProblems(r)).toEqual([]);
    expect(evaluateCanaryApproval(r, facts())).toEqual({
      status: "VALID",
      reasons: [],
    });
    expect(evaluateCanaryApproval(r, approveFacts())).toEqual({
      status: "VALID",
      reasons: [],
    });
    expect(
      evaluateCanaryApproval(
        r,
        facts({
          use: { durable: true, approveConsumed: true, sendConsumed: false },
        }),
      ).status,
    ).toBe("VALID");
    expect(canaryApprovalCanonical(r)).toContain('"base-arbitrum-usdc-max5"');
  });
  it("refuses every incomplete, malformed or contradictory record (the gate stays closed)", () => {
    const cases: [string, unknown, string][] = [
      ["undefined", undefined, "NO_OWNER_APPROVED_CANARY"],
      ["a string", "approved", "RECORD_SHAPE"],
      ["an array", [syntheticApproval()], "RECORD_SHAPE"],
      [
        "a class instance",
        Object.assign(Object.create({ inherited: 1 }), syntheticApproval()),
        "RECORD_SHAPE",
      ],
      [
        "an extra field",
        { ...syntheticApproval(), enabled: true },
        "RECORD_SHAPE",
      ],
      [
        "no minimum output",
        (() => {
          const r = { ...syntheticApproval() } as Record<string, unknown>;
          delete r.minimumOut;
          return r;
        })(),
        "RECORD_SHAPE",
      ],
      [
        "no gas budget",
        (() => {
          const r = { ...syntheticApproval() } as Record<string, unknown>;
          delete r.nativeGasBudgetWei;
          return r;
        })(),
        "RECORD_SHAPE",
      ],
      [
        "no deadline",
        (() => {
          const r = { ...syntheticApproval() } as Record<string, unknown>;
          delete r.notAfter;
          return r;
        })(),
        "RECORD_SHAPE",
      ],
      [
        "wrong version",
        syntheticApproval({ version: "v0" }),
        "VERSION_MISMATCH",
      ],
      [
        "bad id",
        syntheticApproval({ approvalId: "0x5a" }),
        "APPROVAL_ID_INVALID",
      ],
      ["other scope", syntheticApproval({ scope: "any" }), "SCOPE_MISMATCH"],
      [
        "old pin set .1",
        syntheticApproval({ pinSet: "g14-canary-pins.2026-11-12.1" }),
        "PIN_SET_MISMATCH",
      ],
      [
        "zero account",
        syntheticApproval({ account: "0x" + "0".repeat(40) }),
        "ACCOUNT_INVALID",
      ],
      [
        "ENS name as account",
        syntheticApproval({ account: "owner.eth" }),
        "ACCOUNT_INVALID",
      ],
      [
        "other source chain",
        syntheticApproval({ sourceChainId: "1" }),
        "CHAIN_MISMATCH",
      ],
      [
        "other destination chain",
        syntheticApproval({ destinationChainId: "10" }),
        "CHAIN_MISMATCH",
      ],
      ["other token", syntheticApproval({ token: OTHER }), "TOKEN_MISMATCH"],
      [
        "other destination token",
        syntheticApproval({ destinationToken: OTHER }),
        "TOKEN_MISMATCH",
      ],
      ["other target", syntheticApproval({ target: OTHER }), "TARGET_MISMATCH"],
      [
        "other spender",
        syntheticApproval({ spender: OTHER }),
        "SPENDER_MISMATCH",
      ],
      [
        "the start selector",
        syntheticApproval({ selector: "0xa1f1ce43" }),
        "SELECTOR_MISMATCH",
      ],
      [
        "cap above 5 USDC",
        syntheticApproval({ maxAmount: "5000001" }),
        "AMOUNT_POLICY_INVALID",
      ],
      [
        "exact above the cap",
        syntheticApproval({ maxAmount: "4000000" }),
        "AMOUNT_POLICY_INVALID",
      ],
      [
        "exact below 1 USDC",
        syntheticApproval({ exactAmount: "999999", minimumOut: "900000" }),
        "AMOUNT_POLICY_INVALID",
      ],
      [
        "exact as a number",
        syntheticApproval({ exactAmount: 5000000 }),
        "AMOUNT_POLICY_INVALID",
      ],
      [
        "minimum above the amount sent",
        syntheticApproval({ minimumOut: "5000001" }),
        "MINIMUM_OUT_INVALID",
      ],
      [
        "minimum zero",
        syntheticApproval({ minimumOut: "0" }),
        "MINIMUM_OUT_INVALID",
      ],
      [
        "minimum as a percentage text",
        syntheticApproval({ minimumOut: "98%" }),
        "MINIMUM_OUT_INVALID",
      ],
      [
        "budget zero",
        syntheticApproval({ nativeGasBudgetWei: "0" }),
        "GAS_BUDGET_INVALID",
      ],
      [
        "budget as a gas limit number",
        syntheticApproval({ nativeGasBudgetWei: 2000000 }),
        "GAS_BUDGET_INVALID",
      ],
      [
        "window longer than the 24 h ceiling",
        syntheticApproval({ notAfter: QUOTED_AT - 60_000 + 86_400_001 }),
        "VALIDITY_INVALID",
      ],
      [
        "window reversed",
        syntheticApproval({ notAfter: QUOTED_AT - 120_000 }),
        "VALIDITY_INVALID",
      ],
      [
        "deadline as text",
        syntheticApproval({ notAfter: "2026-12-01" }),
        "VALIDITY_INVALID",
      ],
      [
        "not single use",
        syntheticApproval({ singleUse: false }),
        "SINGLE_USE_REQUIRED",
      ],
      [
        "allowance cleanup included",
        syntheticApproval({ allowanceCleanup: "INCLUDED" }),
        "ALLOWANCE_CLEANUP_POLICY_INVALID",
      ],
    ];
    for (const [name, record, reason] of cases) {
      expect(approvalRecordProblems(record), name).toContain(reason);
      const d = evaluateCanaryApproval(record, facts());
      expect(d.status, name).not.toBe("VALID");
      expect(() => canaryApprovalCanonical(record), name).toThrow(
        "CANARY_APPROVAL_INVALID",
      );
    }
  });
  it("G14-AUDIT-03: 5 USDC needs at least 4.90 USDC; the general 3% bound never relaxes it", () => {
    const r = syntheticApproval(); // 5_000_000 in, 4_900_000 minimum
    const out = (expectedOut: string) =>
      evaluateCanaryApproval(r, facts({ expectedOut }));
    expect(out("4899999")).toEqual({
      status: "DENIED",
      reasons: ["OUTPUT_BELOW_OWNER_MINIMUM"],
    });
    expect(out("4900000")).toEqual({ status: "VALID", reasons: [] });
    // 4.85 USDC is inside the scope's 300 bps cost bound (5 USDC x 0.97) and is still refused by this record.
    expect((5_000_000n - 4_850_000n) * 10_000n).toBeLessThanOrEqual(
      5_000_000n * BigInt(CANARY_SCOPE.maxCostBps),
    );
    expect(out("4850000")).toEqual({
      status: "DENIED",
      reasons: ["OUTPUT_BELOW_OWNER_MINIMUM"],
    });
    expect(out("5000001").reasons).toEqual(["OUTPUT_ABOVE_INPUT"]);
    for (const unknown of [null, "", "4.9", "0x4ac4a0"])
      expect(out(unknown as string).reasons).toEqual(["OUTPUT_UNKNOWN"]);
    // No proportional minimum for another amount: 4 USDC (above 4 x 0.98) is simply not the record's amount.
    expect(
      evaluateCanaryApproval(
        r,
        facts({ amount: "4000000", expectedOut: "3990000" }),
      ).reasons,
    ).toEqual(["AMOUNT_NOT_EXACT", "OUTPUT_BELOW_OWNER_MINIMUM"]);
  });
  it("binds the native gas budget in wei: a gas limit is not a budget", () => {
    const r = syntheticApproval(); // budget 1e13 wei
    const gas = (g: CanaryApprovalFacts["gas"], f = facts) =>
      evaluateCanaryApproval(r, f({ gas: g })).reasons;
    // (670622 x 1e7) + 1000 = 6.7e12 <= 1e13
    expect(gas(facts().gas)).toEqual([]);
    // The same limit at a higher fee cap exceeds the budget although the limit itself is inside 2,000,000.
    expect(
      gas({
        remaining: [
          { action: "SEND", gasLimit: "670622", maxFeePerGas: "20000000" },
        ],
        spentWei: "0",
        l1FeeWei: "1000",
      }),
    ).toEqual(["GAS_BUDGET_EXCEEDED"]);
    // The L1 data fee and what the mined approval already cost count against the same budget.
    expect(
      gas({
        remaining: [
          { action: "SEND", gasLimit: "670622", maxFeePerGas: "10000000" },
        ],
        spentWei: "0",
        l1FeeWei: "4000000000000",
      }),
    ).toEqual(["GAS_BUDGET_EXCEEDED"]);
    expect(
      gas({
        remaining: [
          { action: "SEND", gasLimit: "670622", maxFeePerGas: "10000000" },
        ],
        spentWei: "4000000000000",
        l1FeeWei: "1000",
      }),
    ).toEqual(["GAS_BUDGET_EXCEEDED"]);
    // An approval step is evaluated with BOTH steps still to sign.
    expect(gas(approveFacts().gas, approveFacts)).toEqual([]);
    expect(gas(facts().gas, approveFacts)).toEqual(["GAS_BUDGET_UNPROVEN"]);
    const unproven: CanaryApprovalFacts["gas"][] = [
      null,
      { remaining: [], spentWei: "0", l1FeeWei: "1000" },
      {
        remaining: [{ action: "SEND", gasLimit: "2000001", maxFeePerGas: "1" }],
        spentWei: "0",
        l1FeeWei: "0",
      },
      {
        remaining: [{ action: "SEND", gasLimit: "0", maxFeePerGas: "1" }],
        spentWei: "0",
        l1FeeWei: "0",
      },
      {
        remaining: [{ action: "SEND", gasLimit: "670622", maxFeePerGas: "" }],
        spentWei: "0",
        l1FeeWei: "0",
      },
      {
        remaining: [
          { action: "SEND", gasLimit: "670622", maxFeePerGas: "10000000" },
        ],
        spentWei: null as unknown as string,
        l1FeeWei: "0",
      },
      {
        remaining: [
          { action: "SEND", gasLimit: "670622", maxFeePerGas: "10000000" },
        ],
        spentWei: "0",
        l1FeeWei: null as unknown as string,
      },
      {
        remaining: [
          { action: "APPROVE", gasLimit: "25200", maxFeePerGas: "10000000" },
        ],
        spentWei: "0",
        l1FeeWei: "0",
      },
    ];
    for (const g of unproven) expect(gas(g)).toEqual(["GAS_BUDGET_UNPROVEN"]);
  });
  it("denies every missing, foreign, expired, used or unknown fact", () => {
    const r = syntheticApproval();
    const cases: [string, Partial<CanaryApprovalFacts>, string][] = [
      [
        "before the window",
        { now: QUOTED_AT - 60_001 },
        "APPROVAL_NOT_YET_VALID",
      ],
      ["at the deadline", { now: QUOTED_AT + 3_600_000 }, "APPROVAL_EXPIRED"],
      ["long after", { now: QUOTED_AT + 86_400_000 }, "APPROVAL_EXPIRED"],
      ["no clock", { now: Number.NaN }, "CLOCK_UNKNOWN"],
      ["another account", { account: OTHER }, "ACCOUNT_MISMATCH"],
      ["account not proven", { account: null }, "ACCOUNT_MISMATCH"],
      ["wallet on Linea", { chainId: "59144" }, "WRONG_CHAIN"],
      ["chain not proven", { chainId: null }, "WRONG_CHAIN"],
      ["pins not verified", { pinsVerified: false }, "PINS_NOT_VERIFIED"],
      ["pins unknown", { pinsVerified: null }, "PINS_NOT_VERIFIED"],
      [
        "old pin set",
        { pinSet: "g14-canary-pins.2026-11-12.1" },
        "PINS_NOT_VERIFIED",
      ],
      ["another token", { token: OTHER }, "TOKEN_MISMATCH"],
      ["another spender", { spender: OTHER }, "SPENDER_MISMATCH"],
      ["another target", { target: OTHER }, "TARGET_MISMATCH"],
      ["the start selector", { selector: "0xa1f1ce43" }, "SELECTOR_MISMATCH"],
      [
        "approve selector on the Diamond",
        { selector: "0x095ea7b3" },
        "SELECTOR_MISMATCH",
      ],
      ["one unit more", { amount: "5000001" }, "AMOUNT_NOT_EXACT"],
      ["one unit less", { amount: "4999999" }, "AMOUNT_NOT_EXACT"],
      ["amount unknown", { amount: null }, "AMOUNT_NOT_EXACT"],
      ["no use store", { use: null }, "USE_STORE_UNPROVEN"],
      [
        "memory-only use store",
        {
          use: { durable: false, approveConsumed: false, sendConsumed: false },
        },
        "USE_STORE_UNPROVEN",
      ],
      [
        "already sent",
        { use: { durable: true, approveConsumed: true, sendConsumed: true } },
        "CANARY_ALREADY_SENT",
      ],
      [
        "send state unreadable",
        { use: { durable: true, approveConsumed: false, sendConsumed: null } },
        "USE_STATE_UNKNOWN",
      ],
      [
        "approve state unreadable",
        { use: { durable: true, approveConsumed: null, sendConsumed: false } },
        "USE_STATE_UNKNOWN",
      ],
      ["unknown action", { action: "REVOKE" as "SEND" }, "ACTION_UNKNOWN"],
    ];
    for (const [name, over, reason] of cases) {
      const d = evaluateCanaryApproval(r, facts(over));
      expect(d.status, name).toBe("DENIED");
      expect(d.reasons, name).toContain(reason);
    }
    // The approval step: the token is the target, used at most once, never the Diamond's selector.
    expect(
      evaluateCanaryApproval(r, approveFacts({ target: DIAMOND })).reasons,
    ).toContain("TARGET_MISMATCH");
    expect(
      evaluateCanaryApproval(r, approveFacts({ selector: SELECTOR })).reasons,
    ).toContain("SELECTOR_MISMATCH");
    expect(
      evaluateCanaryApproval(
        r,
        approveFacts({
          use: { durable: true, approveConsumed: true, sendConsumed: false },
        }),
      ).reasons,
    ).toContain("APPROVAL_ALREADY_USED");
    expect(
      evaluateCanaryApproval(r, undefined as unknown as CanaryApprovalFacts),
    ).toEqual({ status: "DENIED", reasons: ["FACTS_MISSING"] });
  });
  it("the wallet-side guard accepts only the two exact requests of the record", () => {
    const r = syntheticApproval();
    const approve = {
      chainId: "0x2105",
      from: SYN,
      to: USDC_BASE,
      value: "0x0",
      data: approveData(),
      gas: "0x6270",
      maxFeePerGas: "0x989680",
      maxPriorityFeePerGas: "0xf4240",
    };
    const send = {
      ...approve,
      to: DIAMOND,
      data: fx.transactionRequest.data,
      gas: "0xa3b9e",
    };
    expect(canaryWalletRequestProblem(r, approve, NOW)).toBeNull();
    expect(canaryWalletRequestProblem(r, send, NOW)).toBeNull();
    const cases: [string, Record<string, string | undefined>, string][] = [
      ["wrong chain", { ...send, chainId: "0x1" }, "WRONG_CHAIN"],
      ["another account", { ...send, from: OTHER }, "ACCOUNT_MISMATCH"],
      ["native value", { ...send, value: "0x1" }, "NATIVE_VALUE_NOT_ZERO"],
      ["another target", { ...send, to: OTHER }, "REQUEST_NOT_IN_CANARY_SCOPE"],
      [
        "the start selector",
        { ...send, data: "0xa1f1ce43" + send.data.slice(10) },
        "REQUEST_NOT_IN_CANARY_SCOPE",
      ],
      [
        "selector only",
        { ...send, data: SELECTOR },
        "REQUEST_NOT_IN_CANARY_SCOPE",
      ],
      [
        "approve to another spender",
        { ...approve, data: approveData(OTHER) },
        "REQUEST_NOT_IN_CANARY_SCOPE",
      ],
      [
        "approve one unit more",
        { ...approve, data: approveData(DIAMOND, 5_000_001n) },
        "REQUEST_NOT_IN_CANARY_SCOPE",
      ],
      [
        "unlimited approve",
        { ...approve, data: approveData(DIAMOND, 2n ** 256n - 1n) },
        "REQUEST_NOT_IN_CANARY_SCOPE",
      ],
      [
        "transfer() on USDC",
        { ...approve, data: "0xa9059cbb" + approve.data.slice(10) },
        "REQUEST_NOT_IN_CANARY_SCOPE",
      ],
      [
        "approve on another token",
        { ...approve, to: OTHER },
        "REQUEST_NOT_IN_CANARY_SCOPE",
      ],
      [
        "approve with trailing bytes",
        { ...approve, data: approve.data + "00" },
        "REQUEST_NOT_IN_CANARY_SCOPE",
      ],
      ["no gas limit", { ...send, gas: undefined }, "GAS_FIELDS_REQUIRED"],
      [
        "no fee cap",
        { ...send, maxFeePerGas: undefined },
        "GAS_FIELDS_REQUIRED",
      ],
      [
        "no tip",
        { ...send, maxPriorityFeePerGas: undefined },
        "GAS_FIELDS_REQUIRED",
      ],
      [
        "gas above the bound",
        { ...send, gas: "0x1e8481" },
        "GAS_FIELDS_OUT_OF_BOUNDS",
      ],
      [
        "tip above the cap",
        { ...send, maxPriorityFeePerGas: "0x989681" },
        "GAS_FIELDS_OUT_OF_BOUNDS",
      ],
      [
        "cost above the budget",
        { ...send, maxFeePerGas: "0x5f5e100" },
        "GAS_BUDGET_EXCEEDED",
      ],
    ];
    for (const [name, request, reason] of cases)
      expect(canaryWalletRequestProblem(r, request, NOW), name).toBe(reason);
    expect(canaryWalletRequestProblem(r, send, QUOTED_AT + 3_600_000)).toBe(
      "APPROVAL_EXPIRED",
    );
    expect(canaryWalletRequestProblem(r, send, QUOTED_AT - 60_001)).toBe(
      "APPROVAL_NOT_YET_VALID",
    );
    expect(canaryWalletRequestProblem(null, send, NOW)).toBe(
      "NO_OWNER_APPROVED_CANARY",
    );
    expect(
      canaryWalletRequestProblem(syntheticApproval({ scope: "x" }), send, NOW),
    ).toBe("SCOPE_MISMATCH");
  });
});

// ---------------------------------------------------------------------------------------------------------- B2
const tx = (over: Record<string, string> = {}) => ({
  chainId: "8453",
  from: SYN,
  to: DIAMOND,
  value: "0",
  data: fx.transactionRequest.data,
  ...over,
});
const pinEvidence = (over: Record<string, unknown> = {}) => ({
  set: CANARY_PIN_SET_ID,
  runtimeHash: canaryContractEntry.runtimeHash,
  implementationHash: canaryContractEntry.implementationHash,
  block: "56427300",
  observedAt: NOW - 1000,
  twoOperatorsAgree: true,
  ...over,
});

describe("B2 firewall: one scoped canary entry; the general firewall and the global kill are unchanged", () => {
  it("the general registry stays empty and the global kill stays on", () => {
    expect(contractRegistry).toEqual([]);
    expect(Object.isFrozen(contractRegistry)).toBe(true);
    expect(killPolicy.global).toBe(true);
    expect(Object.isFrozen(killPolicy)).toBe(true);
    const source = text("src/security/firewall.ts");
    // The two literals the accepted safety scans assert (scripts/verify-safety.mjs, scripts/g7-safety-scan.ts).
    expect(source).toMatch(
      /contractRegistry: readonly ContractEntry\[\] = Object\.freeze\(\[\]\)/,
    );
    expect(source).toMatch(/global: true,/);
    expect(code("src/security/firewall.ts")).not.toMatch(/global:\s*false/);
  });
  it("the entry repeats the pin set .2 and the dated live evidence exactly", () => {
    const e = canaryContractEntry;
    expect(Object.isFrozen(e)).toBe(true);
    expect(CANARY_PIN_SET_ID).toBe(CANARY_PINS.set);
    expect(livePins.pinSet).toBe(CANARY_PIN_SET_ID);
    expect(livePins.problems).toEqual([]);
    expect(e).toMatchObject({
      chainId: "8453",
      contract: CANARY_PINS.diamond.address,
      spender: CANARY_PINS.diamond.address,
      token: CANARY_PINS.usdc["8453"].address,
      selector: "0x1794958f",
      runtimeHash: CANARY_PINS.diamond.codehash,
      implementationHash: CANARY_PINS.facet.codehash,
      verifiedBlock: livePins.reads.block.number,
      verifiedAt: Date.parse(livePins.at),
      status: "ACTIVE",
    });
    expect(e.runtimeHash).toBe(livePins.reads.diamondCodehash);
    expect(e.implementationHash).toBe(livePins.reads.facetCodehash);
    expect(livePins.reads.selector).toBe(e.selector);
    expect(e.provenance).toContain(livePins.reads.facetForSelector);
    expect(e.selector).not.toBe("0xa1f1ce43");
  });
  it("an ACTIVE entry alone permits nothing: every general path stays paused", () => {
    const e = canaryContractEntry;
    expect(e.status).toBe("ACTIVE");
    expect(() => assertNotKilled(e, killPolicy)).toThrow("EXECUTION_PAUSED");
    expect(() =>
      routeHealth(e, killPolicy, e.runtimeHash, e.implementationHash),
    ).toThrow("EXECUTION_PAUSED");
    expect(() =>
      new SimulationGate().review(
        {} as never,
        tx() as never,
        e,
        (() => ({})) as never,
        {} as never,
        NOW,
      ),
    ).toThrow("EXECUTION_PAUSED");
    expect(executionGateState("8453").reasons).toEqual(
      expect.arrayContaining([
        "FIREWALL_GLOBAL_KILL",
        "NO_ACTIVE_CONTRACT_ENTRY",
      ]),
    );
  });
  it("with the disarmed owner record the canary control denies even a perfect transaction", () => {
    const d = canaryFirewallDecision({
      now: NOW,
      action: "SEND",
      transaction: tx(),
      pins: pinEvidence(),
      wallet: { account: SYN, chainId: "8453" },
      expectedOut: "4979689",
      gas: facts().gas,
      use: facts().use,
    });
    expect(d).toMatchObject({
      decision: "DENIED",
      reasons: ["OWNER_APPROVAL:NO_OWNER_APPROVED_CANARY"],
    });
    const approve = canaryFirewallDecision({
      now: NOW,
      action: "APPROVE",
      transaction: tx({ to: USDC_BASE, data: approveData() }),
      pins: pinEvidence(),
      wallet: { account: SYN, chainId: "8453" },
      expectedOut: "4979689",
      gas: approveFacts().gas,
      use: facts().use,
    });
    expect(approve.reasons).toEqual([
      "OWNER_APPROVAL:NO_OWNER_APPROVED_CANARY",
    ]);
    // Nothing at all is still a denial, never a throw or an allow.
    expect(canaryFirewallDecision(undefined as never).decision).toBe("DENIED");
    expect(canaryFirewallDecision({} as never).decision).toBe("DENIED");
  });
});

// ---------------------------------------------------------------------------------------------------------- B3
const canaryRequest = (over: Record<string, string> = {}) => ({
  chainId: "0x2105",
  from: SYN,
  to: USDC_BASE,
  value: "0x0",
  data: approveData(),
  gas: "0x6270",
  maxFeePerGas: "0x989680",
  maxPriorityFeePerGas: "0xf4240",
  ...over,
});
const baseAdapter = (p = fakeWallet()) => ({
  p,
  a: new WalletProviderAdapter(p, { address: SYN, chainId: 8453, epoch: 1 }),
});

describe("B3 wallet boundary: the canary gate name alone opens nothing", () => {
  it("with the disarmed record the adapter refuses every canary request before the wallet is asked", async () => {
    const { a, p } = baseAdapter();
    const request = canaryRequest();
    const error = await a
      .sendCanonicalTransaction(
        request,
        { ...request },
        { gate: "veined-owner-canary" },
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "CANARY_REQUEST_REFUSED",
      reason: "NO_OWNER_APPROVED_CANARY",
      beforeWalletRequest: true,
    });
    expect(p.calls).toEqual([]);
    // An invented gate name is still refused.
    await expect(
      a.sendCanonicalTransaction(
        request,
        { ...request },
        { gate: "veined-canary" as "veined-owner-canary" },
      ),
    ).rejects.toThrow("EXECUTION_GATE_REQUIRED");
    expect(p.count("eth_sendTransaction")).toBe(0);
  });
  it("Base stays outside the general registry; the canary's own registry is Base only, switch only", async () => {
    expect(TRUSTED_CHAINS[8453]).toBeUndefined();
    expect(Object.keys(TRUSTED_CHAINS).sort()).toEqual([
      "31337",
      "56",
      "612055",
    ]);
    expect(CANARY_TRUSTED_CHAINS).toEqual({ 8453: { switchable: true } });
    expect(Object.isFrozen(CANARY_TRUSTED_CHAINS)).toBe(true);
    expect(Object.isFrozen(CANARY_TRUSTED_CHAINS[8453])).toBe(true);
    expect("add" in CANARY_TRUSTED_CHAINS[8453]).toBe(false);
    const { a, p } = baseAdapter(fakeWallet({ chain: "0xe708" }));
    await expect(a.switchChain(8453)).rejects.toThrow(
      "WALLET_CHAIN_NOT_TRUSTED",
    );
    for (const id of [1, 56, 612055, 42161, 59144])
      await expect(
        a.switchChain(id, { gate: "veined-owner-canary" }),
      ).rejects.toThrow("WALLET_CHAIN_NOT_TRUSTED");
    await expect(a.addChain(8453)).rejects.toThrow("WALLET_CHAIN_NOT_TRUSTED");
    // With the disarmed record even the explicit canary-context switch to Base is refused: no canary-context
    // request of any kind reaches a wallet in this build (the armed case is in the integration suite).
    await expect(
      a.switchChain(8453, { gate: "veined-owner-canary" }),
    ).rejects.toThrow("WALLET_CHAIN_NOT_TRUSTED");
    expect(p.calls).toEqual([]);
    expect(forbiddenWalletCalls(p.calls)).toEqual([]);
  });
  it("with the disarmed record the submission boundary refuses first: no server call, no wallet call", async () => {
    const { a, p } = baseAdapter();
    // G14 follow-up F2: the server's confirmation is the adapter's own call now; "no server call" = no request of
    // the page's API at all (counted at the page fetch) and no persist callback.
    const serverCalls = pageServer.calls.length;
    pageServer.handler = vi.fn();
    const persist = vi.fn();
    const error = await submitCanary(
      a,
      {
        action: "APPROVE",
        record: "canary-test-0001",
        review: "c".repeat(64),
        transaction: canaryRequest(),
        expiresAt: Date.now() + 30_000,
        // G14 closure: the repaired preparation shape (refused first anyway: the record is disarmed).
        approvalId: "0x" + "5a".repeat(32),
        attempt: "a".repeat(32),
        quoteExpiresAt: Date.now() + 30_000,
        digest: "d".repeat(64),
      },
      {
        session: "e".repeat(64),
        gesture: { trusted: true, at: Date.now() },
        persistHash: persist,
        persistRejected: persist,
        persistLateHash: persist,
        persistNotRequested: persist,
      },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "CANARY_REQUEST_REFUSED",
      reason: "NO_OWNER_APPROVED_CANARY",
      beforeWalletRequest: true,
    });
    expect(pageServer.calls.length).toBe(serverCalls);
    expect(pageServer.handler).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(p.calls).toEqual([]);
  });
  it("adds no second wallet-send path and keeps the canonical send inside the submission boundary", () => {
    const sources = [
      "src/features/wallet/adapter.ts",
      "src/features/bridge/submission.ts",
      "src/security/canary-approval.ts",
      "src/security/firewall.ts",
      "src/execution/server/canary/engine.ts",
      "src/execution/server/canary/rpc-pool.ts",
      "src/execution/server/gate.ts",
      "src/adapters/routing-core.ts",
      "src/features/wallet-rainbow/config.ts",
    ];
    const count = (re: RegExp) =>
      sources.filter((f) => re.test(code(f))).map((f) => f);
    expect(count(/eth_sendTransaction/)).toEqual([
      "src/features/wallet/adapter.ts",
    ]);
    expect(
      code("src/features/wallet/adapter.ts").match(/eth_sendTransaction/g),
    ).toHaveLength(1);
    expect(count(/\.sendCanonicalTransaction\(/)).toEqual([
      "src/features/bridge/submission.ts",
    ]);
    // (The adapter's own frozen deny list names the refused methods; scripts/verify-safety.mjs covers that file.)
    for (const f of sources.filter(
      (f) => f !== "src/features/wallet/adapter.ts",
    ))
      expect(code(f), f).not.toMatch(
        /eth_sendRawTransaction|personal_sign|eth_signTypedData|eth_signTransaction|\beth_sign\b|wallet_sendCalls|permit2|Permit2|wallet_addEthereumChain\b(?!")/,
      );
    // The canary never reaches the add-chain or switch call from the submission path.
    expect(code("src/features/bridge/submission.ts")).not.toMatch(
      /switchChain|addChain/,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------- B4
type Rpc = { method: string; params: unknown[] };
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
/** A fake operator: answers JSON-RPC from a handler; `null` from the handler is an RPC error. */
function operators(
  handlers: Record<string, (r: Rpc) => unknown>,
  seen: { url: string; rpc: Rpc; init: RequestInit }[] = [],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const rpc = JSON.parse(String(init.body)) as Rpc;
      seen.push({ url, rpc, init });
      const h = handlers[url];
      if (!h) throw new Error("NO_SUCH_OPERATOR");
      // Like a real fetch, the double ends when the request's signal aborts.
      const result = await Promise.race([
        Promise.resolve(h(rpc)),
        new Promise<never>((_, reject) => {
          const s = init.signal;
          if (s?.aborted) reject(new Error("ABORTED"));
          s?.addEventListener("abort", () => reject(new Error("ABORTED")), {
            once: true,
          });
        }),
      ]);
      return new Response(
        JSON.stringify(
          result === null
            ? { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "x" } }
            : { jsonrpc: "2.0", id: 1, result },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return seen;
}
const blockOf = (n: number, salt = "a", time = 1_800_000_000) => ({
  number: hex(n),
  hash: "0x" + salt.repeat(64),
  timestamp: hex(time + n),
});
/** A consistent fake chain state for one operator. */
function chain(
  head: number,
  o: {
    salt?: string;
    balance?: bigint;
    allowance?: bigint;
    code?: string;
    id?: number;
  } = {},
) {
  return ({ method, params }: Rpc): unknown => {
    if (method === "eth_chainId") return hex(o.id ?? 8453);
    if (method === "eth_getBlockByNumber") {
      const tag = params[0] as string;
      const n = tag === "latest" ? head : Number(BigInt(tag));
      return n > head ? null : blockOf(n, o.salt);
    }
    if (method === "eth_getCode") return o.code ?? "0x6001";
    if (method === "eth_getStorageAt")
      return "0x" + "0".repeat(24) + "5".repeat(40);
    if (method === "eth_call") {
      const data = (params[0] as { data: string }).data;
      const sel = data.slice(0, 10);
      if (sel === "0x70a08231")
        return encodeAbiParameters(
          [{ type: "uint256" }],
          [o.balance ?? 5_000_000n],
        );
      if (sel === "0xdd62ed3e")
        return encodeAbiParameters([{ type: "uint256" }], [o.allowance ?? 0n]);
      if (
        sel === toFunctionSelector("function facetAddress(bytes4)") ||
        sel === toFunctionSelector("function SPOKEPOOL()")
      )
        return encodeAbiParameters([{ type: "address" }], [OTHER as Hex]);
      if (sel === "0x313ce567")
        return encodeAbiParameters([{ type: "uint8" }], [6]);
      if (sel === "0x95d89b41")
        return encodeAbiParameters([{ type: "string" }], ["USDC"]);
      return null;
    }
    throw new Error("UNEXPECTED_METHOD " + method);
  };
}
const signal = () => AbortSignal.timeout(5000);

describe("B4 two independent operators, read-only transport", () => {
  it("the pool names exactly two different operators per chain, with the documented origins only", () => {
    expect(CANARY_RPC_POOL).toEqual({
      "8453": [
        { operator: "allnodes-publicnode", url: BASE_A },
        { operator: "base-coinbase", url: BASE_B },
      ],
      "42161": [
        { operator: "allnodes-publicnode", url: ARB_A },
        { operator: "arbitrum-offchain-labs", url: ARB_B },
      ],
    });
    expect(Object.isFrozen(CANARY_RPC_POOL)).toBe(true);
    for (const pool of Object.values(CANARY_RPC_POOL)) {
      expect(Object.isFrozen(pool)).toBe(true);
      expect(pool.every((s) => Object.isFrozen(s))).toBe(true);
      expect(new Set(pool.map((s) => s.operator)).size).toBe(2);
    }
    // Swap's own origins are untouched: Arbitrum is not a Swap chain, Base keeps its one origin.
    expect(RPC_ORIGINS).toEqual({
      "1": "https://ethereum-rpc.publicnode.com",
      "56": "https://bsc-rpc.publicnode.com",
      "8453": BASE_A,
      solana: "https://api.mainnet-beta.solana.com",
    });
    expect(canaryGateState().reasons).not.toContain(
      "CANARY_RPC_POOL_INCOMPLETE",
    );
  });
  it("egress opens for the four exact URLs and nothing near them", () => {
    for (const url of [BASE_A, BASE_B, ARB_A, ARB_B])
      expect(assertSwapEgress(url)).toBe(new URL(url).origin);
    for (const url of [
      "https://arb1.arbitrum.io/rpc/",
      "https://arb1.arbitrum.io/",
      "https://arb1.arbitrum.io",
      "https://arb1.arbitrum.io/rpc?key=1",
      "https://arb1.arbitrum.io/rpc#x",
      "https://arb1.arbitrum.io/rpc/../admin",
      "https://ARB1.arbitrum.io/rpc",
      "http://mainnet.base.org",
      "https://mainnet.base.org/",
      "https://mainnet.base.org:8443",
      "https://user:pw@mainnet.base.org",
      "https://evil.mainnet.base.org",
      "https://mainnet.base.org.evil.example",
      "https://mainnet.base.org@evil.example",
      "https://arbitrum-one-rpc.publicnode.com/x",
      "https://arbitrum.publicnode.com",
      "https://10.0.0.1",
      "https://127.0.0.1:8545",
      "https://[::1]",
      "https://169.254.169.254/latest/meta-data",
      "wss://mainnet.base.org",
      "file:///etc/passwd",
      "not a url",
    ])
      expect(() => assertSwapEgress(url), url).toThrow("REVIEW_REQUIRED");
  });
  it("only read methods cross, as a subset of the accepted transport list; a refusal uses no network", async () => {
    const seen = operators({
      [BASE_A]: () => "0x2105",
      [BASE_B]: () => "0x2105",
    });
    for (const method of [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "eth_sign",
      "personal_sign",
      "eth_signTypedData_v4",
      "eth_estimateGas",
      "debug_traceCall",
      "admin_peers",
      "wallet_switchEthereumChain",
      "ETH_CALL",
      "",
    ])
      await expect(
        poolRpc("8453", 0, method, [], signal()),
        method,
      ).rejects.toThrow("METHOD_REFUSED");
    await expect(
      poolRpc("1" as "8453", 0, "eth_chainId", [], signal()),
    ).rejects.toThrow("SOURCE_REFUSED");
    await expect(
      poolRpc("__proto__" as "8453", 0, "eth_chainId", [], signal()),
    ).rejects.toThrow("SOURCE_REFUSED");
    await expect(
      poolRpc("8453", 2 as 0, "eth_chainId", [], signal()),
    ).rejects.toThrow("SOURCE_REFUSED");
    // G14 closure: the canary's own reads (K4) exist, but never with a parameter outside their narrow shape, and
    // never for an account other than the protected record's (disarmed here): refused before any network use.
    for (const [method, params] of [
      ["eth_getBalance", [SYN, "0x1"]],
      ["eth_getBalance", []],
      ["eth_getLogs", []],
      ["eth_getTransactionReceipt", []],
      ["eth_simulateV1", []],
      ["eth_getTransactionCount", [SYN, "latest"]],
    ] as [string, unknown[]][])
      await expect(
        poolRpc("8453", 0, method, params, signal()),
        method,
      ).rejects.toThrow(/CANARY_(PARAMS_REFUSED|ACCOUNT_NOT_APPROVED)/);
    expect(seen).toEqual([]);
    // The pool's method list IS the transport's canary list (one object, one policy).
    expect(POOL_READ_METHODS).toBe(CANARY_READ_METHODS);
    expect(POOL_READ_METHODS).toEqual([
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_getCode",
      "eth_getStorageAt",
      "eth_call",
      "eth_getBalance",
      "eth_getTransactionCount",
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
      "eth_getLogs",
      "eth_maxPriorityFeePerGas",
      "eth_simulateV1",
    ]);
    expect(Object.isFrozen(POOL_READ_METHODS)).toBe(true);
    // The general Swap reads are unchanged: the five reads the pool shares still cross rpc(); the canary-only reads
    // stay refused there (the general transport is not widened).
    for (const method of POOL_READ_METHODS.slice(0, 5))
      await expect(rpc("8453", method, [], signal())).resolves.toBe("0x2105");
    for (const method of [
      "eth_getBalance",
      "eth_getTransactionCount",
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
      "eth_getLogs",
      "eth_maxPriorityFeePerGas",
    ])
      await expect(rpc("8453", method, [], signal())).rejects.toThrow(
        "EXECUTION_CLOSED",
      );
    await expect(
      rpc("8453", "eth_sendRawTransaction", [], signal()),
    ).rejects.toThrow("EXECUTION_CLOSED");
    // The pool read goes through the same boundary: exact URL, POST, no redirect following, no cache.
    seen.length = 0;
    await poolRpc("8453", 1, "eth_chainId", [], signal());
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(BASE_B);
    expect(seen[0].init).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
    });
    expect(seen[0].rpc).toMatchObject({ method: "eth_chainId", params: [] });
  });
  it("both operators are read at one common block and reconcile; each chain against its own pair", async () => {
    operators({
      [BASE_A]: chain(1005),
      [BASE_B]: chain(1003),
      [ARB_A]: chain(900, { id: 42161, balance: 0n }),
      [ARB_B]: chain(907, { id: 42161, balance: 0n }),
    });
    const [a, b] = await commonBlock("8453", signal());
    expect(a).toEqual(b);
    expect(a?.number).toBe("1003"); // the lower head, re-read from each
    const base = await readOwnerBalancesPair("8453", SYN, signal());
    expect(base[0]?.origin).toBe(BASE_A);
    expect(base[1]?.origin).toBe(BASE_B);
    expect(base[0]?.block).toEqual(base[1]?.block);
    expect(base[0]?.values).toEqual({
      usdc: "5000000",
      native: null,
      allowance: "0",
    });
    expect(
      agreeConfigured(
        base[0],
        base[1],
        ["usdc", "allowance"],
        "8453",
        CANARY_RPC_POOL["8453"],
      ),
    ).toMatchObject({
      status: "AGREE",
      values: { usdc: "5000000", allowance: "0" },
    });
    // The native balance is NOT readable with the accepted method list: the full balance agreement stays UNKNOWN.
    expect(
      agreeConfigured(
        base[0],
        base[1],
        ["usdc", "native", "allowance"],
        "8453",
        CANARY_RPC_POOL["8453"],
      ).status,
    ).toBe("UNKNOWN");
    const arb = await readOwnerBalancesPair("42161", SYN, signal());
    expect(arb[0]?.block?.number).toBe("900");
    expect(arb[0]?.values).toEqual({ usdc: "0", native: null });
    expect(
      agreeConfigured(
        arb[0],
        arb[1],
        ["usdc"],
        "42161",
        CANARY_RPC_POOL["42161"],
      ).status,
    ).toBe("AGREE");
    // A Base read is never reconciled with an Arbitrum read or against the other chain's pool.
    expect(
      agreeConfigured(
        base[0],
        arb[1],
        ["usdc"],
        "8453",
        CANARY_RPC_POOL["8453"],
      ).status,
    ).toBe("UNKNOWN");
    expect(
      agreeConfigured(
        base[0],
        base[1],
        ["usdc"],
        "8453",
        CANARY_RPC_POOL["42161"],
      ).status,
    ).toBe("UNKNOWN");
    expect(
      agreeConfigured(
        base[0],
        base[1],
        ["usdc"],
        "42161",
        CANARY_RPC_POOL["8453"],
      ).status,
    ).toBe("UNKNOWN");
    await expect(
      readOwnerBalancesPair("8453", "0x33", signal()),
    ).rejects.toThrow("OWNER_INVALID");
  });
  it("a different hash, time, value or chain between the operators never agrees", async () => {
    const pair = async (b: Parameters<typeof chain>[1]) => {
      operators({ [BASE_A]: chain(1000), [BASE_B]: chain(1000, b) });
      const r = await readOwnerBalancesPair("8453", SYN, signal());
      return agreeConfigured(
        r[0],
        r[1],
        ["usdc", "allowance"],
        "8453",
        CANARY_RPC_POOL["8453"],
      );
    };
    expect((await pair({ salt: "b" })).status).toBe("UNKNOWN"); // same number, another hash (fork / stale node)
    expect(await pair({ balance: 4_999_999n })).toMatchObject({
      status: "DISAGREE",
      disagree: ["usdc"],
    });
    expect(await pair({ allowance: 1n })).toMatchObject({
      status: "DISAGREE",
      disagree: ["allowance"],
    });
    expect((await pair({ id: 1 })).status).toBe("UNKNOWN");
    // Same number and hash but another block time.
    operators({
      [BASE_A]: chain(1000),
      [BASE_B]: (r) =>
        r.method === "eth_getBlockByNumber"
          ? { ...blockOf(1000), timestamp: hex(1) }
          : chain(1000)(r),
    });
    const t = await readOwnerBalancesPair("8453", SYN, signal());
    expect(
      agreeConfigured(t[0], t[1], ["usdc"], "8453", CANARY_RPC_POOL["8453"]),
    ).toMatchObject({ status: "UNKNOWN", disagree: ["block"] });
  });
  it("one source failing, timing out or answering nothing is never replaced by the other", async () => {
    const dead = [
      () => {
        throw new Error("ECONNRESET");
      },
      () => null,
      () => new Promise(() => {}), // never answers: the read's own timeout ends it
      (r: Rpc) =>
        r.method === "eth_getBlockByNumber" && r.params[0] !== "latest"
          ? null
          : chain(1000)(r),
    ];
    for (const [i, bad] of dead.entries()) {
      const seen = operators({
        [BASE_A]: chain(1000),
        [BASE_B]: bad as (r: Rpc) => unknown,
      });
      const r = await readOwnerBalancesPair(
        "8453",
        SYN,
        i === 2 ? AbortSignal.timeout(300) : signal(),
      );
      const status = agreeConfigured(
        r[0],
        r[1],
        ["usdc", "allowance"],
        "8453",
        CANARY_RPC_POOL["8453"],
      ).status;
      expect(["SINGLE", "UNKNOWN"], String(i)).toContain(status);
      expect(r[1], String(i)).toBeNull();
      // No retry storm: each operator is asked at most a handful of times, the dead one never more than the live one.
      const count = (u: string) => seen.filter((s) => s.url === u).length;
      expect(count(BASE_B)).toBeLessThanOrEqual(count(BASE_A) + 1);
    }
  });
  it("independence is bound from configuration: same operator, unknown origin or a look-alike is one source", () => {
    const v = { usdc: "1" };
    const pool = CANARY_RPC_POOL["8453"];
    const ok = agreeConfigured(
      src(BASE_A, v),
      src(BASE_B, v),
      ["usdc"],
      "8453",
      pool,
    );
    expect(ok.status).toBe("AGREE");
    const cases: [string, ReturnType<typeof agreeConfigured>][] = [
      [
        "the same URL twice",
        agreeConfigured(src(BASE_A, v), src(BASE_A, v), ["usdc"], "8453", pool),
      ],
      [
        "another port of one host",
        agreeConfigured(
          src(BASE_A, v),
          src(BASE_A + ":8443", v),
          ["usdc"],
          "8453",
          pool,
        ),
      ],
      [
        "a subdomain of an operator",
        agreeConfigured(
          src(BASE_A, v),
          src("https://eu.mainnet.base.org", v),
          ["usdc"],
          "8453",
          pool,
        ),
      ],
      [
        "an origin outside the pool",
        agreeConfigured(
          src(BASE_A, v),
          src("https://rpc.example.org", v),
          ["usdc"],
          "8453",
          pool,
        ),
      ],
      [
        "a look-alike host",
        agreeConfigured(
          src(BASE_A, v),
          src("https://mainnet.base.org.example", v),
          ["usdc"],
          "8453",
          pool,
        ),
      ],
      [
        "http instead of https",
        agreeConfigured(
          src(BASE_A, v),
          src("http://mainnet.base.org", v),
          ["usdc"],
          "8453",
          pool,
        ),
      ],
      [
        "no pool",
        agreeConfigured(
          src(BASE_A, v),
          src(BASE_B, v),
          ["usdc"],
          "8453",
          undefined,
        ),
      ],
      [
        "an empty pool",
        agreeConfigured(src(BASE_A, v), src(BASE_B, v), ["usdc"], "8453", []),
      ],
      [
        "two endpoints configured for ONE operator",
        agreeConfigured(src(BASE_A, v), src(BASE_B, v), ["usdc"], "8453", [
          { operator: "same-company", url: BASE_A },
          { operator: "Same-Company", url: BASE_B },
        ]),
      ],
      [
        "an operator id missing",
        agreeConfigured(src(BASE_A, v), src(BASE_B, v), ["usdc"], "8453", [
          { operator: "", url: BASE_A },
          { operator: "x", url: BASE_B },
        ]),
      ],
      [
        "a single source",
        agreeConfigured(src(BASE_A, v), null, ["usdc"], "8453", pool),
      ],
      ["no source", agreeConfigured(null, null, ["usdc"], "8453", pool)],
      [
        "a stale second block",
        agreeConfigured(
          src(BASE_A, v),
          src(BASE_B, v, { ...BLOCK, number: "1" }),
          ["usdc"],
          "8453",
          pool,
        ),
      ],
      [
        "a missing value",
        agreeConfigured(
          src(BASE_A, v),
          src(BASE_B, { usdc: null }),
          ["usdc"],
          "8453",
          pool,
        ),
      ],
    ];
    for (const [name, r] of cases) {
      expect(r.status, name).not.toBe("AGREE");
      expect(r.values, name).toBeNull();
    }
    // The pool's two entries also differ by registrable domain, so the older heuristic agrees with the configuration.
    expect(agree(src(BASE_A, v), src(BASE_B, v), ["usdc"], "8453").status).toBe(
      "AGREE",
    );
  });
  it("source pins are read from both operators at the common block and compared value by value", async () => {
    operators({
      [BASE_A]: chain(1000, { code: "0x6001" }),
      [BASE_B]: chain(1002, { code: "0x6001" }),
    });
    const same = await readSourcePinsPair(CANARY_PINS.selector, signal());
    expect(same[0]?.block).toEqual({
      number: "1000",
      hash: "0x" + "a".repeat(64),
    });
    expect(same[0]?.block).toEqual(same[1]?.block);
    expect(same[0]?.diamondCodehash).toBe(keccak256("0x6001"));
    expect(pinValues(same[0]!)).toEqual(pinValues(same[1]!));
    operators({
      [BASE_A]: chain(1000, { code: "0x6001" }),
      [BASE_B]: chain(1000, { code: "0x6002" }),
    });
    const differ = await readSourcePinsPair(CANARY_PINS.selector, signal());
    expect(differ[0]?.diamondCodehash).not.toBe(differ[1]?.diamondCodehash);
    const sourceOf = (p: NonNullable<(typeof differ)[0]>) => ({
      origin: p.origin,
      chainId: p.chainId,
      block: p.block,
      values: pinValues(p),
    });
    expect(
      agreeConfigured(
        sourceOf(differ[0]!),
        sourceOf(differ[1]!),
        Object.keys(pinValues(differ[0]!)),
        "8453",
        CANARY_RPC_POOL["8453"],
      ).status,
    ).toBe("DISAGREE");
  });
});

// ------------------------------------------------------------------------- review 1: F4 (calldata), F6 (one block)
type AcrossArgs = [
  Record<string, unknown>,
  Record<string, unknown>[],
  Record<string, unknown>,
];
/** Re-encodes the real call with one field changed (canonical calldata, so only a semantic check can catch it). */
function mutate(f: (args: AcrossArgs) => void): string {
  const d = decodeFunctionData({
    abi: ACROSS_V4_ABI,
    data: fx.transactionRequest.data as Hex,
  });
  const args = structuredClone(d.args) as unknown as AcrossArgs;
  f(args);
  return encodeFunctionData({
    abi: ACROSS_V4_ABI,
    functionName: "swapAndStartBridgeTokensViaAcrossV4",
    args: args as never,
  });
}
const b32 = (address: string) =>
  "0x" + address.slice(2).toLowerCase().padStart(64, "0");

describe("B5 / B3 (review 1 F4): the pinned call's own arguments are read from the calldata and bound to the record", () => {
  const record = syntheticApproval();
  it("reads the real calldata exactly as the independent decoder does", () => {
    const mine = readCanarySendCalldata(fx.transactionRequest.data);
    const theirs = decodeAcrossCall(fx.transactionRequest.data)!;
    expect(mine).toEqual({
      receiver: theirs.receiver,
      acrossReceiver: theirs.across.receiver,
      refund: theirs.across.refund,
      sendingAsset: theirs.sendingAssetId,
      stepSendingAsset: theirs.steps[0].token,
      stepReceivingAsset: theirs.steps[0].receivingToken,
      acrossInputToken: theirs.across.inputToken,
      acrossOutputToken: theirs.across.outputToken,
      destinationChainId: theirs.destinationChainId,
      hasDestinationCall: theirs.hasDestinationCall,
      inputAmount: theirs.steps[0].fromAmount.toString(),
      bridgedAmount: theirs.bridgedAmount.toString(),
      effectiveOutput: theirs.effectiveOutput.toString(),
      messageLength: "0",
      multiplier: theirs.across.multiplier.toString(),
      stepCallTo: theirs.steps[0].callTo,
      stepApproveTo: theirs.steps[0].approveTo,
      stepSelector: theirs.steps[0].selector,
    });
    expect(mine).toMatchObject({
      receiver: SYN,
      refund: SYN,
      sendingAsset: USDC_BASE.toLowerCase(),
      acrossOutputToken: USDC_ARB.toLowerCase(),
      destinationChainId: "42161",
      inputAmount: "5000000",
      effectiveOutput: "4979689",
    });
    expect(
      canarySendCalldataProblem(record, fx.transactionRequest.data),
    ).toBeNull();
  });
  it("refuses a call whose arguments are not the record's transfer (canonical re-encodings of the real call)", () => {
    const cases: [string, string, string][] = [
      [
        "receiver is another account",
        mutate((a) => (a[0].receiver = OTHER)),
        "SEND_RECEIVER_NOT_OWNER",
      ],
      [
        "Across receiver is another account",
        mutate((a) => (a[2].receiverAddress = b32(OTHER))),
        "SEND_RECEIVER_NOT_OWNER",
      ],
      [
        "refund goes to another account",
        mutate((a) => (a[2].refundAddress = b32(OTHER))),
        "SEND_REFUND_NOT_OWNER",
      ],
      [
        "another token is sent",
        mutate((a) => (a[0].sendingAssetId = OTHER)),
        "SEND_TOKEN_MISMATCH",
      ],
      [
        "the step pulls another token",
        mutate((a) => (a[1][0].sendingAssetId = OTHER)),
        "SEND_TOKEN_MISMATCH",
      ],
      [
        "the step swaps into another token",
        mutate((a) => (a[1][0].receivingAssetId = OTHER)),
        "SEND_TOKEN_MISMATCH",
      ],
      [
        "Across input token differs",
        mutate((a) => (a[2].sendingAssetId = b32(OTHER))),
        "SEND_TOKEN_MISMATCH",
      ],
      [
        "another output token",
        mutate((a) => (a[2].receivingAssetId = b32(OTHER))),
        "SEND_TOKEN_MISMATCH",
      ],
      [
        "another destination chain",
        mutate((a) => (a[0].destinationChainId = 10n)),
        "SEND_DESTINATION_MISMATCH",
      ],
      [
        "a destination call flag",
        mutate((a) => (a[0].hasDestinationCall = true)),
        "SEND_DESTINATION_CALL",
      ],
      [
        "a destination message",
        mutate((a) => (a[2].message = "0x01")),
        "SEND_DESTINATION_CALL",
      ],
      [
        "the step pulls one unit more",
        mutate((a) => (a[1][0].fromAmount = 5_000_001n)),
        "SEND_AMOUNT_NOT_EXACT",
      ],
      [
        "the step pulls less",
        mutate((a) => (a[1][0].fromAmount = 4_000_000n)),
        "SEND_AMOUNT_NOT_EXACT",
      ],
      [
        "more is bridged than is sent",
        mutate((a) => (a[0].minAmount = 5_000_001n)),
        "SEND_BRIDGED_ABOVE_INPUT",
      ],
      // 4,987,500 x 0.98 = 4,887,750 < 4,900,000: inside the 300 bps scope bound, below the owner's minimum.
      [
        "a multiplier that delivers 4.887 USDC",
        mutate((a) => (a[2].outputAmountMultiplier = 980_000_000_000_000_000n)),
        "SEND_OUTPUT_BELOW_OWNER_MINIMUM",
      ],
      [
        "a multiplier above 1:1",
        mutate(
          (a) => (a[2].outputAmountMultiplier = 1_000_000_000_000_000_001n),
        ),
        "SEND_MULTIPLIER_OUT_OF_BOUNDS",
      ],
      [
        "a zero multiplier",
        mutate((a) => (a[2].outputAmountMultiplier = 0n)),
        "SEND_MULTIPLIER_OUT_OF_BOUNDS",
      ],
      // review 2 G1: one unit is bridged, the "fee" step keeps 4,999,999, and a huge multiplier dresses the output up.
      [
        "almost everything diverted, multiplier 4.9e24",
        mutate((a) => {
          a[0].minAmount = 1n;
          a[2].outputAmountMultiplier = 4_900_000n * 10n ** 18n;
        }),
        "SEND_BRIDGED_BELOW_OWNER_MINIMUM",
      ],
      [
        "bridged amount one unit below the owner's minimum",
        mutate((a) => (a[0].minAmount = 4_899_999n)),
        "SEND_BRIDGED_BELOW_OWNER_MINIMUM",
      ],
      [
        "the source step calls another contract",
        mutate((a) => (a[1][0].callTo = OTHER)),
        "SEND_STEP_NOT_PINNED_FEE",
      ],
      [
        "the source step approves another contract",
        mutate((a) => (a[1][0].approveTo = OTHER)),
        "SEND_STEP_NOT_PINNED_FEE",
      ],
      [
        "the source step carries another call",
        mutate((a) => (a[1][0].callData = "0xdeadbeef")),
        "SEND_STEP_NOT_PINNED_FEE",
      ],
      [
        "the source step carries no call",
        mutate((a) => (a[1][0].callData = "0x")),
        "SEND_CALLDATA_UNREADABLE",
      ],
      [
        "two source steps",
        mutate((a) => a[1].push(structuredClone(a[1][0]))),
        "SEND_CALLDATA_UNREADABLE",
      ],
      ["no source step", mutate((a) => a[1].pop()), "SEND_CALLDATA_UNREADABLE"],
      [
        "the start selector",
        "0xa1f1ce43" + fx.transactionRequest.data.slice(10),
        "SEND_CALLDATA_UNREADABLE",
      ],
      [
        "truncated calldata",
        fx.transactionRequest.data.slice(0, 10 + 64 * 12),
        "SEND_CALLDATA_UNREADABLE",
      ],
      [
        "selector and zero words",
        "0x1794958f" + "0".repeat(64 * 40),
        "SEND_CALLDATA_UNREADABLE",
      ],
      [
        "offsets pointing outside the data",
        "0x1794958f" + "f".repeat(64 * 3) + "0".repeat(64 * 40),
        "SEND_CALLDATA_UNREADABLE",
      ],
    ];
    for (const [name, data, reason] of cases) {
      expect(canarySendCalldataProblem(record, data), name).toBe(reason);
      // ... and therefore the wallet-side guard refuses the whole request.
      expect(
        canaryWalletRequestProblem(
          record,
          {
            chainId: "0x2105",
            from: SYN,
            to: DIAMOND,
            value: "0x0",
            data,
            gas: "0xa3b9e",
            maxFeePerGas: "0x989680",
            maxPriorityFeePerGas: "0xf4240",
          },
          NOW,
        ),
        name,
      ).not.toBeNull();
    }
    // The owner's minimum is the record's: the same real calldata is refused by a record asking for one unit more.
    expect(
      canarySendCalldataProblem(
        syntheticApproval({ minimumOut: "4979690" }),
        fx.transactionRequest.data,
      ),
    ).toBe("SEND_OUTPUT_BELOW_OWNER_MINIMUM");
    expect(
      canarySendCalldataProblem(
        syntheticApproval({ account: OTHER }),
        fx.transactionRequest.data,
      ),
    ).toBe("SEND_RECEIVER_NOT_OWNER");
  });
  it("follows the offsets like the contract's decoder: a benign copy at the usual place does not hide a relocated struct", () => {
    // Non-canonical encoding: the head's first offset is redirected to a second BridgeData appended at the end whose
    // receiver is another account, while the original (owner) BridgeData still sits at the canonical position.
    const args = fx.transactionRequest.data.slice(10);
    const words = args.match(/.{64}/g)!;
    const bdOffset = Number(BigInt("0x" + words[0])) / 32;
    const sdOffset = Number(BigInt("0x" + words[1])) / 32;
    // BridgeData occupies the words from its offset up to the SwapData offset (head + its two strings).
    const copy = words.slice(bdOffset, sdOffset);
    copy[5] = OTHER.slice(2).toLowerCase().padStart(64, "0"); // receiver
    const relocated = [...words, ...copy];
    relocated[0] = (BigInt(words.length) * 32n).toString(16).padStart(64, "0");
    const data = "0x1794958f" + relocated.join("");
    // The contract's ABI decoder (viem follows the same rules) reads the relocated struct ...
    const seen = decodeFunctionData({ abi: ACROSS_V4_ABI, data: data as Hex });
    expect(
      (
        (seen.args as unknown as AcrossArgs)[0].receiver as string
      ).toLowerCase(),
    ).toBe(OTHER);
    // ... and so does the guard: it reads what will execute, not what sits at the usual position.
    expect(readCanarySendCalldata(data)?.receiver).toBe(OTHER);
    expect(canarySendCalldataProblem(record, data)).toBe(
      "SEND_RECEIVER_NOT_OWNER",
    );
    // (The server's independent decoder additionally refuses any non-canonical encoding outright.)
    expect(decodeAcrossCall(data)).toBeNull();
  });
});

describe("B4 (review 1 F6): pins, balance and allowance of one review are read at ONE common block", () => {
  it("readSourceReviewPair hands the engine pins and balances with the same block number and hash", async () => {
    let head = 2000;
    // The chain advances between requests, as a 2-second chain does.
    const moving =
      (lag: number) =>
      (r: Rpc): unknown => {
        if (r.method === "eth_getBlockByNumber" && r.params[0] === "latest")
          head += 1;
        return chain(head - lag)(r);
      };
    operators({ [BASE_A]: moving(0), [BASE_B]: moving(2) });
    const review = await readSourceReviewPair(
      SYN,
      CANARY_PINS.selector,
      signal(),
    );
    expect(review.blocks[0]).toEqual(review.blocks[1]);
    const at = {
      number: review.blocks[0]!.number,
      hash: review.blocks[0]!.hash,
    };
    for (const p of review.pins) expect(p?.block).toEqual(at);
    for (const b of review.balances)
      expect({ number: b?.block?.number, hash: b?.block?.hash }).toEqual(at);
    expect(review.balances[0]?.block?.timestamp).toBe(
      review.blocks[0]!.timestamp,
    );
    // Two separately chosen blocks would differ while the chain moves — which is why the review reads once.
    const pinsAlone = await readSourcePinsPair(CANARY_PINS.selector, signal());
    const balancesAlone = await readOwnerBalancesPair("8453", SYN, signal());
    expect(pinsAlone[0]?.block?.number).not.toBe(
      balancesAlone[0]?.block?.number,
    );
    await expect(
      readSourceReviewPair("0x33", CANARY_PINS.selector, signal()),
    ).rejects.toThrow("OWNER_INVALID");
  });
});

// ------------------------------------------------------------------------------------------- gates and the API
describe("the canary gate and the application stay CLOSED in this build", () => {
  it("the separate canary gate is closed, and it never changes the general gate", () => {
    expect(CANARY_LIVE_WIRING).toBe(false);
    const g = canaryGateState();
    expect(g).toMatchObject({
      state: "CLOSED",
      open: false,
      scope: "base-arbitrum-usdc-max5",
      pinSet: "g14-canary-pins.2026-11-12.2",
      platformFeeBps: 0,
    });
    expect(g.reasons).toEqual(["NO_OWNER_APPROVED_CANARY", "CANARY_NOT_WIRED"]);
    // Facts cannot stand in for the record.
    expect(
      canaryGateState({
        step: {
          now: NOW,
          action: "SEND",
          transaction: tx(),
          pins: pinEvidence(),
          wallet: { account: SYN, chainId: "8453" },
          expectedOut: "4979689",
          gas: facts().gas,
          use: facts().use,
        },
        operatorsConfigured: true,
        quoteFromAdapter: true,
      }).reasons,
    ).toEqual(["NO_OWNER_APPROVED_CANARY", "CANARY_NOT_WIRED"]);
    expect(executionGateState("8453")).toMatchObject({
      state: "CLOSED",
      open: false,
    });
    expect(executionGateState("8453").reasons).toEqual([
      "G5_GLOBAL_EXECUTION_DISABLED",
      "ROUTING_WRITE_DISABLED",
      "SWAP_EXECUTION_CLOSED",
      "FIREWALL_GLOBAL_KILL",
      "NO_ACTIVE_CONTRACT_ENTRY",
      "WALLET_CHAIN_NOT_TRUSTED",
      "NO_OWNER_APPROVED_CANARY",
    ]);
  });
  it("G14 closure: the application reaches the canary write path only through the one runtime, refused while closed", () => {
    // The API still names authorize / prepare / send as write actions, has no engine, quote or pool of its own, and
    // refuses every canary signing-path action with WRITE_DISABLED before the runtime while not armed.
    const route = code("src/app/api/execution/route.ts");
    expect(route).toMatch(/"authorize",\s*"prepare",/);
    expect(route).not.toMatch(
      /CanaryEngine|submitCanary|canaryGateState|canaryExecutableQuote|rpc-pool/,
    );
    expect(route).toMatch(
      /if \(!armed\.armed\) \{[\s\S]*?WRITE_DISABLED[\s\S]*?403\);\s*\}\s*let rt: ReturnType<typeof canaryRuntime>;\s*try \{\s*rt = canaryRuntime\(\);/,
    );
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          const c = code(p);
          if (
            /submitCanary\s*\(|new CanaryEngine\(|canaryExecutableQuote\s*\(|guardConnectChain\s*\(|readOwnerBalancesPair\s*\(|readSourcePinsPair\s*\(|readSourceReviewPair\s*\(|readDestinationPinsPair\s*\(|(?<![.\w])isCanaryQuote\s*\(|canaryFirewallDecision\s*\(|canaryGateState\s*\(/.test(
              c,
            )
          )
            importers.push(p);
        }
      }
    };
    walk("src");
    // Only the definitions themselves: no caller anywhere in src/.
    expect(importers.sort()).toEqual([
      "src/adapters/routing-core.ts",
      // G14 closure: the review panel — it calls submitCanary only from a step button that exists only while the
      // server reports the canary armed (never in this build).
      "src/components/execution-review.tsx",
      // engine.ts asks the routing adapter whether a reviewed quote is its own (B1 provenance, review 2 G4); the
      // engine itself is a library with no caller in src/.
      "src/execution/server/canary/engine.ts",
      "src/execution/server/canary/rpc-pool.ts",
      // G14 closure: THE runtime (the one composition of engine, gate, store, pool, quote and Guardian).
      "src/execution/server/canary/runtime.ts",
      // gate.ts defines canaryGateState and is the one caller of the firewall's canary control (review 1 F5).
      "src/execution/server/gate.ts",
      "src/features/bridge/submission.ts",
      "src/features/wallet-rainbow/config.ts",
      // G14 closure (C): the wallet layer applies the connect-chain guard once.
      "src/features/wallet-rainbow/layer.tsx",
      "src/security/firewall.ts",
    ]);
    // ... and that one call is inside canaryGateState, which itself has no caller in src/.
    expect(
      code("src/execution/server/gate.ts").match(
        /canaryFirewallDecision\s*\(/g,
      ),
    ).toHaveLength(1);
  });
});

// ---- C (W-2) ----
// Appended by the C patch. The wrap is tested here with wagmi's REAL injected connector and connect action over an
// in-memory wallet double on Linea; see the file header of src/features/wallet-rainbow/config.ts for the root cause.
const { afterAll, beforeAll } = await import("vitest");
describe("C (W-2): connecting never passes a chain to the connector", () => {
  type Call = { method: string; params?: unknown };
  const LINEA = "0xe708";
  function lineaWallet(start = LINEA) {
    let chainId = start;
    const calls: Call[] = [];
    const listeners: Record<string, ((v: unknown) => void)[]> = {};
    return {
      calls,
      get chainId() {
        return chainId;
      },
      listeners,
      async request({ method, params }: Call) {
        calls.push({ method, params });
        if (method === "eth_requestAccounts" || method === "eth_accounts")
          return [SYN];
        if (method === "eth_chainId") return chainId;
        if (method === "wallet_switchEthereumChain") {
          chainId = (params as { chainId: string }[])[0].chainId;
          (listeners.chainChanged ?? []).forEach((fn) => fn(chainId));
          return null;
        }
        throw Object.assign(new Error("unsupported " + method), { code: 4200 });
      },
      on(event: string, fn: (v: unknown) => void) {
        (listeners[event] ??= []).push(fn);
      },
      removeListener(event: string, fn: (v: unknown) => void) {
        listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
      },
    };
  }
  const switches = (calls: Call[]) =>
    calls.filter((c) => c.method === "wallet_switchEthereumChain");
  const nothingElse = (calls: Call[]) =>
    calls.filter((c) =>
      /addEthereumChain|sign|sendTransaction|sendRaw|sendCalls/i.test(c.method),
    );

  beforeAll(() => {
    // wagmi's injected connector only looks for a provider when a window exists.
    vi.stubGlobal("window", {});
  });
  afterAll(() => vi.unstubAllGlobals());

  async function setup(wallet: ReturnType<typeof lineaWallet>) {
    vi.stubGlobal("window", {});
    const { createConfig } = await import("wagmi");
    const { injected } = await import("wagmi/connectors");
    const actions = await import("wagmi/actions");
    const rainbow = await import("../../src/features/wallet-rainbow/config");
    const connectorFn = () =>
      injected({
        target: {
          id: "test.wallet",
          name: "Test Wallet",
          provider: wallet as never,
        },
      });
    const config = createConfig({
      chains: rainbow.RAINBOW_CHAINS,
      connectors: [connectorFn()],
      multiInjectedProviderDiscovery: false,
      transports: rainbow.refusingTransports(rainbow.RAINBOW_CHAINS),
      storage: null,
      ssr: false,
    });
    return { config, actions, rainbow, connectorFn };
  }

  it("control: without the wrap, RainbowKit's chainId makes wagmi ask the wallet to switch (W-2 reproduced)", async () => {
    const wallet = lineaWallet();
    const { config, actions } = await setup(wallet);
    // What RainbowKit 2.2.10 does when the wallet's chain is not in its list: chains[0] = Ethereum (1).
    const r = await actions.connect(config, {
      connector: config.connectors[0],
      chainId: 1,
    });
    expect(switches(wallet.calls)).toEqual([
      { method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] },
    ]);
    expect(r.chainId).toBe(1);
    await actions.disconnect(config);
  });
  it("RK-11 at the library boundary: on Linea 0xe708 the wrapped connector connects with zero switch, add, sign or send requests", async () => {
    const wallet = lineaWallet();
    const { config, actions, rainbow } = await setup(wallet);
    const stop = rainbow.guardConnectChain(config);
    const connector = config.connectors[0];
    const identity = {
      uid: connector.uid,
      id: connector.id,
      name: connector.name,
      emitter: connector.emitter,
    };
    const others = Object.fromEntries(
      Object.entries(connector).filter(
        ([k, v]) => k !== "connect" && typeof v === "function",
      ),
    );
    const r = await actions.connect(config, { connector, chainId: 1 });
    expect(switches(wallet.calls)).toEqual([]);
    expect(nothingElse(wallet.calls)).toEqual([]);
    // The unsupported network is reported as it is — the wallet was not moved.
    expect(r.chainId).toBe(59144);
    expect(wallet.chainId).toBe(LINEA);
    expect(actions.getAccount(config)).toMatchObject({
      status: "connected",
      chainId: 59144,
    });
    expect(r.accounts.map((a) => a.toLowerCase())).toEqual([SYN]);
    // Identity, every other method and the event subscriptions are untouched.
    expect({
      uid: connector.uid,
      id: connector.id,
      name: connector.name,
      emitter: connector.emitter,
    }).toEqual(identity);
    for (const [k, fn] of Object.entries(others))
      expect((connector as Record<string, unknown>)[k], k).toBe(fn);
    expect(wallet.listeners.chainChanged?.length ?? 0).toBeGreaterThan(0);
    expect(wallet.listeners.accountsChanged?.length ?? 0).toBeGreaterThan(0);
    // A network change in the wallet AFTER connecting is still observed (RK-2 behaviour is unchanged).
    wallet.listeners.chainChanged.forEach((fn) => fn("0xa4b1"));
    expect(actions.getAccount(config).chainId).toBe(42161);
    // Disconnect and reconnect: still no switch request.
    await actions.disconnect(config);
    expect(actions.getAccount(config).status).toBe("disconnected");
    await actions.connect(config, { connector, chainId: 8453 });
    expect(switches(wallet.calls)).toEqual([]);
    expect(nothingElse(wallet.calls)).toEqual([]);
    await actions.disconnect(config);
    stop();
  });
  it("the spread copy RainbowKit hands to connectAsync carries the wrap and keeps its own `this`", async () => {
    const wallet = lineaWallet();
    const { config, actions, rainbow } = await setup(wallet);
    rainbow.guardConnectChain(config);
    // RainbowKit: defaultConnectors = connectors.map((connector) => ({ ...connector, ...connector.rkDetails })).
    const copy = { ...config.connectors[0] };
    const r = await actions.connect(config, { connector: copy, chainId: 1 });
    expect(r.chainId).toBe(59144);
    expect(switches(wallet.calls)).toEqual([]);
    await actions.disconnect(config, { connector: copy });
  });
  it("covers a connector discovered later, is idempotent, and stops when unsubscribed", async () => {
    const first = lineaWallet();
    const { config, actions, rainbow, connectorFn } = await setup(first);
    const stop = rainbow.guardConnectChain(config);
    const wrappedOnce = config.connectors[0].connect;
    rainbow.guardConnectChain(config)();
    expect(config.connectors[0].connect).toBe(wrappedOnce);
    // EIP-6963 discovery adds connectors to the store after creation.
    const late = config._internal.connectors.setup(connectorFn());
    const raw = late.connect;
    config._internal.connectors.setState((x) => [...x, late]);
    expect(late.connect).not.toBe(raw);
    const r = await actions.connect(config, { connector: late, chainId: 1 });
    expect(r.chainId).toBe(59144);
    expect(switches(first.calls)).toEqual([]);
    await actions.disconnect(config);
    stop();
    const afterStop = config._internal.connectors.setup(connectorFn());
    const untouched = afterStop.connect;
    config._internal.connectors.setState((x) => [...x, afterStop]);
    expect(afterStop.connect).toBe(untouched);
  });
  it("a rejected connection stays a rejection and can be retried; other parameters pass through unchanged", async () => {
    const { withoutConnectChainId } =
      await import("../../src/features/wallet-rainbow/config");
    const seen: unknown[] = [];
    let reject = true;
    const connector = {
      id: "x",
      marker: 7,
      async connect(
        this: { marker: number },
        parameters?: Record<string, unknown>,
      ) {
        seen.push({ marker: this.marker, parameters });
        if (reject)
          throw Object.assign(new Error("User rejected"), { code: 4001 });
        return { accounts: [SYN], chainId: 59144 };
      },
      getChainId: async () => 59144,
    };
    const before = connector.getChainId;
    const wrapped = withoutConnectChainId(connector);
    expect(wrapped).toBe(connector);
    expect(wrapped.getChainId).toBe(before);
    await expect(
      (wrapped.connect as (p?: unknown) => Promise<unknown>)({
        chainId: 1,
        isReconnecting: false,
        withCapabilities: true,
      }),
    ).rejects.toMatchObject({ code: 4001 });
    reject = false;
    await (wrapped.connect as (p?: unknown) => Promise<unknown>)({
      chainId: 1,
    });
    await (wrapped.connect as (p?: unknown) => Promise<unknown>)();
    const copy = { ...wrapped, marker: 9 };
    await (copy.connect as (p?: unknown) => Promise<unknown>)({
      chainId: 8453,
      isReconnecting: true,
    });
    expect(seen).toEqual([
      {
        marker: 7,
        parameters: { isReconnecting: false, withCapabilities: true },
      },
      { marker: 7, parameters: {} },
      { marker: 7, parameters: undefined },
      { marker: 9, parameters: { isReconnecting: true } },
    ]);
    expect(() => withoutConnectChainId({} as never)).toThrow(
      "CONNECTOR_INVALID",
    );
    expect(() => withoutConnectChainId(null as never)).toThrow(
      "CONNECTOR_INVALID",
    );
  });
  it("G14 closure: the wallet layer applies it once, at module scope, right after createConfig (layer.tsx)", () => {
    // GOAL §4.3 authorizes the layer.tsx line: the wrap is applied to the real config's connectors before anything
    // renders, never in a render or an effect (Strict Mode / re-render cannot apply it twice); a hot reload releases
    // the previous subscription first. The browser proof is RK-11 (tests/gf1-wallet/rainbow.spec.ts).
    const layer = code("src/features/wallet-rainbow/layer.tsx");
    expect(layer.match(/guardConnectChain\(/g)).toHaveLength(1);
    expect(layer).toMatch(
      /const unguard = guardConnectChain\(wagmiConfig\);\s*if \(process\.env\.NODE_ENV !== "production"\) \{[\s\S]*?slot\.__veinedGuardConnectChain\?\.\(\);\s*slot\.__veinedGuardConnectChain = unguard;/,
    );
    expect(layer.indexOf("guardConnectChain(wagmiConfig)")).toBeGreaterThan(
      layer.indexOf("const wagmiConfig = createConfig("),
    );
    expect(layer.indexOf("guardConnectChain(wagmiConfig)")).toBeLessThan(
      layer.indexOf("function Bridge("),
    );
    expect(layer).not.toMatch(/withoutConnectChainId/);
  });
});
