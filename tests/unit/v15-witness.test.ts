import { describe, it, expect } from "vitest";
import {
  diffLogSets,
  logSetDigest,
  LogSetError,
  normalizeLogs,
  parseWitnessPolicy,
  MAX_WINDOW_LOGS,
} from "../../src/data/indexer/witness";
import { TRANSFER_TOPIC } from "../../src/data/evm/erc20";
import {
  independent,
  profileAllows,
  provenanceForUrl,
  provenanceInventorySchema,
  registryProfile,
  type ProvenanceInventory,
} from "../../src/data/registry/rpc-provenance";
import { prng, SEEDS } from "../fixtures/prng";
// V1.5 log-set digest / normalization properties (seeded, reproducible) and provenance policy.
const quantity = (n: number | bigint) => `0x${BigInt(n).toString(16)}`;
function randomWindow(seed: number, count = 40, from = 1000n, to = 1099n) {
  const r = prng(seed);
  const hashes = new Map<bigint, string>();
  const used = new Set<string>();
  const logs: Record<string, unknown>[] = [];
  while (logs.length < count) {
    const block = from + BigInt(r.int(Number(to - from) + 1));
    const logIndex = r.int(500);
    if (used.has(`${block}:${logIndex}`)) continue;
    used.add(`${block}:${logIndex}`);
    if (!hashes.has(block)) hashes.set(block, r.hex(32));
    logs.push({
      address: r.hex(20),
      topics: [TRANSFER_TOPIC, r.hex(32), r.hex(32)],
      data: r.hex(32),
      blockNumber: quantity(block),
      blockHash: hashes.get(block)!,
      transactionHash: r.hex(32),
      transactionIndex: quantity(r.int(300)),
      logIndex: quantity(logIndex),
      removed: false,
    });
  }
  return { logs, from, to };
}
const digestOf = (raw: unknown[], from = 1000n, to = 1099n, chain = "42161") =>
  logSetDigest(chain, from, to, normalizeLogs(raw, from, to));
