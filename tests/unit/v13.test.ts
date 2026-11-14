import { describe, it, expect } from "vitest";
import { normalizeActive, catalogDiff } from "../../src/catalog/model";
import {
  fixtureCatalog,
  fixtureInput,
  fixtureQuote,
} from "../fixtures/routing";
import { holding, portfolioFixture } from "../fixtures/portfolio";
import {
  identitySchema,
  normalizeHoldings,
  sortNetworks,
  sortAssets,
  portfolioStale,
  redactAddress,
  detectedValue,
} from "../../src/portfolio/model";
import { platformFee, platformFeePolicy } from "../../src/routing/fee-policy";
import { normalizeQuote } from "../../src/routing/normalize";
import { rankRoutes, routeCost, userNet } from "../../src/routing/ranking";
import {
  reviewValid,
  quoteBinding,
  requestExecution,
} from "../../src/routing/model";
import { allowedDataUrl, publicData } from "../../src/server/public-data";
import { apiGuard } from "../../src/server/api-guard";
import { boundedBody } from "../../src/server/body";
import {
  compareIntent,
  intentSchema,
  killPolicy,
  routeHealth,
  SimulationGate,
  transactionDigest,
  reviewApproval,
  futureExecution,
  contractRegistry,
  entryDigest,
  type ExpectedIntent,
  type ContractEntry,
  type PreparedTransaction,
} from "../../src/security/firewall";
import { createHash } from "node:crypto";
import { currentPrice } from "../../src/portfolio/pricing";
describe("V13 dated presentation prices", () => {
  it("missing, stale, future and disputed USD never become financial evidence", () => {
    const at = 1000000;
    expect(currentPrice([], at)).toBeNull();
    expect(
      currentPrice([{ usd: 5, observedAt: 1, source: "a" }], at),
    ).toBeNull();
    expect(
      currentPrice([{ usd: 5, observedAt: at + 1, source: "a" }], at),
    ).toBeNull();
    expect(
      currentPrice(
        [
          { usd: 5, observedAt: at, source: "a" },
          { usd: 7, observedAt: at, source: "b" },
        ],
        at,
      ),
    ).toBeNull();
    expect(currentPrice([{ usd: 0, observedAt: at, source: "a" }], at)).toBe(0);
    expect(
      currentPrice(
        [
          { usd: 5, observedAt: at, source: "a" },
          { usd: 5.1, observedAt: at, source: "b" },
        ],
        at,
      ),
    ).toBe(5);
  });
  it("allows native token sentinel without admitting a zero recipient", () => {
    const base = {
      chainId: "1",
      from: "0x1111111111111111111111111111111111111111",
      toContract: "0x2222222222222222222222222222222222222222",
      value: "1",
      calldataSelector: "0x12345678",
      inputToken: "0x0000000000000000000000000000000000000000",
      inputAmount: "1",
      outputToken: "0x3333333333333333333333333333333333333333",
      minimumOutput: "1",
      recipient: "0x1111111111111111111111111111111111111111",
      approvalSpender: null,
      approvalAmount: "0",
      platformFeeBps: 0,
      quoteId: "native-test",
      expiresAt: 1000000,
    };
    expect(intentSchema.safeParse(base).success).toBe(true);
    expect(
      intentSchema.safeParse({ ...base, recipient: base.inputToken }).success,
    ).toBe(false);
  });
});
describe("V13 active catalog", () => {
  const c = fixtureCatalog(),
    at = Date.now();
  it("positive finite mainnet only, aliases, stable unknown identity, duplicate merge, custom preservation", () => {
    const a = normalizeActive(
      [
        { name: "Ethereum", chainId: 1, tvl: 3 },
        { name: "BSC", chainId: null, tvl: 7 },
        { name: "Ethereum", chainId: 1, tvl: 8 },
        { name: "Unknown Network", chainId: null, tvl: 2 },
        { name: "Zero", tvl: 0 },
        { name: "Negative", tvl: -1 },
        { name: "Testnet", tvl: 100 },
        { name: "Devnet", tvl: 100 },
        { name: "Malformed", tvl: "4" },
      ],
      c,
      at,
    );
    expect(a.chains.map((n) => n.id)).toEqual([
      "chain:1",
      "chain:56",
      "catalog:unknown-network",
      "chain:612055",
    ]);
    expect(a.chains[2].capability.bridge).toBe("unsupported");
    expect(a.chains[3].capability.bridge).toBe("custom-gated");
    expect(a.rejected).toBe(5);
  });
  it.each([null, {}, "bad"])("reject malformed response %s", (raw) =>
    expect(() => normalizeActive(raw, c, at)).toThrow(),
  );
  it("stale routes cannot enable capabilities and diff is deterministic", () => {
    const a = normalizeActive(
        [{ name: "Ethereum", chainId: 1, tvl: 8 }],
        { ...c, stale: true },
        at,
      ),
      b = normalizeActive([{ name: "Base", chainId: 8453, tvl: 7 }], c, at);
    expect(a.stale).toBe(true);
    expect(a.chains[0].capability.bridge).toBe("unsupported");
    expect(catalogDiff(a, b)).toEqual(catalogDiff(a, b));
    expect(b.chains.some((n) => n.chainId === "612055")).toBe(true);
  });
  it("600 synthetic entries remain searchable and TVL ordered", () => {
    const a = normalizeActive(
      Array.from({ length: 600 }, (_, i) => ({
        name: `Synthetic ${i}`,
        chainId: 900000 + i,
        tvl: i + 1,
      })),
      c,
      at,
    );
    expect(a.chains).toHaveLength(601);
    expect(a.chains[0].name).toBe("Synthetic 599");
    expect(a.chains.filter((n) => n.name === "Synthetic 350")).toHaveLength(1);
  });
});
describe("V13 portfolio", () => {
  it("bigint, zero price, absent price and sanitation are independent", () => {
    const h = holding(
      "1",
      "99999999999999999999999999999999999999999999999999999999999999",
      0,
      { symbol: "<script>\u202e", name: "claim https://bad" },
    );
    const rows = normalizeHoldings([h, h]);
    expect(rows).toHaveLength(1);
    expect(rows[0].balance).toBe(h.balance);
    expect(rows[0].usd).toBe(0);
    expect(rows[0].symbol).not.toMatch(/[<>\u202e]/);
    expect(rows[0].suspicious).toBe(true);
    expect(normalizeHoldings([holding("1", "1", null)])[0].usd).toBeNull();
  });
  it("stale price is omitted, spam never increases detected value", () => {
    expect(
      normalizeHoldings([holding("1", "1", 100, { priceAt: 1 })])[0].usd,
    ).toBeNull();
    expect(detectedValue([holding("1", "1", 999, { spam: true })])).toBe(0);
  });
  it("holdings first, USD descending, source tokens first, selected identity immutable", () => {
    const result = portfolioFixture(),
      c = fixtureCatalog(),
      sorted = sortNetworks(c.networks, result);
    expect(sorted.slice(0, 3).map((n) => n.id)).toEqual(["8453", "1", "56"]);
    const native = c.networks.find((n) => n.id === "56")!.nativeAsset,
      held = result.holdings.find((h) => h.chainId === "56" && !h.native)!;
    expect(sortAssets([native, held], native.address, result)[0].address).toBe(
      held.address,
    );
    expect(c.networks[0].id).toBe("1");
  });
  it.each(["solana", "bitcoin", "sui", "tron", "stellar"])(
    "reject EVM identity substituted for %s",
    (key) =>
      expect(
        identitySchema.safeParse({
          [key]:
            key === "bitcoin"
              ? [fixtureInput().sourceAddress]
              : fixtureInput().sourceAddress,
        }).success,
      ).toBe(false),
  );
  it("privacy redaction and stale visibility", () => {
    const f = portfolioFixture();
    expect(redactAddress(fixtureInput().sourceAddress)).not.toBe(
      fixtureInput().sourceAddress,
    );
    expect(portfolioStale({ ...f, observedAt: Date.now() - 60001 })).toBe(true);
    expect(
      identitySchema.safeParse({
        evm: fixtureInput().sourceAddress,
        secret: "bad",
      }).success,
    ).toBe(false);
  });
  it("new portfolio revision invalidates financial review without selecting new token", () => {
    const c = fixtureCatalog(),
      input = { ...fixtureInput(), portfolioRevision: "a" },
      q = normalizeQuote(fixtureQuote(input), input, c);
    expect(
      reviewValid(q, { ...input, portfolioRevision: "b" }, c, Date.now()),
    ).toBe(false);
    expect(quoteBinding(input)).not.toBe(
      quoteBinding({ ...input, portfolioRevision: "b" }),
    );
  });
});
describe("V13 swap / ranking / fee", () => {
  const c = fixtureCatalog();
  it("same-chain only via explicit mode and different tokens", () => {
    const input = {
        ...fixtureInput(),
        destination: "1",
        destinationAsset: "0x4444444444444444444444444444444444444444",
        mode: "swap" as const,
      },
      raw = fixtureQuote(input);
    raw.action.toToken = {
      ...raw.action.toToken,
      address: input.destinationAsset,
    };
    expect(normalizeQuote(raw, input, c).input.mode).toBe("swap");
    expect(() => normalizeQuote(raw, { ...input, mode: "bridge" }, c)).toThrow(
      "SAME_CHAIN_DISABLED",
    );
    expect(() =>
      normalizeQuote(raw, { ...input, destinationAsset: input.sourceAsset }, c),
    ).toThrow("SAME_TOKEN_DISABLED");
  });
  it("ranking is user net, cost and time with equivalent dedupe", () => {
    const input = fixtureInput(),
      q = normalizeQuote(fixtureQuote(), input, c),
      a = {
        ...q,
        id: "a",
        expected: "100",
        minimum: "90",
        outputUsd: "30",
        duration: 90,
      },
      b = {
        ...q,
        id: "b",
        expected: "90",
        minimum: "80",
        outputUsd: "29",
        duration: 5,
        fees: [],
      };
    expect(rankRoutes([a, b], "value")[0].id).toBe("a");
    expect(rankRoutes([a, b], "cost")[0].id).toBe("b");
    expect(rankRoutes([a, b], "time")[0].id).toBe("b");
    expect(rankRoutes([a, { ...a, id: "copy" }], "value")).toHaveLength(1);
    expect(routeCost(a)).toBe(70000000000000000n);
    expect(userNet(a)).toBe(29980000000000000000n);
  });
  it("revenue metadata cannot alter rank; expired / high-impact routes excluded", () => {
    const q = normalizeQuote(fixtureQuote(), fixtureInput(), c),
      a = { ...q, id: "a", outputUsd: "30" },
      b = { ...q, id: "b", outputUsd: "29" };
    expect(
      rankRoutes(
        [
          { ...b, ...{ kickback: 999999 } },
          { ...a, ...{ revenue: 0 } },
        ],
        "value",
      )[0].id,
    ).toBe("a");
    expect(
      rankRoutes(
        [
          { ...q, expiresAt: 1 },
          { ...q, priceImpact: 0.16 },
        ],
        "value",
      ),
    ).toEqual([]);
  });
  it("unknown fees fallback to token net and single quote stays single", () => {
    const q = normalizeQuote(fixtureQuote(), fixtureInput(), c);
    expect(rankRoutes([q], "value")).toHaveLength(1);
    expect(userNet({ ...q, outputUsd: undefined })).toBeNull();
    expect(
      routeCost({ ...q, fees: [{ ...q.fees[0], usd: undefined }] }),
    ).toBeNull();
    expect(q.platformFee).toEqual({
      bps: 0,
      amount: "0",
      policy: "v13-disabled",
    });
  });
  it.each([0, 5, 10])("fee fixture %s bps integer floor", (bps) => {
    const amount = "999999999999999999999999999999999999",
      policy = {
        enabled: bps !== 0,
        bps,
        maxBps: 10,
        recipientMode:
          bps === 0 ? ("disabled" as const) : ("provider-native" as const),
      };
    expect(platformFee(amount, policy)).toBe(
      ((BigInt(amount) * BigInt(bps)) / 10000n).toString(),
    );
    expect(platformFee("1", policy)).toBe("0");
  });
  it.each([-1, 11, 1.5, Infinity])("reject fee %s", (bps) =>
    expect(() =>
      platformFee("100", {
        enabled: true,
        bps,
        maxBps: 10,
        recipientMode: "provider-native",
      }),
    ).toThrow(),
  );
  it("hostile environment cannot enable fees or write", () => {
    process.env.REAL_EXECUTION = "true";
    process.env.REAL_OTHERBRIDGE_FEE = "true";
    expect(platformFeePolicy.enabled).toBe(false);
    expect(platformFee("100000")).toBe("0");
    expect(() => requestExecution()).toThrow("WRITE_DISABLED");
    expect(() => futureExecution()).toThrow("WRITE_DISABLED");
    delete process.env.REAL_EXECUTION;
    delete process.env.REAL_OTHERBRIDGE_FEE;
  });
});
describe("V13 transaction firewall and backend adversaries", () => {
  const a = `0x${"1".repeat(40)}`,
    b = `0x${"2".repeat(40)}`,
    at = Date.now(),
    intent: ExpectedIntent = {
      chainId: "1",
      from: a,
      toContract: b,
      value: "0",
      calldataSelector: "0x12345678",
      inputToken: a,
      inputAmount: "100",
      outputToken: b,
      minimumOutput: "90",
      recipient: a,
      approvalSpender: b,
      approvalAmount: "100",
      platformFeeBps: 0,
      quoteId: "q",
      expiresAt: at + 30000,
    },
    tx: PreparedTransaction = {
      chainId: "1",
      from: a,
      to: b,
      value: "0",
      data: "0x1234567800",
    },
    entry: ContractEntry = {
      chainId: "1",
      protocol: "fixture",
      provider: "routing-core",
      contract: b,
      spender: b,
      token: a,
      selector: "0x12345678",
      runtimeHash: "hash",
      implementationHash: null,
      verifiedAt: at,
      verifiedBlock: "1",
      provenance: "SYNTHETIC_TEST_ONLY",
      status: "ACTIVE",
    };
  const decoder = () => ({
    inputToken: a,
    inputAmount: "100",
    outputToken: b,
    minimumOutput: "90",
    recipient: a,
    approvalSpender: b,
    approvalAmount: "100",
    platformFeeBps: 0 as const,
  });
  it("fails closed on incomplete decoder data and nonfinite approval deadlines", () => {
    expect(() =>
      compareIntent(intent, tx, entry, (() => ({})) as typeof decoder, at),
    ).toThrow();
    expect(() => reviewApproval("1", "1", "0", Number.NaN, at)).toThrow();
  });
  it.each(["chainId", "from", "to", "value", "data"])(
    "reject upstream tx %s mutation",
    (key) => {
      const changed = {
        ...tx,
        [key]:
          key === "chainId"
            ? "56"
            : key === "value"
              ? "1"
              : key === "data"
                ? "0xabcdef0000"
                : `0x${"3".repeat(40)}`,
      };
      expect(() =>
        compareIntent(intent, changed, entry, decoder, at),
      ).toThrow();
    },
  );
  it.each([
    "inputToken",
    "inputAmount",
    "outputToken",
    "minimumOutput",
    "recipient",
    "approvalSpender",
    "approvalAmount",
    "platformFeeBps",
  ])("reject decoded %s mutation", (key) =>
    expect(() =>
      compareIntent(
        intent,
        tx,
        entry,
        () => ({
          ...decoder(),
          [key]:
            key === "platformFeeBps"
              ? 5
              : key.includes("Amount") || key === "minimumOutput"
                ? "101"
                : `0x${"3".repeat(40)}`,
        }),
        at,
      ),
    ).toThrow(),
  );
  it("expiry, simulation failure, digest mismatch and replay fail closed", () => {
    // V1.4: the gate enforces the kill policy; simulation semantics are tested under an open policy.
    const gate = new SimulationGate({ ...killPolicy, global: false }),
      digests = compareIntent(intent, tx, entry, decoder, at),
      proof = {
        success: true,
        ...digests,
        chainId: "1",
        block: "1",
        observedAt: at,
        // V1.5: simulations bind the exact reviewed registry entry (tests/unit/v15-firewall.test.ts).
        registryDigest: entryDigest(entry),
      };
    expect(() => compareIntent(intent, tx, entry, decoder, at + 30000)).toThrow(
      "QUOTE_EXPIRED",
    );
    expect(() =>
      gate.review(intent, tx, entry, decoder, { ...proof, success: false }, at),
    ).toThrow("SIMULATION_REQUIRED");
    expect(() =>
      gate.review(
        intent,
        tx,
        entry,
        decoder,
        { ...proof, transactionDigest: "bad" },
        at,
      ),
    ).toThrow();
    expect(() =>
      new SimulationGate().review(intent, tx, entry, decoder, proof, at),
    ).toThrow("EXECUTION_PAUSED");
    expect(gate.review(intent, tx, entry, decoder, proof, at)).toEqual(digests);
    expect(() => gate.review(intent, tx, entry, decoder, proof, at)).toThrow(
      "REPLAY_REJECTED",
    );
    expect(transactionDigest(tx)).toBe(
      createHash("sha256").update(JSON.stringify(tx)).digest("hex"),
    );
    expect(
      intentSchema.safeParse({ ...intent, platformFeeBps: 5 }).success,
    ).toBe(false);
  });
  it.each(["global", "chains", "providers", "protocols", "tokens", "spenders"])(
    "kill switch %s",
    (scope) => {
      const p = {
        global: false,
        chains: [],
        providers: [],
        protocols: [],
        tokens: [],
        spenders: [],
        [scope]:
          scope === "global"
            ? true
            : [
                scope === "chains"
                  ? "1"
                  : scope === "providers"
                    ? entry.provider
                    : scope === "protocols"
                      ? entry.protocol
                      : scope === "tokens"
                        ? a
                        : b,
              ],
      };
      expect(() => routeHealth(entry, p, "hash", null)).toThrow(
        "EXECUTION_PAUSED",
      );
    },
  );
  it("runtime drift and empty registry remain closed", () => {
    expect(killPolicy.global).toBe(true);
    expect(contractRegistry).toEqual([]);
    expect(() =>
      routeHealth(entry, { ...killPolicy, global: false }, "new", null),
    ).toThrow("REVIEW_REQUIRED");
    expect(
      reviewApproval("100", "100", "99", at + 10000, at).approvalRequired,
    ).toBe(true);
    expect(() =>
      reviewApproval((2n ** 256n - 1n).toString(), "100", "0", at + 10000, at),
    ).toThrow();
  });
  it.each([
    "http://api.llama.fi/v2/chains",
    "https://127.0.0.1/",
    "https://api.llama.fi.evil/v2/chains",
    "https://user:pass@api.llama.fi/v2/chains",
    "https://api.llama.fi/v2/chains#x",
    "https://api.llama.fi:9999/v2/chains",
    "https://api.covalenthq.com/v1/../../admin",
  ])("SSRF reject %s", (url) => expect(() => allowedDataUrl(url)).toThrow());
  it("RPC write body and oversized request rejected without contacting upstream", async () => {
    await expect(
      publicData("https://ethereum-rpc.publicnode.com", {
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_sendTransaction",
          params: [],
        },
      }),
    ).rejects.toThrow("RPC_NOT_ALLOWED");
    await expect(
      boundedBody(
        new Request("http://localhost", {
          method: "POST",
          body: "x".repeat(16001),
        }),
      ),
    ).rejects.toThrow("REQUEST_TOO_LARGE");
  });
  it("same origin, content type and rate limiter fail closed", async () => {
    // V1.4: the guard is async (durable limiter interface); assertions are unchanged.
    await expect(
      apiGuard(
        new Request("http://127.0.0.1:3100", {
          headers: {
            host: "127.0.0.1:3100",
            origin: "http://evil",
            "content-type": "application/json",
          },
        }),
        "test",
      ),
    ).rejects.toThrow();
    const req = new Request("http://127.0.0.1:3100", {
      headers: {
        host: "127.0.0.1:3100",
        origin: "http://127.0.0.1:3100",
        "content-type": "application/json",
      },
    });
    await apiGuard(req, "test-rate", 1);
    await expect(apiGuard(req, "test-rate", 1)).rejects.toThrow("RATE_LIMITED");
  });
});
