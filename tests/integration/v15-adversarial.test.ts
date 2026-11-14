import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../../src/data/store/memory";
import { DataPlane } from "../../src/data/plane";
import {
  createDataApi,
  datastoreUnavailable,
  decodeCursor,
  encodeCursor,
  preRoute,
  hostFieldLines,
} from "../../src/data/api/router";
import { ApiError } from "../../src/data/api/errors";
import { generateKey, randomId } from "../../src/data/api/keys";
import {
  MemoryRateLimiter,
  RateLimitUnavailable,
  type RateLimiter,
} from "../../src/server/rate-limit";
import { fakeNetwork, approved, FakeChain } from "../fixtures/fake-chain";
import { fixtureCatalog } from "../fixtures/routing";
import { chainRecord } from "../fixtures/witness-harness";
import {
  checkOrigin,
  clientKey,
  normalizeOrigin,
  originPolicy,
} from "../../src/server/origin-policy";
import { dataConfig } from "../../src/data/config";
import { redactValue, logEvent } from "../../src/data/observability/log";
import { newRegistry } from "../../src/data/observability/metrics";
import {
  authorized,
  metricsListenerConfig,
} from "../../src/data/observability/metrics-server";
import { collectOpsMetrics } from "../../src/data/observability/ops-metrics";
import {
  sanitizeText,
  suspiciousText,
  baseUnits,
  boundedBigint,
} from "../../src/data/core/sanitize";
import {
  decodeMetadataString,
  tokenMetadataFlags,
} from "../../src/data/evm/erc20";
import { decryptBackup, encryptBackup } from "../../src/data/backup/crypto";
import {
  countSecrets,
  createSecretScanner,
} from "../../src/data/backup/secret-scan";
import { deflateSync } from "node:zlib";
import { platformFee } from "../../src/routing/fee-policy";
import {
  rpcBatch,
  rpcCall,
  safeJson,
  RpcError,
} from "../../src/data/rpc/transport";
import { assertAllowed } from "../../src/data/rpc/methods";
import { assertNonDestructive } from "../../src/data/store/migrate";
import { prng, SEEDS } from "../fixtures/prng";
// V1.5 adversarial / property suite: Data API surface, SQL boundary, RPC boundary, logs, metrics,
// origin/forwarded parsing, configuration schema, cursors, amounts, metadata and backup envelope.
const wallet = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";
let get: (
  path: string,
  init?: RequestInit & { auth?: string | null },
) => Promise<Response>;
let key: ReturnType<typeof generateKey>;
let revokedKey: ReturnType<typeof generateKey>;
beforeAll(async () => {
  const net = fakeNetwork();
  const chain = new FakeChain("910001");
  chain.mine(40);
  net.chains.set("910001", chain);
  const store = new MemoryStore();
  await store.upsertChains([chainRecord("910001")]);
  await store.upsertEndpoint(approved("910001", "rpc-a.synthetic.test"), 10);
  const clientId = randomId("cli");
  await store.createClient({
    id: clientId,
    displayName: "adv",
    status: "ACTIVE",
    planId: "internal",
    scopes: [
      "chains:read",
      "balances:read",
      "activity:read",
      "tokens:read",
      "portfolio:read",
    ],
    createdAt: Date.now(),
  });
  key = generateKey("test");
  revokedKey = generateKey("test");
  for (const [k, status] of [
    [key, "ACTIVE"],
    [revokedKey, "REVOKED"],
  ] as const)
    await store.createKey({
      id: randomId("key"),
      clientId,
      prefix: k.prefix,
      verifier: k.verifier,
      status,
      createdAt: Date.now(),
      revokedAt: null,
      lastUsedAt: null,
    });
  const handle = createDataApi({
    store,
    plane: new DataPlane(store, net.transport, 0),
    limiter: new MemoryRateLimiter(),
    routing: async () => fixtureCatalog(),
  });
  get = (path, init = {}) => {
    const headers = new Headers(init.headers);
    const auth = init.auth === undefined ? key.plaintext : init.auth;
    if (auth && !headers.has("authorization"))
      headers.set("authorization", `Bearer ${auth}`);
    return handle(
      new Request(`http://127.0.0.1:3200${path}`, { ...init, headers }),
    );
  };
});
const envelope = async (r: Response) => {
  const body = (await r.json()) as {
    error?: { code: string; message: string; requestId: string };
  };
  expect(Object.keys(body)).toEqual(["error"]);
  expect(Object.keys(body.error!).sort()).toEqual([
    "code",
    "message",
    "requestId",
  ]);
  expect(JSON.stringify(body)).not.toMatch(
    /at \w+ \(|\.ts:\d+|stack|synthetic\.test|postgres|ECONN|127\.0\.0\.1/,
  );
  expect(r.headers.get("cache-control")).toBe("no-store");
  return body.error!;
};
describe("V15 Data API hardening (§55)", () => {
  it.each(["TRACE", "CONNECT", "TRACK", "PROPFIND", "post", undefined])(
    "service pre-route refuses %s before a Request exists",
    async (method) => {
      const r = preRoute(method as string | undefined)!;
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("GET");
      expect(preRoute("GET")).toBeNull();
      expect(preRoute("HEAD")).toBeNull();
    },
  );
  it("repeated Host field lines are counted case-insensitively (service answers 400 unless exactly one)", () => {
    expect(hostFieldLines(["Host", "127.0.0.1:3200"])).toBe(1);
    expect(
      hostFieldLines(["Host", "127.0.0.1:3200", "host", "127.0.0.1:3200"]),
    ).toBe(2);
    expect(hostFieldLines(["X-Host", "a", "Accept", "host"])).toBe(0);
    expect(hostFieldLines(["HOST", "a", "Accept", "*/*", "hOsT", "b"])).toBe(2);
  });
  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "PROPFIND"])(
    "method confusion %s → 405 GET-only",
    async (method) => {
      const r = await get("/v1/chains", { method });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("GET");
      expect((await envelope(r)).code).toBe("METHOD_NOT_ALLOWED");
    },
  );
  it("HEAD mirrors GET status with no-store headers", async () => {
    const r = await get("/v1/chains?limit=1", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it.each([
    ["/v1//chains", 404],
    ["/v1/./chains", 200],
    // WHATWG URL parsing folds percent-encoded dot segments before routing; nothing escapes /v1.
    ["/v1/%2e%2e/v1/chains", 200],
    ["/v1/%2e%2e/%2e%2e/etc/passwd", 404],
    ["/V1/chains", 404],
    ["/v1/chains%2F910001", 404],
    ["/v1/chains/910001%252Fcoverage", 400],
    ["/v1/chains/%EF%BC%91", 400],
    ["/v1/chains/%E2%80%AE910001", 400],
    ["/v1/chains/١٢٣", 400],
    ["/v1/chains/-1", 400],
    ["/v1/chains/0x1", 400],
    ["/v1/chains/1e3", 400],
    ["/v1/chains/1234567890123456789", 400],
    ["/v1/chains/910001/coverage/", 200],
    ["/v1/metrics", 404],
    ["/v1/../etc/passwd", 404],
  ])("path normalization / encoding trick %s → %i", async (path, status) => {
    const r = await get(path);
    expect(r.status, path).toBe(status);
    if (status >= 400) await envelope(r);
  });
  it("duplicate and oversized query parameters are validated, not concatenated", async () => {
    expect((await get("/v1/chains?limit=1&limit=500")).status).toBe(200);
    expect((await get("/v1/chains?limit=500&limit=1")).status).toBe(400);
    expect((await get(`/v1/chains?cursor=${"A".repeat(401)}`)).status).toBe(
      400,
    );
    expect((await get("/v1/chains?cursor=%00%00")).status).toBe(400);
    expect((await get(`/v1/address/${wallet}/activity?limit=0`)).status).toBe(
      400,
    );
    expect(
      (await get(`/v1/address/${wallet}/activity?limit=99999`)).status,
    ).toBe(400);
  });
  it.each([
    "0x28136a77ec8ba3d918114712a588b4095ba12a6",
    "0x28136a77ec8ba3d918114712a588b4095ba12a6bb",
    "0X28136a77ec8ba3d918114712a588b4095ba12a6b",
    "0x28136A77EC8BA3D918114712A588B4095BA12A6b",
    "0x0000000000000000000000000000000000000000",
    "%20" + wallet,
    "So11111111111111111111111111111111111111112",
    "' OR 1=1 --",
    "<script>",
  ])("malformed EVM address %s → 400", async (addr) => {
    const r = await get(`/v1/910001/address/${addr}/native-balance`);
    expect([400, 422]).toContain(r.status);
    await envelope(r);
  });
  it("API-key parsing: variants, conflicts, revoked and SQL-shaped prefixes are uniform 401", async () => {
    const statuses = [];
    for (const header of [
      `bearer ${key.plaintext}`,
      `Bearer  ${key.plaintext}`,
      `Bearer ${key.plaintext} extra`,
      `Basic ${key.plaintext}`,
      `Bearer ${key.plaintext.toUpperCase()}`,
      `Bearer ob_test_aaaaaaaaaaa'_${"x".repeat(43)}`,
      `Bearer ob_test_aaaa;DROP_TAB_${"x".repeat(43)}`,
      `Bearer ${revokedKey.plaintext}`,
      // One-character change (never equal to the real key's last character).
      `Bearer ${key.plaintext.slice(0, -1)}${key.plaintext.endsWith("A") ? "B" : "A"}`,
    ])
      statuses.push(
        (
          await get("/v1/chains?limit=1", {
            auth: null,
            headers: { authorization: header },
          })
        ).status,
      );
    expect(new Set(statuses)).toEqual(new Set([401]));
    // Two Authorization headers are combined by the platform and fail parsing (never "first wins").
    const h = new Headers();
    h.append("authorization", `Bearer ${key.plaintext}`);
    h.append("authorization", `Bearer ${revokedKey.plaintext}`);
    expect(
      (await get("/v1/chains?limit=1", { auth: null, headers: h })).status,
    ).toBe(401);
    // Authorization takes precedence over X-API-Key deterministically.
    expect(
      (
        await get("/v1/chains?limit=1", {
          auth: null,
          headers: {
            authorization: `Bearer ${revokedKey.plaintext}`,
            "x-api-key": key.plaintext,
          },
        })
      ).status,
    ).toBe(401);
    const body = await envelope(
      await get("/v1/chains?limit=1", { auth: "nope" }),
    );
    expect(body).toMatchObject({
      code: "UNAUTHORIZED",
      message: "A valid API key is required.",
    });
  });
  it("request-smuggling-relevant headers do not change routing or auth", async () => {
    const r = await get("/v1/chains?limit=1", {
      headers: {
        "transfer-encoding": "chunked",
        "x-original-url": "/v1/metrics",
        "x-http-method-override": "DELETE",
        "x-forwarded-host": "evil.example",
      },
    });
    expect(r.status).toBe(200);
  });
  it("every response is private and non-cacheable; no internal detail in errors", async () => {
    for (const p of ["/v1/chains?limit=1", "/v1/chains/1", "/v1/nope"]) {
      const r = await get(p);
      expect(r.headers.get("cache-control"), p).toBe("no-store");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  it("a datastore outage maps to 503 SERVICE_UNAVAILABLE (fail closed, no detail)", () => {
    for (const code of [
      "ECONNREFUSED",
      "CONNECTION_CLOSED",
      "CONNECT_TIMEOUT",
      "57P01",
      "08006",
    ])
      expect(datastoreUnavailable({ name: "Error", code })).toBe(true);
    for (const code of ["23505", "42P01", undefined, 7])
      expect(datastoreUnavailable({ name: "PostgresError", code })).toBe(false);
  });
  it("limiter outage is 503 for keyed and failed-auth traffic, health stays observable", async () => {
    const store = new MemoryStore();
    const broken: RateLimiter = {
      backend: "postgres",
      consume: async () => {
        throw new RateLimitUnavailable();
      },
    };
    const handle = createDataApi({
      store,
      plane: new DataPlane(store, fakeNetwork().transport, 0),
      limiter: broken,
      routing: async () => fixtureCatalog(),
    });
    const r = (path: string, auth?: string) =>
      handle(
        new Request(`http://127.0.0.1:3200${path}`, {
          headers: auth ? { authorization: `Bearer ${auth}` } : {},
        }),
      );
    expect((await r("/v1/health")).status).toBe(200);
    expect((await r("/v1/chains")).status).toBe(503);
    expect((await r("/v1/chains", generateKey("test").plaintext)).status).toBe(
      503,
    );
  });
});
describe("V15 cursor / amount / metadata properties (seeded)", () => {
  it.each(SEEDS)("seed %i: cursor round trip and garbage rejection", (seed) => {
    const r = prng(seed);
    for (let i = 0; i < 200; i++) {
      const k = [String(r.int(1e9)), r.int(1e6), r.hex(4)];
      expect(decodeCursor(encodeCursor(k))).toEqual(k);
      const garbage = Buffer.from(r.hex(r.int(60) + 1)).toString("base64url");
      let threw = false;
      try {
        decodeCursor(garbage);
      } catch (e) {
        threw = e instanceof ApiError && e.code === "INVALID_CURSOR";
      }
      expect(threw).toBe(true);
    }
    expect(() => decodeCursor("A".repeat(401))).toThrow();
    expect(() =>
      decodeCursor(
        Buffer.from(JSON.stringify({ v: 1, k: [], x: 1 })).toString(
          "base64url",
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeCursor(
        Buffer.from(
          JSON.stringify({ v: 1, k: ["a", "b", "c", "d", "e"] }),
        ).toString("base64url"),
      ),
    ).toThrow();
  });
  it.each(SEEDS)(
    "seed %i: base-unit amount grammar and 256-bit bound",
    (seed) => {
      const r = prng(seed);
      for (let i = 0; i < 300; i++) {
        const digits = r.int(80) + 1;
        const v =
          (r.int(9) + 1).toString() +
          Array.from({ length: digits - 1 }, () => r.int(10)).join("");
        expect(baseUnits.test(v)).toBe(digits <= 78);
        for (const bad of [
          ` ${v}`,
          `${v}.0`,
          `-${v}`,
          `0${v}`,
          `${v}e1`,
          `0x${v}`,
        ])
          expect(baseUnits.test(bad)).toBe(false);
        if (digits <= 78) {
          const n = BigInt(v);
          if (n < 1n << 256n) expect(boundedBigint(n)).toBe(v);
          else expect(() => boundedBigint(n)).toThrow("AMOUNT_OUT_OF_RANGE");
          if (digits <= 70) expect(platformFee(v)).toBe("0");
        }
      }
      expect(() => boundedBigint(-1n)).toThrow();
      expect(() => platformFee("1.5")).toThrow("INVALID_FEE_POLICY");
    },
  );
  it.each(SEEDS)(
    "seed %i: metadata sanitizer neutralises bidi, controls, markup and giant strings",
    (seed) => {
      const r = prng(seed);
      const evil = [
        "‮",
        "​",
        "⁦",
        "﻿",
        "\u0000",
        "<",
        ">",
        '"',
        "'",
        "`",
        "\\",
        "\u0007",
        "­",
        "؜",
      ];
      for (let i = 0; i < 200; i++) {
        const parts = Array.from({ length: r.int(30) + 1 }, () =>
          r.next() < 0.4 ? r.pick(evil) : String.fromCharCode(0x41 + r.int(26)),
        );
        const clean = sanitizeText(parts.join("").repeat(r.int(50) + 1), 32);
        expect(clean.length).toBeLessThanOrEqual(32);
        expect(clean).not.toMatch(/[‪-‮⁦-⁩​-‏﻿\u0000-\u001f<>"'`\\­؜]/);
      }
      // Fullwidth homoglyphs normalise (NFKC) to ASCII so they cannot hide a routed symbol.
      expect(sanitizeText("ＵＳＤＣ", 32)).toBe("USDC");
      expect(
        tokenMetadataFlags("USDC", "Claim your airdrop at usdc-bonus.com")
          .suspicious,
      ).toBe(true);
      expect(suspiciousText("Tether USD", "visit t.me/free")).toBe(true);
      expect(tokenMetadataFlags(null, "x").suspicious).toBe(true);
      // Invalid ABI / UTF-8 data never throws and never yields executable text.
      expect(
        String(decodeMetadataString("0x" + "ff".repeat(64), 32) ?? ""),
      ).not.toMatch(/[<>]/);
      expect(decodeMetadataString("0xzz", 32)).toBeNull();
      expect(decodeMetadataString("0x" + "00".repeat(5000), 32)).toBeNull();
    },
  );
});
describe("V15 origin / forwarded-header properties (§43, seeded)", () => {
  const origin = "https://app.example.org";
  const policy = originPolicy({
    OTHERBRIDGE_APP_ORIGINS: origin,
    OTHERBRIDGE_TRUST_PROXY_HOPS: "1",
    NODE_ENV: "production",
    OTHERBRIDGE_PUBLIC_DEPLOYMENT: "true",
  });
  const req = (headers: Record<string, string>) =>
    new Request("http://internal/api/x", { method: "POST", headers });
  it.each(SEEDS)(
    "seed %i: only the configured trusted hop is honoured",
    (seed) => {
      const r = prng(seed);
      for (let i = 0; i < 200; i++) {
        const spoofHosts = Array.from(
          { length: r.int(4) },
          () => `${r.hex(3).slice(2)}.evil.example`,
        );
        const trusted =
          r.next() < 0.5
            ? "app.example.org"
            : `${r.hex(2).slice(2)}.other.example`;
        const forwarded = [...spoofHosts, trusted].join(", ");
        const verdict = checkOrigin(
          req({
            origin,
            host: "internal:3101",
            "x-forwarded-host": forwarded,
            "x-forwarded-proto": [
              ...spoofHosts.map(() => "http"),
              "https",
            ].join(", "),
          }),
          policy,
        );
        expect(verdict).toBe(
          trusted === "app.example.org" ? "OK" : "ORIGIN_REJECTED",
        );
        const ips = Array.from(
          { length: r.int(4) + 1 },
          () => `${r.int(223) + 1}.${r.int(255)}.${r.int(255)}.${r.int(255)}`,
        );
        const k = clientKey(req({ "x-forwarded-for": ips.join(", ") }), policy);
        const again = clientKey(
          req({ "x-forwarded-for": ["9.9.9.9", ...ips.slice(-1)].join(", ") }),
          policy,
        );
        // Client-controlled leading values never change the attribution; only the last (trusted) hop does.
        expect(k).toBe(again);
      }
    },
  );
  it("proto/host/port mismatches and non-exact origins are rejected", () => {
    const ok = {
      origin,
      host: "internal",
      "x-forwarded-host": "app.example.org",
      "x-forwarded-proto": "https",
    };
    expect(checkOrigin(req(ok), policy)).toBe("OK");
    for (const bad of [
      { ...ok, "x-forwarded-proto": "http" },
      { ...ok, "x-forwarded-host": "app.example.org:443" },
      { ...ok, origin: "https://app.example.org:443" },
      { ...ok, origin: "https://APP.example.org" },
      { ...ok, origin: "https://app.example.org/" },
      { ...ok, origin: "null" },
      { ...ok, origin: "https://app.example.org.evil.example" },
    ])
      expect(checkOrigin(req(bad), policy), JSON.stringify(bad)).toBe(
        "ORIGIN_REJECTED",
      );
    expect(() => normalizeOrigin("https://*.example.org")).toThrow();
    expect(() =>
      normalizeOrigin("https://a.example.org,https://b.example.org"),
    ).toThrow();
    expect(
      originPolicy({ OTHERBRIDGE_TRUST_PROXY_HOPS: "4" }).errors,
    ).toContain("OTHERBRIDGE_TRUST_PROXY_HOPS");
    expect(
      originPolicy({ OTHERBRIDGE_TRUST_PROXY_HOPS: "1x" }).errors,
    ).toContain("OTHERBRIDGE_TRUST_PROXY_HOPS");
    expect(
      clientKey(
        req({ "x-forwarded-for": "1.1.1.1" }),
        originPolicy({ OTHERBRIDGE_TRUST_PROXY_HOPS: "0" }),
      ),
    ).toBeNull();
  });
});
describe("V15 staging/production configuration schema (§42)", () => {
  const strong = "A".repeat(10) + "b".repeat(10) + "1234567";
  const pub = (extra: Record<string, string>) =>
    dataConfig({
      NODE_ENV: "production",
      OTHERBRIDGE_PUBLIC_DEPLOYMENT: "true",
      OTHERBRIDGE_RATE_LIMIT_BACKEND: "postgres",
      OTHERBRIDGE_DATA_PSEUDONYM_KEY: "k".repeat(40),
      OTHERBRIDGE_DATA_DATABASE_URL: `postgres://otherbridge_api:${strong}@postgres:5432/otherbridge_data`,
      ...extra,
    });
  it("a correct public-mode configuration has no errors", () => {
    expect(pub({}).errors).toEqual([]);
  });
  it.each([
    [
      { OTHERBRIDGE_PUBLIC_DEPLOYMENT: "TRUE" },
      "OTHERBRIDGE_PUBLIC_DEPLOYMENT",
    ],
    [{ OTHERBRIDGE_PUBLIC_DEPLOYMENT: "1" }, "OTHERBRIDGE_PUBLIC_DEPLOYMENT"],
    [
      { OTHERBRIDGE_PUBLIC_DEPLOYMENT: "false " },
      "OTHERBRIDGE_PUBLIC_DEPLOYMENT",
    ],
    [
      { OTHERBRIDGE_REQUIRE_DURABLE_RATE_LIMIT: "yes" },
      "OTHERBRIDGE_REQUIRE_DURABLE_RATE_LIMIT",
    ],
    [
      { OTHERBRIDGE_RATE_LIMIT_BACKEND: "memory" },
      "DURABLE_RATE_LIMIT_REQUIRED",
    ],
    [{ OTHERBRIDGE_DATA_PSEUDONYM_KEY: "" }, "PSEUDONYM_KEY_REQUIRED"],
    // Built at runtime so the repository secret scanner never sees a literal credential URL.
    [
      {
        OTHERBRIDGE_DATA_DATABASE_URL: [
          "postgres://otherbridge_api",
          "postgres@postgres:5432/db",
        ].join(":"),
      },
      "DATABASE_PASSWORD_WEAK",
    ],
    [
      {
        OTHERBRIDGE_DATA_DATABASE_URL: [
          "postgres://otherbridge_api",
          "short@postgres:5432/db",
        ].join(":"),
      },
      "DATABASE_PASSWORD_WEAK",
    ],
    [
      {
        OTHERBRIDGE_DATA_DATABASE_URL: `postgres://u:${strong}@db.example.com:5432/db`,
      },
      "DATABASE_TLS_REQUIRED",
    ],
    [
      {
        OTHERBRIDGE_DATA_DATABASE_URL: `postgres://u:${strong}@203.0.113.9:5432/db`,
      },
      "DATABASE_TLS_REQUIRED",
    ],
    [{ OTHERBRIDGE_DEPLOYMENT_ENV: "prod" }, "OTHERBRIDGE_DEPLOYMENT_ENV"],
  ])("fails closed on %o", (extra, error) => {
    expect(pub(extra as Record<string, string>).errors).toContain(error);
  });
  it("TLS to a managed database with verification is accepted; private hosts need no TLS flag", () => {
    expect(
      pub({
        OTHERBRIDGE_DATA_DATABASE_URL: `postgres://u:${strong}@db.example.com:5432/db?sslmode=verify-full`,
      }).errors,
    ).toEqual([]);
    expect(
      pub({
        OTHERBRIDGE_DATA_DATABASE_URL: `postgres://u:${strong}@10.0.0.5:5432/db`,
      }).errors,
    ).toEqual([]);
  });
  it("hostile switches cannot produce execution/fee anomalies (invariants are code constants)", () => {
    expect(
      pub({
        REAL_EXECUTION: "true",
        OTHERBRIDGE_FEE_BPS: "10",
        OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION: "true",
      }).errors,
    ).toEqual([]);
  });
  it("metrics listener requires a strong token and a loopback/container bind", () => {
    expect(metricsListenerConfig({}).enabled).toBe(false);
    expect(
      metricsListenerConfig({ OTHERBRIDGE_METRICS_PORT: "3291" }).errors,
    ).toContain("OTHERBRIDGE_METRICS_TOKEN");
    expect(
      metricsListenerConfig({
        OTHERBRIDGE_METRICS_PORT: "80",
        OTHERBRIDGE_METRICS_TOKEN: "t".repeat(40),
      }).errors,
    ).toContain("OTHERBRIDGE_METRICS_PORT");
    expect(
      metricsListenerConfig({
        OTHERBRIDGE_METRICS_PORT: "3291",
        OTHERBRIDGE_METRICS_HOST: "192.168.1.5",
        OTHERBRIDGE_METRICS_TOKEN: "t".repeat(40),
      }).errors,
    ).toContain("OTHERBRIDGE_METRICS_HOST");
    expect(
      metricsListenerConfig({
        OTHERBRIDGE_METRICS_PORT: "3291",
        OTHERBRIDGE_METRICS_TOKEN: "t".repeat(40),
      }),
    ).toMatchObject({ enabled: true, host: "127.0.0.1" });
    const token = "s".repeat(40);
    expect(authorized(`Bearer ${token}`, token)).toBe(true);
    for (const h of [
      undefined,
      "",
      `bearer ${token}`,
      `Bearer ${token}x`,
      `Bearer ${token.slice(1)}`,
      `Basic ${token}`,
      `Bearer ${token} `,
    ])
      expect(authorized(h, token), String(h)).toBe(false);
  });
});
describe("V15 logs and metrics hygiene (§24, §30)", () => {
  it("log redaction defeats injection, secrets and addresses", () => {
    const k = generateKey("live").plaintext;
    const evil = `scan ${wallet}\n{"event":"forged"}\r\u001b[31m‮evil Bearer abc.def postgres://u:p@h/db token=xyz api_key=123 ${k} So11111111111111111111111111111111111111112`;
    const out = String(redactValue(evil));
    expect(out).not.toMatch(/\n|\r|\u001b|‮/);
    expect(out).not.toContain(wallet);
    expect(out).not.toContain(k);
    expect(out).not.toMatch(/abc\.def|u:p@h|xyz|=123/);
    expect(out.length).toBeLessThanOrEqual(300);
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (s: string) => (
      writes.push(s),
      true
    );
    try {
      logEvent("evil\nevent", { "bad key\n": "x", note: evil });
      logEvent("ok.event", { requestId: "req_aaaaaaaaaaaaaaaaaaaaaaaa" });
    } finally {
      (process.stdout as { write: unknown }).write = original;
    }
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w.trim().split("\n")).toHaveLength(1);
      const parsed = JSON.parse(w);
      expect(Object.keys(parsed)).not.toContain("bad key\n");
    }
    expect(JSON.parse(writes[0]).event).toBe("invalid.event");
  });
  it("metric labels: addresses rejected, injection characters neutralised, cardinality capped", () => {
    const r = newRegistry(5);
    expect(() => r.inc("x", { wallet })).toThrow("ADDRESS_IN_METRIC_LABEL");
    expect(() =>
      r.inc("x", { token: "So11111111111111111111111111111111111111112" }),
    ).toThrow("ADDRESS_IN_METRIC_LABEL");
    expect(() => r.inc("Bad-Name", {})).toThrow("METRIC_NAME_INVALID");
    expect(() => r.inc("x", { "bad label": "v" })).toThrow(
      "METRIC_LABEL_NAME_INVALID",
    );
    r.inc("x", { v: 'a"}\nfake_metric 1' });
    for (let i = 0; i < 20; i++) r.inc("y", { n: String(i) });
    const text = r.render();
    expect(text).not.toMatch(/^fake_metric/m);
    expect(text.match(/^otherbridge_y\{/gm)).toHaveLength(5);
    expect(text).toMatch(
      /otherbridge_metrics_series_dropped_total\{metric="y"\} 15/,
    );
    // Every sample line is valid exposition syntax.
    for (const line of text.split("\n").filter((l) => l && !l.startsWith("#")))
      expect(line).toMatch(
        /^[a-z_][a-z0-9_]*(\{([a-z_][a-z0-9_]*="[^"\n]*",?)*\})? -?[0-9.e+-]+$/,
      );
  });
  it("ops exporter without a datastore still exports invariants and db_up=0", async () => {
    const text = await collectOpsMetrics(null);
    expect(text).toMatch(/otherbridge_db_up 0/);
    expect(text).toMatch(/otherbridge_security_execution_gate_open 0/);
    expect(text).toMatch(/otherbridge_security_global_kill_enabled 1/);
    expect(text).toMatch(/otherbridge_security_write_registry_entries 0/);
    expect(text).toMatch(/otherbridge_security_fee_collection_enabled 0/);
    expect(text).not.toMatch(/0x[0-9a-f]{40}/i);
  });
});
describe("V15 SQL boundary (§56)", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  it("dynamic SQL (sql.unsafe / raw identifiers) is confined to an audited allowlist", () => {
    const hits: string[] = [];
    for (const f of [...walk("src"), ...walk("services")].filter((p) =>
      /\.ts$/.test(p),
    )) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\.unsafe\(|sql\(\s*t\s*\)|\$\{s\.sql\(/g))
        hits.push(
          `${f.replace(/\\/g, "/")}:${text.slice(0, m.index).split("\n").length}`,
        );
    }
    // migrate.ts: checksum-pinned migration files; data.ts: role DDL with constant role names and a
    // client-computed SCRAM verifier, grants.sql, db:status table identifiers from a constant list.
    // V1.22 points/migrate.ts: the same pattern for the separate points schema (checksum-pinned files from
    // src/points/migrations, destructive statements refused, never run implicitly).
    const allowed =
      /^(src\/data\/store\/migrate\.ts|src\/points\/migrate\.ts|services\/data\.ts):/;
    expect(hits.filter((h) => !allowed.test(h))).toEqual([]);
    for (const store of [
      "src/data/store/postgres.ts",
      "src/points/postgres-store.ts",
    ])
      expect(readFileSync(store, "utf8")).not.toMatch(/\.unsafe\(/);
  });
  it("migrations reject destructive obfuscations", () => {
    for (const sql of [
      "DrOp TaBlE x;",
      "DROP\n/*x*/TABLE y",
      "truncate\ttokens",
      "delete  from chains",
      "ALTER TABLE a\nDROP COLUMN b",
      "alter table a rename to b",
      "REASSIGN OWNED BY a TO b",
      "DROP/**/SCHEMA public",
    ])
      expect(() => assertNonDestructive({ name: "x.sql", sql }), sql).toThrow(
        "DESTRUCTIVE_MIGRATION_REJECTED",
      );
    expect(() =>
      assertNonDestructive({
        name: "ok.sql",
        sql: "-- DROP TABLE x is only a comment\nCREATE TABLE IF NOT EXISTS t (id int);",
      }),
    ).not.toThrow();
  });
});
describe("V15 RPC boundary (§57)", () => {
  const ep = { id: "e", chainId: "1", url: "https://rpc.example.org" };
  const via = (raw: unknown) => async () => raw;
  it.each([
    ["invalid JSON envelope", "nope", "INVALID_RESPONSE"],
    [
      "id mismatch",
      { jsonrpc: "2.0", id: 2, result: "0x1" },
      "INVALID_RESPONSE",
    ],
    ["missing result", { jsonrpc: "2.0", id: 1 }, "INVALID_RESPONSE"],
    [
      "range error message",
      {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32005,
          message: "query returned more than 10000 results",
        },
      },
      "RANGE_TOO_LARGE",
    ],
    [
      "pruned history",
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "missing trie node" },
      },
      "HISTORY_PRUNED",
    ],
  ])("%s fails closed", async (_n, raw, code) => {
    await expect(
      rpcCall(
        via(raw),
        ep,
        { method: "eth_chainId", params: [] },
        { ecosystem: "EVM" },
      ),
    ).rejects.toMatchObject({ code });
  });
  it("prototype keys in JSON are rejected; batches with foreign/duplicate ids are invalid", async () => {
    expect(() => safeJson('{"__proto__":{"x":1}}')).toThrow(RpcError);
    expect(() => safeJson('{"a":{"constructor":{"prototype":1}}}')).toThrow(
      RpcError,
    );
    await expect(
      rpcBatch(
        via([
          { jsonrpc: "2.0", id: 1, result: "0x1" },
          { jsonrpc: "2.0", id: 1, result: "0x2" },
        ]),
        ep,
        [
          { method: "eth_chainId", params: [] },
          { method: "eth_blockNumber", params: [] },
        ],
        { ecosystem: "EVM" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(
      rpcBatch(
        via([{ jsonrpc: "2.0", id: 9, result: "0x1" }]),
        ep,
        [{ method: "eth_chainId", params: [] }],
        { ecosystem: "EVM" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("write/admin methods and unvetted call targets never leave the process", () => {
    for (const method of [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "eth_sign",
      "personal_sign",
      "eth_signTypedData_v4",
      "debug_traceTransaction",
      "admin_peers",
      "eth_accounts",
    ])
      expect(
        () => assertAllowed({ method, params: [] }, { ecosystem: "EVM" }),
        method,
      ).toThrow();
    expect(() =>
      assertAllowed(
        {
          method: "eth_call",
          params: [
            { to: wallet, data: "0xa9059cbb" + "00".repeat(64) },
            "latest",
          ],
        },
        { ecosystem: "EVM" },
      ),
    ).toThrow();
    expect(() =>
      assertAllowed(
        {
          method: "eth_getLogs",
          params: [
            {
              fromBlock: "0x1",
              toBlock: "0x3000",
              topics: ["0x" + "0".repeat(64)],
            },
          ],
        },
        { ecosystem: "EVM" },
      ),
    ).toThrow();
  });
});
describe("V15 backup envelope", () => {
  it("AES-256-GCM round trip; tamper, truncation and wrong key fail", () => {
    const key = Buffer.alloc(32, 7);
    const plain = Buffer.from("PGDMP synthetic backup bytes ".repeat(100));
    const blob = encryptBackup(plain, key);
    expect(decryptBackup(blob, key)).toEqual(plain);
    expect(blob.includes(plain.subarray(0, 20))).toBe(false);
    const flipped = Buffer.from(blob);
    flipped[flipped.length - 5] ^= 1;
    expect(() => decryptBackup(flipped, key)).toThrow();
    expect(() =>
      decryptBackup(blob.subarray(0, blob.length - 10), key),
    ).toThrow();
    expect(() => decryptBackup(blob, Buffer.alloc(32, 8))).toThrow();
    expect(() => decryptBackup(Buffer.from("nope"), key)).toThrow(
      "ENCRYPTED_FORMAT_INVALID",
    );
    expect(() => encryptBackup(plain, Buffer.alloc(16))).toThrow(
      "ENCRYPTION_KEY_INVALID",
    );
  });
  // Self-review D3: the scan must see secrets in compressed table data, so verify streams the
  // decompressed rendering through this scanner; matches straddling chunk boundaries still count.
  it("plaintext-secret scanner: patterns, chunk boundaries, compressed bytes are opaque", () => {
    const key = ["ob", "live", "a1b2c3d4e5f6", "Z".repeat(40)].join("_");
    const url = ["postgres", "://svc:", "hunter", "22@db:5432/x"].join("");
    const pem = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    const text = `COPY t (v) FROM stdin;\n${"x".repeat(5000)}${key}\n${url}\n${pem}\n`;
    expect(countSecrets(text)).toBe(3);
    for (const size of [1, 7, 64, 1023, 1024, 1025, 4096]) {
      const s = createSecretScanner();
      for (let i = 0; i < text.length; i += size)
        s.push(text.slice(i, i + size));
      expect(s.hits, `chunk ${size}`).toBe(3);
    }
    // The same rows deflated (as pg_dump -Fc -Z6 stores table data) are invisible to a raw scan.
    expect(countSecrets(deflateSync(Buffer.from(text.repeat(5))))).toBe(0);
    expect(countSecrets(`${"ob_live_short_x"} postgres://host/db`)).toBe(0);
  });
});