describe("V15 log-set digest properties (seeded)", () => {
  it.each(SEEDS)(
    "seed %i: permutation invariant, case-insensitive hex",
    (seed) => {
      const { logs } = randomWindow(seed);
      const base = digestOf(logs);
      const r = prng(seed + 1);
      for (let i = 0; i < 25; i++) expect(digestOf(r.shuffle(logs))).toBe(base);
      const upper = logs.map((l) => ({
        ...l,
        address: String(l.address)
          .replace(/[a-f]/g, (c) => c.toUpperCase())
          .replace("0X", "0x"),
        data: String(l.data).toUpperCase().replace("0X", "0x"),
      }));
      expect(digestOf(upper)).toBe(base);
    },
  );
  it.each(SEEDS)(
    "seed %i: any single bound-field mutation changes the digest",
    (seed) => {
      const { logs } = randomWindow(seed);
      const base = digestOf(logs);
      const r = prng(seed * 31);
      const fields = [
        "address",
        "data",
        "transactionHash",
        "topic1",
        "topic2",
        "removed",
        "transactionIndex",
      ];
      for (let i = 0; i < 60; i++) {
        const idx = r.int(logs.length);
        const field = r.pick(fields);
        const copy: Record<string, unknown>[] = logs.map((l) => ({
          ...l,
          topics: [...(l.topics as string[])],
        }));
        const l = copy[idx];
        if (field === "removed") l.removed = !l.removed;
        else if (field === "transactionIndex")
          l.transactionIndex = quantity(
            BigInt(String(l.transactionIndex)) + 1n,
          );
        else if (field.startsWith("topic")) {
          const t = Number(field.slice(5));
          (l.topics as string[])[t] = r.flipNibble((l.topics as string[])[t]);
        } else l[field] = r.flipNibble(String(l[field]));
        expect(digestOf(copy)).not.toBe(base);
      }
    },
  );
  it.each(SEEDS)(
    "seed %i: omission or fabrication of one log changes digest (counts not trusted)",
    (seed) => {
      const { logs } = randomWindow(seed);
      const base = digestOf(logs);
      const r = prng(seed + 99);
      for (let i = 0; i < 20; i++) {
        const drop = r.int(logs.length);
        expect(digestOf(logs.filter((_, j) => j !== drop))).not.toBe(base);
      }
      // Same count, one log replaced by a fabricated one.
      const fake = {
        ...logs[0],
        transactionHash: r.hex(32),
        logIndex: quantity(999),
      };
      expect(digestOf([...logs.slice(1), fake])).not.toBe(base);
    },
  );
  it("domain separation: chain and range are bound", () => {
    const { logs } = randomWindow(5);
    const base = digestOf(logs);
    expect(digestOf(logs, 1000n, 1099n, "43114")).not.toBe(base);
    expect(digestOf(logs, 999n, 1099n)).not.toBe(base);
    expect(digestOf(logs, 1000n, 1100n)).not.toBe(base);
    expect(logSetDigest("1", 0n, 0n, [])).toMatch(/^[0-9a-f]{64}$/);
    expect(logSetDigest("1", 0n, 0n, [])).not.toBe(
      logSetDigest("1", 0n, 1n, []),
    );
  });
  it("transactionIndex absence is bound explicitly; extra provider fields are ignored", () => {
    const { logs } = randomWindow(9, 5);
    const withExtra = logs.map((l) => ({ ...l, blockTimestamp: "0x1" }));
    expect(digestOf(withExtra)).toBe(digestOf(logs));
    const without = logs.map((l) => {
      const c = { ...l };
      delete c.transactionIndex;
      return c;
    });
    expect(digestOf(without)).not.toBe(digestOf(logs));
    expect(digestOf(logs.map((l) => ({ ...l, removed: undefined })))).toBe(
      digestOf(logs),
    );
  });
  it.each([
    [
      "duplicate block:logIndex",
      (l: Record<string, unknown>[]) => [...l, { ...l[0] }],
      "DUPLICATE_LOG",
    ],
    [
      "duplicate tx:logIndex",
      (l: Record<string, unknown>[]) => [
        ...l,
        { ...l[0], blockNumber: l[1].blockNumber, blockHash: l[1].blockHash },
      ],
      "DUPLICATE_LOG",
    ],
    [
      "outside range",
      (l: Record<string, unknown>[]) => [
        { ...l[0], blockNumber: quantity(5000) },
      ],
      "LOG_OUTSIDE_RANGE",
    ],
    [
      "split block hash",
      (l: Record<string, unknown>[]) => [
        l[0],
        {
          ...l[0],
          logIndex: quantity(777),
          transactionHash: `0x${"e".repeat(64)}`,
          blockHash: `0x${"f".repeat(64)}`,
        },
      ],
      "BLOCK_HASH_SPLIT",
    ],
    [
      "malformed hex",
      (l: Record<string, unknown>[]) => [{ ...l[0], data: "0xzz" }],
      "MALFORMED_LOG",
    ],
    [
      "uint overflow quantity",
      (l: Record<string, unknown>[]) => [
        { ...l[0], blockNumber: "0x1ffffffffffffffff" },
      ],
      "MALFORMED_LOG",
    ],
    [
      "leading-zero quantity",
      (l: Record<string, unknown>[]) => [{ ...l[0], logIndex: "0x01" }],
      "MALFORMED_LOG",
    ],
    [
      "no topics",
      (l: Record<string, unknown>[]) => [{ ...l[0], topics: [] }],
      "MALFORMED_LOG",
    ],
    ["not an array", () => ({ length: 1 }), "NOT_AN_ARRAY"],
  ] as const)("rejects %s", (_name, mutate, code) => {
    const { logs } = randomWindow(3, 4);
    expect(() =>
      normalizeLogs(mutate(logs) as unknown[], 1000n, 1099n),
    ).toThrow(code);
  });
  it("oversized log arrays are rejected before parsing", () => {
    expect(() =>
      normalizeLogs(new Array(MAX_WINDOW_LOGS + 1).fill(0), 0n, 1n),
    ).toThrow(LogSetError);
  });
  it("diff reports bounded key differences", () => {
    const { logs } = randomWindow(11, 10);
    const a = normalizeLogs(logs, 1000n, 1099n);
    const b = normalizeLogs(logs.slice(1), 1000n, 1099n);
    const d = diffLogSets(a, b);
    expect(d.totals).toEqual({ onlyInFirst: 1, onlyInSecond: 0, changed: 0 });
  });
  it("witness policy parsing is strict", () => {
    expect(parseWitnessPolicy(undefined)).toBe("best-effort");
    expect(parseWitnessPolicy("required")).toBe("required");
    // Outside development the default is "required"; the release profile refuses best-effort.
    expect(parseWitnessPolicy(undefined, "staging")).toBe("required");
    expect(parseWitnessPolicy("", "release")).toBe("required");
    expect(parseWitnessPolicy("best-effort", "staging")).toBe("best-effort");
    expect(parseWitnessPolicy("required", "release")).toBe("required");
    expect(() => parseWitnessPolicy("best-effort", "release")).toThrow(
      "OTHERBRIDGE_INDEX_WITNESS_RELEASE_REQUIRED",
    );
    for (const bad of ["true", "REQUIRED", "false", "off", " required"])
      expect(() => parseWitnessPolicy(bad)).toThrow(
        "OTHERBRIDGE_INDEX_WITNESS_INVALID",
      );
  });
});
const inventory = (groups: unknown[]): ProvenanceInventory =>
  provenanceInventorySchema.parse({
    version: 1,
    observedAt: "2026-10-04",
    disclaimer: "Test inventory, not legal advice, synthetic only.",
    groups,
  });
