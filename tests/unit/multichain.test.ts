import { describe, it, expect } from "vitest";
import {
  normalizeChains,
  normalizeTools,
  requirePair,
} from "../../src/routing/catalog";
import { validAddress } from "../../src/routing/addresses";
import { safeLogoUrl, safeSvg } from "../../src/routing/asset-security";
import {
  normalizeQuote,
  normalizeConnections,
  normalizeStatus,
} from "../../src/routing/normalize";
import {
  quoteBinding,
  reviewValid,
  compareQuotes,
  requestExecution,
  executionGate,
} from "../../src/routing/model";
import {
  fixtureCatalog,
  fixtureInput,
  fixtureQuote,
  addresses,
} from "../fixtures/routing";
import snapshot from "../../src/routing/catalog-snapshot.json" with { type: "json" };
import observedQuote from "../fixtures/routing-live-eth-base.json" with { type: "json" };
describe("M1 dynamic catalog and capability separation", () => {
  it("all current chains plus explicit custom ONE retain native identities", () => {
    const c = fixtureCatalog();
    expect(c.networks).toHaveLength(snapshot.chains.chains.length + 1);
    expect(c.networks.find((n) => n.id === "612055")?.provider).toBe(
      "otherbridge-onebridge",
    );
    expect(c.networks.find((n) => n.ecosystem === "MVM")?.id).toBe(
      "9270000000000000",
    );
    expect(new Set(c.networks.map((n) => n.id)).size).toBe(c.networks.length);
  });
  it("unknown new upstream chain is merged dynamically with neutral geometry", () => {
    const n = {
      ...snapshot.chains.chains[0],
      id: "12345",
      key: "future",
      nativeToken: {
        ...snapshot.chains.chains[0].nativeToken,
        chainId: "12345",
      },
    };
    const c = normalizeChains({ chains: [n] });
    expect(c.find((n) => n.id === "12345")?.theme.logo).toBe(
      "/networks/neutral.svg",
    );
  });
  it.each(["duplicate", "bad type", "asset chain mismatch"])(
    "rejects malformed chain metadata: %s",
    (mode) => {
      const chains = structuredClone(snapshot.chains.chains);
      if (mode === "duplicate") chains.push(chains[0]);
      else if (mode === "bad type")
        Object.assign(chains[0], { chainType: "FAKE" });
      else chains[0].nativeToken.chainId = "999";
      expect(() => normalizeChains({ chains })).toThrow();
    },
  );
  it("tools are runtime validated", () =>
    expect(() =>
      normalizeTools({ bridges: [{ key: "x" }], exchanges: [] }),
    ).toThrow());
  it.each(["612055", "56"])(
    "ONEchain composition and reverse remain closed (%s)",
    (source) =>
      expect(() =>
        requirePair(fixtureCatalog(), source, source === "56" ? "612055" : "1"),
      ).toThrow("CUSTOM_ROUTE_NOT_EXECUTABLE_G5"),
  );
  it("same chain and stale catalog are not routable", () => {
    expect(() => requirePair(fixtureCatalog(), "1", "1")).toThrow(
      "SAME_CHAIN_DISABLED",
    );
    expect(() =>
      requirePair({ ...fixtureCatalog(), stale: true }, "1", "8453"),
    ).toThrow("STALE_CATALOG");
  });
  it("connection metadata does not grant execution", () => {
    const f = fixtureQuote();
    const c = normalizeConnections(
      {
        connections: [
          {
            fromChainId: "1",
            toChainId: "8453",
            fromTokens: [f.action.fromToken],
            toTokens: [f.action.toToken],
          },
        ],
      },
      "1",
      "8453",
    );
    expect(c[0].executable).toBe(false);
    expect(() =>
      normalizeConnections(
        {
          connections: [
            {
              fromChainId: "56",
              toChainId: "8453",
              fromTokens: [],
              toTokens: [],
            },
          ],
        },
        "1",
        "8453",
      ),
    ).toThrow();
  });
});
describe("M2 address ecosystems and safe identity assets", () => {
  it.each(Object.entries(addresses))(
    "valid native %s address rejects an EVM substitution",
    (ecosystem, address) => {
      expect(
        validAddress(
          ecosystem as keyof typeof addresses,
          address,
          ecosystem === "UTXO" ? "btc" : undefined,
        ),
      ).toBe(true);
      if (ecosystem !== "EVM")
        expect(
          validAddress(
            ecosystem as keyof typeof addresses,
            addresses.EVM,
            "btc",
          ),
        ).toBe(false);
    },
  );
  it("Bitcoin/Tron/Stellar checksums, mixed-case EVM, Sui length fail closed", () => {
    expect(validAddress("UTXO", addresses.UTXO.slice(0, -1) + "b", "btc")).toBe(
      false,
    );
    expect(validAddress("TVM", addresses.TVM.slice(0, -1) + "x")).toBe(false);
    expect(validAddress("STL", addresses.STL.slice(0, -1) + "A")).toBe(false);
    expect(
      validAddress("EVM", "0x52908400098527886E0F7030069857D2e4169EE7"),
    ).toBe(false);
    expect(validAddress("MVM", addresses.EVM)).toBe(false);
    expect(validAddress("UTXO", addresses.UTXO, "zec")).toBe(false);
  });
  it.each([
    "http://127.0.0.1/logo.svg",
    "https://raw.githubusercontent.com.evil.test/l.svg",
    "https://user:pass@raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/x.svg",
    "https://lifinance.github.io/types/src/assets/icons/chains/x.svg?redirect=localhost",
  ])("rejects logo URL %s", (url) => expect(safeLogoUrl(url)).toBe(false));
  it("accepts official catalog source and local SVG geometry", () => {
    expect(
      safeLogoUrl(
        snapshot.chains.chains[0].id === "1"
          ? "https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg"
          : "",
      ),
    ).toBe(true);
    expect(
      safeSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#ec1272" d="M0 0h4v4z"/></svg>',
      ),
    ).toBe(true);
  });
  it.each([
    "<script>alert(1)</script>",
    "<foreignObject/>",
    '<path onclick="alert(1)"/>',
    '<use href="https://evil.test/x"/>',
    '<image href="data:image/svg+xml,xxx"/>',
    '<style>@import "https://evil.test";</style>',
    '<path fill="url(https://evil.test)"/>',
    '<path style="fill:&#106;avascript:foo"/>',
  ])("rejects active SVG payload %s", (body) =>
    expect(
      safeSvg(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`),
    ).toBe(false),
  );
  it("rejects entity/DOCTYPE and malformed markup", () => {
    expect(
      safeSvg(
        '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
      ),
    ).toBe(false);
    expect(safeSvg("<svg><path></svg>")).toBe(false);
  });
  it("every cached theme uses local logos and bounded muted badges", () => {
    for (const n of fixtureCatalog().networks) {
      expect(n.theme.logo).toMatch(/^\/networks\//);
      expect(
        n.theme.glow
          .split(" ")
          .every((v) => Number(v) >= 0 && Number(v) <= 255),
      ).toBe(true);
      expect(n.theme.primary).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
describe("M3 intent-bound quotes and closed writes", () => {
  it("actual API snapshot preserves the disclosed feeCollection protocol without authorizing an unknown tool", () => {
    const i = fixtureInput();
    const q = normalizeQuote(observedQuote, i, fixtureCatalog());
    expect(q.steps.every((s) => s.type !== "lifi")).toBe(true);
    expect(q.fees.every((f) => !/\bLI[ .-]?FI\b/i.test(f.name))).toBe(true);
    expect(q.steps.find((s) => s.type === "protocol")?.catalogBound).toBe(
      false,
    );
    expect(reviewValid(q, i, fixtureCatalog(), q.observedAt)).toBe(true);
    const hostile = structuredClone(observedQuote);
    hostile.includedSteps[0].tool = "unknown-protocol";
    expect(() => normalizeQuote(hostile, i, fixtureCatalog())).toThrow(
      "TOOL_OR_NETWORK_DISAPPEARED",
    );
  });
  it("drops transaction payloads/typed data and preserves costs/minimum/steps", () => {
    const i = fixtureInput(),
      q = normalizeQuote(fixtureQuote(i), i, fixtureCatalog());
    expect(q).not.toHaveProperty("transactionRequest");
    expect(JSON.stringify(q)).not.toContain("DEADBEEF");
    expect(q.fees).toHaveLength(2);
    expect(q.minimum).toBe("8955000");
    expect(q.requirements.reason).toBe("WRITE_DISABLED");
  });
  it.each([
    "source",
    "destination",
    "amount",
    "sourceAsset",
    "destinationAsset",
    "sourceAddress",
    "destinationAddress",
    "generation",
    "slippage",
    "preference",
    "walletRevision",
  ] as const)("binding invalidates when %s changes", (key) => {
    const c = fixtureCatalog(),
      i = fixtureInput(),
      q = normalizeQuote(fixtureQuote(i), i, c);
    const changed = {
      ...i,
      [key]: typeof i[key] === "number" ? Number(i[key]) + 1 : "changed",
    };
    expect(quoteBinding(changed)).not.toBe(q.binding);
    expect(reviewValid(q, changed, c, Date.now())).toBe(false);
  });
  it("expired/stale/refreshed/tool-disappeared quote cannot reopen review", () => {
    const c = fixtureCatalog(),
      i = fixtureInput(),
      q = normalizeQuote(fixtureQuote(i), i, c);
    expect(reviewValid(q, i, c, q.expiresAt)).toBe(false);
    expect(reviewValid(q, i, { ...c, stale: true }, q.observedAt)).toBe(false);
    expect(
      reviewValid(
        q,
        i,
        { ...c, observedAt: q.observedAt - 300001 },
        q.observedAt,
      ),
    ).toBe(false);
    expect(reviewValid(q, i, { ...c, tools: [] }, q.observedAt)).toBe(false);
  });
  it.each(["amount", "recipient", "token", "minimum", "tool"])(
    "rejects hostile provider quote field: %s",
    (field) => {
      const i = fixtureInput(),
        raw = fixtureQuote(i);
      if (field === "amount") raw.action.fromAmount = "9";
      if (field === "recipient") raw.action.toAddress = addresses.SVM;
      if (field === "token")
        raw.action.toToken = { ...raw.action.toToken, address: "wrong" };
      if (field === "minimum") raw.estimate.toAmountMin = "999999999";
      if (field === "tool") raw.tool = "removed";
      expect(() => normalizeQuote(raw, i, fixtureCatalog())).toThrow();
    },
  );
  it("comparison is descriptive and no risk score is invented", () => {
    const i = fixtureInput(),
      a = normalizeQuote(fixtureQuote(i), i, fixtureCatalog()),
      b = { ...a, id: "b", expected: "9999999" };
    expect(compareQuotes([a, b], "receive")[0].id).toBe("b");
    expect(a).not.toHaveProperty("riskScore");
  });
  it("execution is null and rejecting even under malicious environment", () => {
    expect(executionGate).toEqual({
      enabled: false,
      sign: null,
      approve: null,
      broadcast: null,
      deploy: null,
    });
    expect(() => requestExecution()).toThrow("WRITE_DISABLED");
  });
  it("destination signatures and high impact remain explicit", () => {
    const i = fixtureInput(),
      raw = { ...fixtureQuote(i), destinationAction: { type: "custom" } };
    raw.estimate.toAmountUSD = "20";
    const q = normalizeQuote(raw, i, fixtureCatalog());
    expect(q.requirements.destinationSignature).toBe(true);
    expect(q.warnings).toContain("HIGH_PRICE_IMPACT");
  });
});
describe("M5 status provenance", () => {
  it("bare DONE or unrelated transactions never become completed", () => {
    expect(
      normalizeStatus(
        { status: "DONE", substatus: "COMPLETED" },
        { source: "1", destination: "8453", hash: "a" },
      ).status,
    ).toBe("UNKNOWN");
    expect(
      normalizeStatus(
        {
          status: "DONE",
          substatus: "COMPLETED",
          sending: { chainId: "1", txHash: "other" },
          receiving: { chainId: "8453", txHash: "b" },
        },
        { source: "1", destination: "8453", hash: "a" },
      ).authoritative,
    ).toBe(false);
  });
  it.each(["COMPLETED", "PARTIAL", "REFUNDED"])(
    "fresh bound provider status preserves %s",
    (substatus) => {
      const context = { ...fixtureInput(), minimum: "1" },
        raw = fixtureQuote();
      const s = normalizeStatus(
        {
          status: "DONE",
          substatus,
          fromAddress: context.sourceAddress,
          toAddress: context.destinationAddress,
          sending: {
            chainId: "1",
            txHash: "a",
            amount: context.amount,
            token: raw.action.fromToken,
          },
          receiving: {
            chainId: substatus === "REFUNDED" ? "1" : "8453",
            txHash: "b",
            amount: "9",
            token:
              substatus === "REFUNDED"
                ? raw.action.fromToken
                : raw.action.toToken,
          },
        },
        { source: "1", destination: "8453", hash: "a", context },
        123,
      );
      expect(s.status).toBe(substatus);
      expect(s.observedAt).toBe(123);
    },
  );
});
