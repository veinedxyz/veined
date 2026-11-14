import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import {
  encodeAbiParameters,
  encodeFunctionData,
  pad,
  toHex,
  stringToHex,
} from "viem";
import {
  buildRegistry,
  effectiveTier,
  defaultTierConfig,
} from "../../src/data/registry/chains";
import { admitRpcUrl } from "../../src/data/rpc/url-policy";
import { assertAllowed } from "../../src/data/rpc/methods";
import {
  recordFailure,
  recordSuccess,
  freshHealth,
  score,
  lagging,
  quarantined,
} from "../../src/data/rpc/health";
import { RangeController } from "../../src/data/indexer/ranges";
import { planRewind } from "../../src/data/indexer/reorg";
import {
  TRANSFER_TOPIC,
  decodeTransfer,
  decodeMetadataString,
  decodeDecimals,
  encodeAggregate3,
  balanceOfData,
  walletTopic,
} from "../../src/data/evm/erc20";
import { summarize, type ChainCoverage } from "../../src/data/core/coverage";
import {
  runScheduled,
  encodeContinuation,
  decodeContinuation,
} from "../../src/data/portfolio/scheduler";
import {
  generateKey,
  parseKey,
  verifyKey,
  verifierOf,
  randomId,
} from "../../src/data/api/keys";
import {
  PLANS,
  COST,
  billingEnabled,
  validScopes,
  planOf,
} from "../../src/data/api/plans";
import {
  MemoryRateLimiter,
  FallbackRateLimiter,
  RateLimitUnavailable,
  type RateLimiter,
} from "../../src/server/rate-limit";
import {
  derivedPrice,
  freshPrice,
  usdValue,
  unknownPrice,
} from "../../src/data/core/price";
import {
  normalizeOrigin,
  originPolicy,
  checkOrigin,
  clientKey,
} from "../../src/server/origin-policy";
import { walletPseudonym } from "../../src/data/core/privacy";
import { redactValue, metrics } from "../../src/data/observability/log";
import {
  assertNonDestructive,
  loadMigrations,
} from "../../src/data/store/migrate";
import { sanitizeText } from "../../src/data/core/sanitize";
import { dataConfig } from "../../src/data/config";
import { MULTICALL3 } from "../../src/data/evm/multicall";
import { normalizeRoutingTokens } from "../../src/data/registry/routing-tokens";
import { fixtureCatalog } from "../fixtures/routing";
const wallet = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";
const token = "0x1111111111111111111111111111111111111111";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const log = (extra: Record<string, unknown> = {}) => ({
  address: token,
  topics: [
    TRANSFER_TOPIC,
    walletTopic("0x2222222222222222222222222222222222222222"),
    walletTopic(wallet),
  ],
  data: pad(toHex(1000n)),
  blockNumber: "0x10",
  blockHash: hash(16),
  transactionHash: hash(99),
  logIndex: "0x3",
  ...extra,
});
describe("V14 registry and tiers", () => {
  const routing = fixtureCatalog().networks;
  it("normalizes catalogs into deterministic registry records without inventing EVM-ness", () => {
    const reg = buildRegistry(routing, [
      { name: "Ethereum", chainId: "1", tvlUsd: 5 },
      { name: "Some L2", chainId: "777777", tvlUsd: 3 },
      { name: "No Id Chain", chainId: null, tvlUsd: 2 },
      { name: "Ethereum", chainId: "1", tvlUsd: 9 },
    ]);
    const eth = reg.find((c) => c.chainId === "1")!;
    expect(eth.tvlUsd).toBe(9);
    expect(eth.sources).toEqual(
      expect.arrayContaining(["routing-catalog", "tvl-catalog"]),
    );
    expect(eth.canonicalId).toBe("eip155:1");
    expect(reg.find((c) => c.chainId === "777777")?.configuredTier).toBe(
      "ON_DEMAND_FUNGIBLE",
    );
    const catalogOnly = reg.find((c) => c.chainId === "catalog:no-id-chain")!;
    expect(catalogOnly.configuredTier).toBe("CATALOG_ONLY");
    expect(catalogOnly.ecosystem).toBe("UNKNOWN");
    expect(reg.map((c) => c.chainId)).toEqual(
      buildRegistry(routing, [
        { name: "Ethereum", chainId: "1", tvlUsd: 9 },
        { name: "Some L2", chainId: "777777", tvlUsd: 3 },
        { name: "No Id Chain", chainId: null, tvlUsd: 2 },
      ]).map((c) => c.chainId),
    );
  });
  it("effective tier is lowered by missing capability, never raised", () => {
    const [c] = buildRegistry(
      routing,
      [{ name: "X", chainId: "42161", tvlUsd: 1 }],
      { ...defaultTierConfig, fullIndexed: ["42161"] },
    ).filter((x) => x.chainId === "42161");
    expect(c.configuredTier).toBe("FULL_INDEXED");
    expect(
      effectiveTier(c, {
        healthyRpc: true,
        logs: true,
        tokenUniverse: true,
        indexStarted: true,
      }),
    ).toBe("FULL_INDEXED");
    expect(
      effectiveTier(c, {
        healthyRpc: true,
        logs: true,
        tokenUniverse: true,
        indexStarted: false,
      }),
    ).toBe("ON_DEMAND_FUNGIBLE");
    expect(
      effectiveTier(c, {
        healthyRpc: true,
        logs: false,
        tokenUniverse: false,
        indexStarted: false,
      }),
    ).toBe("NATIVE_ONLY");
    expect(
      effectiveTier(c, {
        healthyRpc: false,
        logs: true,
        tokenUniverse: true,
        indexStarted: true,
      }),
    ).toBe("CATALOG_ONLY");
  });
  it("routing token universe normalization sanitizes and bounds untrusted list data", () => {
    const rows = normalizeRoutingTokens(
      {
        tokens: {
          "1": [
            {
              address: token.toUpperCase().replace("0X", "0x"),
              symbol: "<script>X",
              name: "Claim www.evil.xyz",
              decimals: 18,
              priceUSD: "1.5",
            },
            { address: "bad", symbol: "Y", decimals: 99 },
          ],
        },
      },
      "1",
      1000,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("scriptX");
    expect(rows[0].suspicious).toBe(true);
    expect(rows[0].price).toEqual({
      priceUsd: "1.5",
      observedAt: 1000,
      confidence: "derived",
      method: "routing-token-list",
    });
  });
});
describe("V14 RPC admission and method policy", () => {
  it.each([
    ["https://rpc.example-chain.org", true],
    ["https://rpc.example-chain.org/v1/mainnet", true],
    ["http://rpc.example-chain.org", false],
    ["https://127.0.0.1", false],
    ["https://[::1]/", false],
    ["https://localhost", false],
    ["https://metadata.google.internal", false],
    ["https://user:pass@rpc.example-chain.org", false],
    ["https://rpc.example-chain.org/?key=x", false],
    ["https://rpc.example-chain.org/v3/${INFURA_API_KEY}", false],
    ["https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161", false],
    ["https://rpc.example-chain.org/apikey/abc", false],
    ["https://rpc.example-chain.org:8545", false],
    ["wss://rpc.example-chain.org", false],
    ["https://node.lan", false],
  ])("admitRpcUrl %s -> %s", (url, ok) => expect(admitRpcUrl(url).ok).toBe(ok));
  it("percent-encoded dot segments normalize within the same host", () => {
    const v = admitRpcUrl("https://rpc.example-chain.org/%2e%2e/admin");
    expect(v.ok && v.url).toBe("https://rpc.example-chain.org/admin");
  });
  it("explicit curated ports require opt-in", () => {
    expect(
      admitRpcUrl("https://mainnet.crosstoken.io:22001", { allowPort: true })
        .ok,
    ).toBe(true);
    expect(admitRpcUrl("https://mainnet.crosstoken.io:22001").ok).toBe(false);
  });
  const evm = {
    ecosystem: "EVM" as const,
    multicall: MULTICALL3,
    maxLogRange: 1001,
  };
  it("allows only bounded read methods", () => {
    for (const call of [
      { method: "eth_chainId", params: [] },
      { method: "eth_getBalance", params: [wallet, "latest"] },
      { method: "eth_getBlockByNumber", params: ["finalized", false] },
      {
        method: "eth_call",
        params: [{ to: token, data: balanceOfData(wallet) }, "0x10"],
      },
      {
        method: "eth_call",
        params: [{ to: token, data: "0x313ce567" }, "latest"],
      },
      {
        method: "eth_call",
        params: [
          {
            to: MULTICALL3,
            data: encodeAggregate3([
              { target: token, callData: balanceOfData(wallet) },
            ]),
          },
          "latest",
        ],
      },
      {
        method: "eth_getLogs",
        params: [
          { fromBlock: "0x1", toBlock: "0x3e8", topics: [TRANSFER_TOPIC] },
        ],
      },
    ])
      expect(() => assertAllowed(call, evm)).not.toThrow();
  });
  it.each([
    { method: "eth_sendRawTransaction", params: ["0x00"] },
    { method: "eth_sendTransaction", params: [{}] },
    { method: "personal_sign", params: [] },
    {
      method: "eth_call",
      params: [{ to: token, data: "0xa9059cbb" + "0".repeat(128) }, "latest"],
    },
    {
      method: "eth_call",
      params: [{ to: token, data: "0x313ce567", from: wallet }, "latest"],
    },
    {
      method: "eth_call",
      params: [{ to: token, data: "0x313ce567", value: "0x1" }, "latest"],
    },
    {
      method: "eth_call",
      params: [
        {
          to: MULTICALL3,
          data: encodeAggregate3([
            { target: token, callData: "0xa9059cbb" as `0x${string}` },
          ]),
        },
        "latest",
      ],
    },
    {
      method: "eth_call",
      params: [
        {
          to: MULTICALL3,
          data: encodeAggregate3([
            { target: MULTICALL3, callData: balanceOfData(wallet) },
          ]),
        },
        "latest",
      ],
    },
    {
      method: "eth_getLogs",
      params: [{ fromBlock: "0x1", toBlock: "0x2", topics: [hash(1)] }],
    },
    {
      method: "eth_getLogs",
      params: [
        { fromBlock: "0x1", toBlock: "0x100000", topics: [TRANSFER_TOPIC] },
      ],
    },
    {
      method: "eth_getLogs",
      params: [{ fromBlock: "0x10", toBlock: "0x1", topics: [TRANSFER_TOPIC] }],
    },
    { method: "eth_getBalance", params: ["0xnot", "latest"] },
    { method: "debug_traceTransaction", params: [hash(1)] },
  ])("rejects write/unbounded/unknown call %#", (call) =>
    expect(() => assertAllowed(call, evm)).toThrow(),
  );
  it("aggregate3 is rejected at an unverified multicall address", () => {
    const data = encodeAggregate3([
      { target: token, callData: balanceOfData(wallet) },
    ]);
    expect(() =>
      assertAllowed(
        { method: "eth_call", params: [{ to: token, data }, "latest"] },
        { ecosystem: "EVM", multicall: null },
      ),
    ).toThrow();
  });
  it("solana policy allows finalized reads only", () => {
    expect(() =>
      assertAllowed(
        {
          method: "getBalance",
          params: [
            "11111111111111111111111111111111",
            { commitment: "finalized" },
          ],
        },
        { ecosystem: "SVM" },
      ),
    ).not.toThrow();
    expect(() =>
      assertAllowed(
        {
          method: "getBalance",
          params: [
            "11111111111111111111111111111111",
            { commitment: "processed" },
          ],
        },
        { ecosystem: "SVM" },
      ),
    ).toThrow();
    expect(() =>
      assertAllowed(
        { method: "sendTransaction", params: ["x"] },
        { ecosystem: "SVM" },
      ),
    ).toThrow();
  });
});
describe("V14 health, ranges and reorg", () => {
  it("health scoring quarantines and recovers", () => {
    let h = freshHealth();
    h = recordSuccess(h, 100, 1, 50n);
    expect(score(h, 2)).toBeGreaterThan(0.5);
    h = recordFailure(
      recordFailure(recordFailure(h, "HTTP_ERROR", 3), "HTTP_ERROR", 4),
      "HTTP_ERROR",
      5,
    );
    expect(quarantined(h, 6)).toBe(true);
    expect(score(h, 6)).toBe(0);
    expect(
      recordFailure(freshHealth(), "CHAIN_MISMATCH", 0).quarantinedUntil,
    ).toBe(24 * 3600000);
    expect(
      recordFailure(freshHealth(), "RATE_LIMITED", 0).quarantinedUntil,
    ).toBe(30000);
    expect(quarantined(recordSuccess(h, 50, 10 ** 12), 10 ** 12 + 1)).toBe(
      false,
    );
    // V1.5 self-review D6: integrity quarantines survive later successes (e.g. health probes) until
    // they expire; ordinary backoff quarantines are still lifted by a success.
    for (const code of ["LOG_SET_MISMATCH", "CHAIN_MISMATCH"]) {
      const q = recordFailure(freshHealth(), code, 1000);
      const probed = recordSuccess(q, 20, 2000, 99n);
      expect(quarantined(probed, 2001)).toBe(true);
      expect(probed.quarantineReason).toBe(code);
      expect(score(probed, 2001)).toBe(0);
      const later = q.quarantinedUntil! + 1;
      expect(quarantined(recordSuccess(q, 20, later), later)).toBe(false);
    }
    const limited = recordFailure(freshHealth(), "RATE_LIMITED", 0);
    expect(quarantined(recordSuccess(limited, 20, 10), 11)).toBe(false);
    expect(lagging({ ...freshHealth(), latestBlock: 100n }, 1000n)).toBe(true);
    expect(score({ ...freshHealth(), latestBlock: 100n }, 0, 1000n)).toBe(0);
  });
  it("adaptive ranges shrink, grow cautiously and stop at the minimum", () => {
    const r = new RangeController(100, 1000, 10);
    expect(r.failure()).toBe(true);
    expect(r.size).toBe(50);
    r.success(10);
    r.success(10);
    r.success(10);
    // Learned ceiling: the size that failed (100) is never retried on this run.
    expect(r.size).toBe(99);
    r.success(100000);
    expect(r.size).toBe(49);
    const tiny = new RangeController(1, 10, 1);
    expect(tiny.failure()).toBe(false);
  });
  const windows = [
    { fromBlock: 21n, toBlock: 30n, toBlockHash: hash(30), finalized: false },
    { fromBlock: 11n, toBlock: 20n, toBlockHash: hash(20), finalized: false },
    { fromBlock: 1n, toBlock: 10n, toBlockHash: hash(10), finalized: true },
  ];
  it("plans no rewind when anchors match", async () => {
    expect(await planRewind(windows, async (b) => hash(Number(b)), 0n)).toEqual(
      { kind: "NONE" },
    );
  });
  it("rewinds unfinalized windows to the last canonical anchor", async () => {
    const plan = await planRewind(
      windows,
      async (b) => (b === 30n ? hash(999) : hash(Number(b))),
      0n,
    );
    expect(plan).toEqual({
      kind: "REWIND",
      keepThrough: 20n,
      anchorHash: hash(20),
      dropWindows: 1,
    });
  });
  it("refuses to rewind finalized history", async () => {
    const plan = await planRewind(windows, async () => hash(12345), 0n);
    expect(plan).toEqual({ kind: "FINALIZED_CONFLICT", block: 10n });
  });
  it("returns to the start anchor when every unfinalized window was replaced", async () => {
    const plan = await planRewind(
      windows.slice(0, 2),
      async () => hash(777),
      10n,
    );
    expect(plan).toEqual({
      kind: "REWIND",
      keepThrough: 10n,
      anchorHash: null,
      dropWindows: 2,
    });
  });
});
describe("V14 ERC20 decoding and metadata safety", () => {
  it("decodes strict ERC20 transfers", () => {
    const r = decodeTransfer(log(), "42161");
    expect(r.ok && r.row).toMatchObject({
      token,
      to: wallet,
      value: 1000n,
      logIndex: 3,
      blockNumber: 16n,
    });
  });
  it.each([
    [
      {
        topics: [
          TRANSFER_TOPIC,
          walletTopic(wallet),
          walletTopic(wallet),
          hash(5),
        ],
      },
      "NOT_ERC20_SHAPE",
    ],
    [{ data: "0x" }, "BAD_DATA_SIZE"],
    [{ removed: true }, "REMOVED_LOG"],
    [
      { topics: [hash(1), walletTopic(wallet), walletTopic(wallet)] },
      "WRONG_TOPIC",
    ],
    [
      { topics: [TRANSFER_TOPIC, "0x" + "f".repeat(64), walletTopic(wallet)] },
      "BAD_TOPIC_ADDRESS",
    ],
    [{ address: "0xZZ" }, "MALFORMED_LOG"],
    [{ blockHash: "0x1" }, "MALFORMED_LOG"],
  ])("rejects malformed log %#", (extra, reason) => {
    const r = decodeTransfer(log(extra), "1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
  it("handles ABI string, bytes32, reverts, huge and hostile metadata", () => {
    const abi = encodeAbiParameters([{ type: "string" }], ["USDC"]);
    expect(decodeMetadataString(abi, 32)).toBe("USDC");
    expect(decodeMetadataString(stringToHex("MKR", { size: 32 }), 32)).toBe(
      "MKR",
    );
    expect(decodeMetadataString("0x", 32)).toBeNull();
    expect(decodeMetadataString(null, 32)).toBeNull();
    const xss = encodeAbiParameters(
      [{ type: "string" }],
      ['<img src=x onerror=alert(1)>\u202e\u0000"evil"'],
    );
    const clean = decodeMetadataString(xss, 120)!;
    expect(clean).not.toMatch(/[<>"\u202e\u0000]/);
    const long = encodeAbiParameters([{ type: "string" }], ["A".repeat(400)]);
    expect(decodeMetadataString(long, 32)).toHaveLength(32);
    expect(decodeMetadataString("0x" + "00".repeat(5000), 32)).toBeNull();
    expect(decodeDecimals(pad(toHex(18n)))).toBe(18);
    expect(decodeDecimals(pad(toHex(255n)))).toBeNull();
    expect(sanitizeText("a\u200bb\u2066c<d>", 10)).toBe("abcd");
  });
  it("aggregate3 calldata binds targets deterministically", () => {
    const data = encodeAggregate3([
      { target: token, callData: balanceOfData(wallet) },
      {
        target: "0x3333333333333333333333333333333333333333",
        callData: balanceOfData(wallet),
      },
    ]);
    expect(data).toBe(
      encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "aggregate3",
            stateMutability: "payable",
            inputs: [
              {
                name: "calls",
                type: "tuple[]",
                components: [
                  { name: "target", type: "address" },
                  { name: "allowFailure", type: "bool" },
                  { name: "callData", type: "bytes" },
                ],
              },
            ],
            outputs: [],
          },
        ],
        functionName: "aggregate3",
        args: [
          [
            {
              target: token,
              allowFailure: true,
              callData: balanceOfData(wallet),
            },
            {
              target: "0x3333333333333333333333333333333333333333",
              allowFailure: true,
              callData: balanceOfData(wallet),
            },
          ],
        ],
      }),
    );
  });
});
describe("V14 coverage, scheduler and no 40-chain truncation", () => {
  const cov = (id: string, state: ChainCoverage["state"]): ChainCoverage => ({
    chainId: id,
    state,
    tier: "ON_DEMAND_FUNGIBLE",
    native: state === "PENDING" ? "PENDING" : "CHECKED",
    tokens: "KNOWN_TOKENS",
    historicalComplete: false,
    indexedFromBlock: null,
    indexedThroughBlock: null,
    headBlock: null,
    observedBlock: null,
    reason: "NONE",
    observedAt: 1,
  });
  it("pending or failed chains are never complete; empty plans are not complete", () => {
    expect(summarize([]).coverageComplete).toBe(false);
    expect(
      summarize([cov("1", "COMPLETE"), cov("2", "PENDING")]).coverageComplete,
    ).toBe(false);
    expect(
      summarize([cov("1", "COMPLETE"), cov("2", "FAILED")]).coverageComplete,
    ).toBe(false);
    expect(summarize([cov("1", "COMPLETE")]).coverageComplete).toBe(true);
    expect(summarize([cov("1", "PENDING")]).checked).toBe(0);
  });
  it("schedules 1000 discovered chains: every chain ends done/failed/pending (no fixed cap)", async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => String(i + 1));
    let inFlight = 0,
      peak = 0;
    const r = await runScheduled(
      ids,
      async (id) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((x) => setTimeout(x, 1));
        inFlight--;
        if (id.endsWith("7"))
          throw Object.assign(Error("x"), { code: "RPC_ERROR" });
        return id;
      },
      { concurrency: 16, deadlineMs: 20000, perTaskMs: 1000, maxTasks: 5000 },
    );
    expect(r.done.size + r.failed.size + r.pending.length).toBe(1000);
    expect(r.done.size).toBe(900);
    expect(r.failed.size).toBe(100);
    expect(peak).toBeLessThanOrEqual(16);
    expect(r.done.has("41")).toBe(true);
    expect(r.done.has("1000")).toBe(true);
  });
  it("deadline leaves unfinished chains pending, never failed or empty", async () => {
    const r = await runScheduled(
      Array.from({ length: 60 }, (_, i) => String(i + 1)),
      async (id, signal) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(id), Number(id) <= 5 ? 1 : 10000);
          signal.addEventListener(
            "abort",
            () => (clearTimeout(t), reject(signal.reason)),
          );
        }),
      { concurrency: 5, deadlineMs: 200, perTaskMs: 60000, maxTasks: 100 },
    );
    expect(r.done.size).toBe(5);
    expect(r.failed.size).toBe(0);
    expect(r.pending).toHaveLength(55);
  });
  it("plan limits produce explicit pending chains and a narrowing-only continuation", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => String(i + 1));
    const r = await runScheduled(ids, async (id) => id, {
      concurrency: 4,
      deadlineMs: 5000,
      perTaskMs: 1000,
      maxTasks: 40,
    });
    expect(r.pending).toEqual(["41", "42", "43", "44", "45"]);
    const cursor = encodeContinuation("abcdef0123456789", r.pending)!;
    expect(decodeContinuation(cursor, "abcdef0123456789ff", ids)).toEqual(
      r.pending,
    );
    expect(
      decodeContinuation(cursor, "abcdef0123456789", ["41", "99"]),
    ).toEqual(["41"]);
    expect(() => decodeContinuation(cursor, "ffffffffffffffff", ids)).toThrow(
      "CONTINUATION_SCOPE_MISMATCH",
    );
    expect(() => decodeContinuation("!!bad", "abcdef0123456789", ids)).toThrow(
      "INVALID_CONTINUATION",
    );
    expect(encodeContinuation("abcdef0123456789", [])).toBeNull();
  });
  it("source tree contains no silent 40-chain correctness cap", async () => {
    const files: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true }))
        if (e.isDirectory()) await walk(`${d}/${e.name}`);
        else files.push(`${d}/${e.name}`);
    };
    await walk("src");
    await walk("services");
    for (const f of files.filter((f) => /\.(ts|tsx|sql)$/.test(f))) {
      const text = await readFile(f, "utf8");
      // Trojan-Source guard: no literal bidi/zero-width controls in executable source.
      expect(text, f).not.toMatch(/[‪-‮⁦-⁩​-‏﻿]/);
      expect(text, f).not.toMatch(/\.slice\(0,\s*40\)/);
      expect(text, f).not.toMatch(
        /OTHERBRIDGE_PORTFOLIO_API_KEY|api\.covalenthq\.com/,
      );
    }
  });
});
describe("V14 API keys, plans, metering and rate limiting", () => {
  it("keys are strong, verifiable only via hash, and never stored in plaintext", () => {
    const k = generateKey();
    expect(k.plaintext).toMatch(/^ob_live_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(k.verifier).toBe(verifierOf(k.plaintext));
    expect(k.verifier).not.toContain(k.plaintext.slice(-43));
    expect(verifyKey(k.plaintext, k.verifier)).toBe(true);
    expect(
      verifyKey(
        k.plaintext.slice(0, -1) + (k.plaintext.endsWith("A") ? "B" : "A"),
        k.verifier,
      ),
    ).toBe(false);
    expect(verifyKey(k.plaintext, "not-hex")).toBe(false);
    expect(parseKey(k.plaintext)?.prefix).toBe(k.prefix);
    expect(parseKey("ob_live_short_x")).toBeNull();
    expect(parseKey("' OR 1=1 --")).toBeNull();
    expect(generateKey().prefix).not.toBe(k.prefix);
    expect(randomId("cli")).toMatch(/^cli_[a-z0-9]{24}$/);
  });
  it("plans are configuration only with billing disabled and read-only scopes", () => {
    expect(billingEnabled).toBe(false);
    expect(Object.keys(PLANS)).toEqual([
      "internal",
      "developer",
      "starter",
      "pro",
    ]);
    expect(JSON.stringify(PLANS)).not.toMatch(/price|usd|stripe|invoice/i);
    expect(() => validScopes(["portfolio:write"])).toThrow();
    expect(() => validScopes([])).toThrow();
    expect(validScopes(["chains:read", "chains:read"])).toEqual([
      "chains:read",
    ]);
    expect(() => planOf("enterprise")).toThrow();
  });
  it("expensive scans are pre-charged by chains (no unlimited scan for one unit)", () => {
    expect(COST.portfolio(1)).toBe(3);
    expect(COST.portfolio(400)).toBe(402);
    expect(COST.portfolio(400)).toBeGreaterThan(COST.chains * 100);
  });
  it("memory limiter enforces fixed windows, costs and key grammar", async () => {
    let now = 0;
    const l = new MemoryRateLimiter(() => now);
    expect(
      (await l.consume("a", { limit: 2, windowSeconds: 60 })).allowed,
    ).toBe(true);
    expect(
      (await l.consume("a", { limit: 2, windowSeconds: 60 })).allowed,
    ).toBe(true);
    expect(
      (await l.consume("a", { limit: 2, windowSeconds: 60 })).allowed,
    ).toBe(false);
    now = 60000;
    expect(
      (await l.consume("a", { limit: 2, windowSeconds: 60 })).allowed,
    ).toBe(true);
    expect(
      (await l.consume("b", { limit: 5, windowSeconds: 60, cost: 6 })).allowed,
    ).toBe(false);
    await expect(
      l.consume("bad key with spaces", { limit: 1, windowSeconds: 1 }),
    ).rejects.toThrow();
    await expect(
      l.consume("k", { limit: 1, windowSeconds: 1, cost: 0 }),
    ).rejects.toThrow();
  });
  it("durable limiter failure fails closed when protection is required", async () => {
    const broken: RateLimiter = {
      backend: "postgres",
      consume: async () => Promise.reject(new RateLimitUnavailable()),
    };
    await expect(
      new FallbackRateLimiter(broken, new MemoryRateLimiter(), true).consume(
        "x",
        { limit: 1, windowSeconds: 1 },
      ),
    ).rejects.toThrow("RATE_LIMIT_UNAVAILABLE");
    expect(
      (
        await new FallbackRateLimiter(
          broken,
          new MemoryRateLimiter(),
          false,
        ).consume("x", { limit: 1, windowSeconds: 1 })
      ).allowed,
    ).toBe(true);
  });
  it("data config fails closed on malformed or non-durable production settings", () => {
    expect(
      dataConfig({ OTHERBRIDGE_RATE_LIMIT_BACKEND: "redis" }).errors,
    ).toContain("OTHERBRIDGE_RATE_LIMIT_BACKEND");
    expect(
      dataConfig({ OTHERBRIDGE_RATE_LIMIT_BACKEND: "postgres" }).errors,
    ).toContain("RATE_LIMIT_BACKEND_REQUIRES_DATABASE");
    expect(
      dataConfig({
        NODE_ENV: "production",
        OTHERBRIDGE_PUBLIC_DEPLOYMENT: "true",
      }).errors,
    ).toEqual(
      expect.arrayContaining([
        "DURABLE_RATE_LIMIT_REQUIRED",
        "PSEUDONYM_KEY_REQUIRED",
      ]),
    );
    expect(dataConfig({}).errors).toEqual([]);
    expect(dataConfig({}).publicApiEnabled).toBe(false);
    expect(
      dataConfig({ OTHERBRIDGE_DATA_DATABASE_URL: "mysql://x" }).errors,
    ).toContain("OTHERBRIDGE_DATA_DATABASE_URL");
  });
});
describe("V14 price evidence, privacy, logs and migrations", () => {
  it("prices are fixed-point presentation evidence; unknown stays unknown", () => {
    expect(usdValue(1500000n, 6, "2.5")).toBe("3.750000");
    expect(usdValue(10n ** 30n, 18, "0.000001")).toBe("1000000.000000");
    expect(usdValue(1n, 18, null)).toBeNull();
    const p = derivedPrice("2834.12", 1000, "routing-token-list");
    expect(freshPrice(p, 1000 + 299000)).toBe("2834.12");
    expect(freshPrice(p, 1000 + 301000)).toBeNull();
    expect(freshPrice(p, 500)).toBeNull();
    expect(freshPrice(unknownPrice(), 1000)).toBeNull();
    expect(derivedPrice("1e9", 1, "x").confidence).toBe("unknown");
    expect(derivedPrice(-1, 1, "x").confidence).toBe("unknown");
  });
  it("wallet pseudonyms are keyed and ecosystem-correct", () => {
    expect(walletPseudonym(wallet)).toBe(
      walletPseudonym(wallet.toUpperCase().replace("0X", "0x")),
    );
    expect(
      walletPseudonym("So11111111111111111111111111111111111111112"),
    ).not.toBe(walletPseudonym("so11111111111111111111111111111111111111112"));
    expect(walletPseudonym(wallet)).toMatch(/^[0-9a-f]{64}$/);
    expect(walletPseudonym(wallet)).not.toContain(wallet.slice(2, 10));
  });
  it("logs redact addresses, keys and database URLs; metric labels reject addresses", () => {
    expect(
      redactValue(
        `scan ${wallet} key ob_live_abcdefghijkl_${"A".repeat(43)} postgres://u:p@h/db`,
      ),
    ).toBe("scan [address] key [secret] [secret]");
    expect(() => metrics.inc("x", { wallet })).toThrow(
      "ADDRESS_IN_METRIC_LABEL",
    );
    expect(
      redactValue("req_3f9a1b2c4d5e6f7a8b9c1d2e3f4a5b6c", "requestId"),
    ).toBe("req_3f9a1b2c4d5e6f7a8b9c1d2e3f4a5b6c");
  });
  it("migrations are versioned, contiguous and non-destructive", async () => {
    const files = await loadMigrations();
    expect(files.map((f) => f.version)).toEqual(files.map((_, i) => i + 1));
    for (const f of files) expect(f.checksum).toMatch(/^[0-9a-f]{64}$/);
    for (const sql of [
      "DROP TABLE tokens;",
      "truncate erc20_transfers",
      "DELETE FROM chains",
      "ALTER TABLE x DROP COLUMN y",
      "ALTER TABLE a RENAME TO b",
    ])
      expect(() => assertNonDestructive({ name: "x.sql", sql })).toThrow(
        "DESTRUCTIVE_MIGRATION_REJECTED",
      );
    expect(() =>
      assertNonDestructive({
        name: "ok.sql",
        sql: "-- DROP TABLE in a comment is fine\nCREATE TABLE IF NOT EXISTS a (id int);",
      }),
    ).not.toThrow();
  });
});
describe("V14 origin policy separation", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://127.0.0.1:3100/api/x", { method: "POST", headers });
  it("rejects wildcard, lists, paths and non-loopback http origins in configuration", () => {
    for (const bad of [
      "*",
      "https://*.otherbridge.io",
      "https://otherbridge.io/app",
      "http://otherbridge.io",
      "https://1.2.3.4",
      "javascript:alert(1)",
      "https://otherbridge.io?x",
    ])
      expect(() => normalizeOrigin(bad)).toThrow();
    expect(normalizeOrigin("https://OtherBridge.io")).toBe(
      "https://otherbridge.io",
    );
    expect(
      originPolicy({ OTHERBRIDGE_APP_ORIGINS: "https://otherbridge.io,*" })
        .errors.length,
    ).toBeGreaterThan(0);
    expect(
      originPolicy({ OTHERBRIDGE_TRUST_PROXY_HOPS: "9" }).errors,
    ).toContain("OTHERBRIDGE_TRUST_PROXY_HOPS");
  });
  it("exact origin + matching host; invalid config fails closed", () => {
    const local = originPolicy({});
    expect(
      checkOrigin(
        req({ origin: "http://127.0.0.1:3100", host: "127.0.0.1:3100" }),
        local,
      ),
    ).toBe("OK");
    expect(
      checkOrigin(
        req({ origin: "http://127.0.0.1:3100", host: "evil.example" }),
        local,
      ),
    ).toBe("ORIGIN_REJECTED");
    expect(
      checkOrigin(
        req({ origin: "http://evil.example", host: "evil.example" }),
        local,
      ),
    ).toBe("ORIGIN_REJECTED");
    expect(checkOrigin(req({ host: "127.0.0.1:3100" }), local)).toBe(
      "ORIGIN_REJECTED",
    );
    expect(
      checkOrigin(req({ origin: "null", host: "127.0.0.1:3100" }), local),
    ).toBe("ORIGIN_REJECTED");
    const prod = originPolicy({
      OTHERBRIDGE_APP_ORIGINS: "https://otherbridge.io",
      OTHERBRIDGE_TRUST_PROXY_HOPS: "1",
    });
    expect(
      checkOrigin(
        req({
          origin: "https://otherbridge.io",
          host: "10.0.0.5:3101",
          "x-forwarded-host": "otherbridge.io",
          "x-forwarded-proto": "https",
        }),
        prod,
      ),
    ).toBe("OK");
    expect(
      checkOrigin(
        req({
          origin: "https://otherbridge.io",
          host: "x",
          "x-forwarded-host": "evil.io",
          "x-forwarded-proto": "https",
        }),
        prod,
      ),
    ).toBe("ORIGIN_REJECTED");
    expect(
      checkOrigin(
        req({ origin: "http://127.0.0.1:3100", host: "127.0.0.1:3100" }),
        prod,
      ),
    ).toBe("ORIGIN_REJECTED");
    expect(
      checkOrigin(
        req({ origin: "https://otherbridge.io", host: "otherbridge.io" }),
        originPolicy({ OTHERBRIDGE_APP_ORIGINS: "*" }),
      ),
    ).toBe("CONFIG_INVALID");
  });
  it("client attribution ignores spoofable X-Forwarded-For without trusted proxies", () => {
    expect(
      clientKey(req({ "x-forwarded-for": "1.1.1.1" }), originPolicy({})),
    ).toBeNull();
    const behind = originPolicy({ OTHERBRIDGE_TRUST_PROXY_HOPS: "1" });
    const a = clientKey(req({ "x-forwarded-for": "9.9.9.9, 1.1.1.1" }), behind),
      b = clientKey(req({ "x-forwarded-for": "8.8.8.8, 1.1.1.1" }), behind);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(
      clientKey(req({ "x-forwarded-for": "not-an-ip" }), behind),
    ).toBeNull();
  });
});