const group = (extra: Record<string, unknown>) => ({
  operatorGroup: "op-x",
  operator: "Operator X",
  hosts: ["rpc.x.example.org"],
  backingProvider: null,
  backingOperatorGroup: null,
  provenance: "operator-docs",
  officialDocsUrl: null,
  termsUrl: null,
  privacyUrl: null,
  commercialUseStatus: "UNKNOWN",
  commercialUseEvidence: "synthetic",
  rateLimitNotes: "",
  attributionRequirement: "NONE_STATED",
  reviewStatus: "LEGAL_REVIEW_REQUIRED",
  legalReviewRef: null,
  witnessEligible: true,
  observedAt: "2026-10-04",
  uncertainty: "synthetic",
  ...extra,
});
describe("V15 RPC provenance and release policy", () => {
  it("unknown hosts are UNKNOWN and never independent", () => {
    const inv = inventory([group({})]);
    const p = provenanceForUrl("https://unknown.example.net/rpc", inv);
    expect(p).toMatchObject({
      operatorGroup: null,
      reviewStatus: "UNKNOWN",
      witnessEligible: false,
    });
    expect(
      independent(
        { url: "https://a.example.org", operatorGroup: null },
        { url: "https://b.example.org", operatorGroup: "op-b" },
      ),
    ).toBe(false);
  });
  it("exact host beats wildcard; unverified operator rows never establish independence", () => {
    const inv = inventory([
      group({ operatorGroup: "op-wild", hosts: ["*.example.org"] }),
      group({ operatorGroup: "op-exact", hosts: ["rpc.special.example.org"] }),
      group({
        operatorGroup: "op-unknown",
        hosts: ["*.mystery.example.com"],
        provenance: "unknown",
        reviewStatus: "UNKNOWN",
      }),
    ]);
    expect(
      provenanceForUrl("https://rpc.special.example.org/x", inv).operatorGroup,
    ).toBe("op-exact");
    expect(
      provenanceForUrl("https://other.example.org", inv).operatorGroup,
    ).toBe("op-wild");
    expect(
      provenanceForUrl("https://a.mystery.example.com", inv),
    ).toMatchObject({ operatorGroup: null, witnessEligible: false });
  });
  it("same operator, URL aliases and trailing slashes are not independent", () => {
    expect(
      independent(
        { url: "https://a.x.org/rpc", operatorGroup: "op" },
        { url: "https://b.x.org", operatorGroup: "op" },
      ),
    ).toBe(false);
    expect(
      independent(
        { url: "https://a.x.org/rpc/", operatorGroup: "op-1" },
        { url: "https://A.X.org/rpc", operatorGroup: "op-2" },
      ),
    ).toBe(false);
    expect(
      independent(
        { url: "https://a.x.org", operatorGroup: "op-1" },
        { url: "https://b.y.org", operatorGroup: "op-2" },
      ),
    ).toBe(true);
  });
  it("APPROVED_FOR_RELEASE requires a legal review reference; PROHIBITED cannot witness", () => {
    expect(() =>
      inventory([group({ reviewStatus: "APPROVED_FOR_RELEASE" })]),
    ).toThrow();
    expect(() =>
      inventory([group({ reviewStatus: "PROHIBITED", witnessEligible: true })]),
    ).toThrow();
    expect(() =>
      inventory([group({}), group({ operatorGroup: "op-y" })]),
    ).toThrow(/DUP_HOST/);
    const ok = inventory([
      group({
        reviewStatus: "APPROVED_FOR_RELEASE",
        legalReviewRef: "counsel-2026-001",
      }),
    ]);
    expect(
      provenanceForUrl("https://rpc.x.example.org", ok).releaseAllowed,
    ).toBe(true);
  });
  it("release profile admits only legally approved endpoints; PROHIBITED never", () => {
    for (const status of [
      "APPROVED_FOR_STAGING",
      "LEGAL_REVIEW_REQUIRED",
      "UNKNOWN",
    ] as const) {
      expect(
        profileAllows("release", {
          reviewStatus: status,
          releaseAllowed: false,
        }),
      ).toBe(false);
      expect(
        profileAllows("staging", {
          reviewStatus: status,
          releaseAllowed: false,
        }),
      ).toBe(true);
      expect(
        profileAllows("development", {
          reviewStatus: status,
          releaseAllowed: false,
        }),
      ).toBe(true);
    }
    for (const p of ["development", "staging", "release"] as const)
      expect(
        profileAllows(p, { reviewStatus: "PROHIBITED", releaseAllowed: false }),
      ).toBe(false);
  });
  it("deployment profile cannot be loosened by environment in public production", () => {
    expect(registryProfile({}).profile).toBe("development");
    expect(
      registryProfile({
        NODE_ENV: "production",
        OTHERBRIDGE_PUBLIC_DEPLOYMENT: "true",
      }).profile,
    ).toBe("release");
    expect(
      registryProfile({ OTHERBRIDGE_DEPLOYMENT_ENV: "production" }).profile,
    ).toBe("release");
    const stagingPublic = {
      OTHERBRIDGE_DEPLOYMENT_ENV: "staging",
      NODE_ENV: "production",
      OTHERBRIDGE_PUBLIC_DEPLOYMENT: "true",
    };
    // A staging marker relaxes the policy only when every served host is non-public.
    expect(
      registryProfile({
        ...stagingPublic,
        OTHERBRIDGE_APP_ORIGINS: "https://app.otherbridge.localhost:8443",
        OTHERBRIDGE_DATA_API_HOSTS: "api.otherbridge.localhost:8443",
      }),
    ).toEqual({ profile: "staging", errors: [] });
    for (const extra of [
      {},
      { OTHERBRIDGE_APP_ORIGINS: "https://app.otherbridge.example.com" },
      { OTHERBRIDGE_APP_ORIGINS: "https://localhost.evil.com" },
      { OTHERBRIDGE_APP_ORIGINS: "https://app.localhost.com" },
      { OTHERBRIDGE_APP_ORIGINS: "https://172.32.0.1" },
      { OTHERBRIDGE_APP_ORIGINS: "not a url" },
      {
        OTHERBRIDGE_APP_ORIGINS: "https://app.otherbridge.localhost:8443",
        OTHERBRIDGE_DATA_API_HOSTS: "api.otherbridge.io",
      },
    ])
      expect(registryProfile({ ...stagingPublic, ...extra })).toEqual({
        profile: "release",
        errors: ["OTHERBRIDGE_DEPLOYMENT_ENV_STAGING_PUBLIC_HOST"],
      });
    for (const ok of [
      "https://127.0.0.1:8443",
      "https://10.1.2.3",
      "https://[::1]:8443",
      "https://otherbridge.test",
      "https://ops.internal",
    ])
      expect(
        registryProfile({ ...stagingPublic, OTHERBRIDGE_APP_ORIGINS: ok })
          .profile,
      ).toBe("staging");
    // Non-public staging (no public-mode flag) keeps the staging profile.
    expect(
      registryProfile({ OTHERBRIDGE_DEPLOYMENT_ENV: "staging" }).profile,
    ).toBe("staging");
    const bad = registryProfile({ OTHERBRIDGE_DEPLOYMENT_ENV: "Production " });
    expect(bad).toEqual({
      profile: "release",
      errors: ["OTHERBRIDGE_DEPLOYMENT_ENV"],
    });
    expect(
      registryProfile({
        OTHERBRIDGE_DEPLOYMENT_ENV: "local",
        NODE_ENV: "production",
        OTHERBRIDGE_PUBLIC_DEPLOYMENT: "true",
      }).profile,
    ).toBe("release");
  });
});
