import { afterEach, describe, expect, it, vi } from "vitest";
import {
  environmentProfile,
  productionConfigSchema,
  PROVIDER_ENDPOINTS,
  releaseConfigurationErrors,
} from "../../src/release/config";
import {
  inspectReleaseReceipt,
  releaseReceiptSchema,
} from "../../src/release/receipt";
import { assertReleaseStartup } from "../../src/release/startup";
import { executeSwap, MODES } from "../../src/swap/model";
import { assertSwapEgress, ProviderQuota } from "../../src/swap/server/egress";
import { redactValue } from "../../src/data/observability/log";
import { QuoteCoordinator } from "../../src/swap/server/coordinator";
import { swapIntent } from "../fixtures/swap";

afterEach(() => vi.unstubAllEnvs());
const identity = {
  rcId: "OTHERBRIDGE_RC_V1_16_synthetic-test",
  sourceCheckpoint: "a".repeat(64),
  sourceManifest: "b".repeat(64),
  buildHash: "c".repeat(64),
  protectedBaseline: "d".repeat(64),
};
// Synthetic negative-test material, never an owner receipt or a production identity.
const receipt = {
  ...identity,
  schemaVersion: 1,
  environment: "production",
  domain: "veined.xyz",
  externalAuditHashes: ["e".repeat(64)],
  legalApprovalReferences: ["synthetic-legal-not-approval"],
  ownerApproval: {
    reference: "synthetic-owner-not-approval",
    signerKeyId: "synthetic-no-key",
    signature: "0".repeat(128),
  },
  surface: "SWAP",
  issuedAt: "2026-10-14T00:00:00Z",
  expiresAt: "2026-10-16T00:00:00Z",
  revocation: { id: "synthetic-revocation", revoked: false },
  feeBps: 0,
  globalKill: false,
};
const now = Date.parse("2026-10-15T00:00:00Z");
describe("V1.16 execution dead-man and receipt schema", () => {
  it.each([
    "OTHERBRIDGE_EXECUTION_ENABLED",
    "SWAP_EXECUTION_ENABLED",
    "BRIDGE_EXECUTION_ENABLED",
    "G7_EXECUTION_ENABLED",
  ])("rejects %s without trusting a boolean", (name) => {
    expect(releaseConfigurationErrors({ [name]: "true" })).toContain(
      "EXECUTION_FLAG_FORBIDDEN",
    );
    expect(() => assertReleaseStartup({ [name]: "true" })).toThrow(
      "RELEASE_STARTUP_REFUSED",
    );
    expect(() => executeSwap()).toThrow("EXECUTION_CLOSED");
  });
  it.each([
    "rcId",
    "sourceCheckpoint",
    "sourceManifest",
    "buildHash",
    "protectedBaseline",
  ] as const)("rejects stale/wrong %s", (key) => {
    expect(
      inspectReleaseReceipt(
        {
          ...receipt,
          [key]: key === "rcId" ? "OTHERBRIDGE_RC_V1_16_stale" : "f".repeat(64),
        },
        identity,
        "SWAP",
        now,
      ).errors,
    ).toContain(`RECEIPT_MISMATCH_${key}`);
  });
  it("does not confuse schema validity with a verified owner signature", () => {
    expect(releaseReceiptSchema.safeParse(receipt).success).toBe(true);
    const result = inspectReleaseReceipt(receipt, identity, "SWAP", now);
    expect(result.allowed).toBe(false);
    expect(result.errors).toContain("OWNER_SIGNATURE_NOT_VERIFIED");
  });
  it.each(["G7", "BRIDGE"] as const)(
    "Swap receipt cannot authorize %s",
    (surface) => {
      expect(
        inspectReleaseReceipt(receipt, identity, surface, now).errors,
      ).toContain("RECEIPT_SURFACE_MISMATCH");
    },
  );
  it("Bridge receipt cannot authorize Swap", () =>
    expect(
      inspectReleaseReceipt(
        { ...receipt, surface: "BRIDGE" },
        identity,
        "SWAP",
        now,
      ).errors,
    ).toContain("RECEIPT_SURFACE_MISMATCH"));
  it("rejects expired and future receipts", () => {
    for (const at of [
      Date.parse("2026-10-13T00:00:00Z"),
      Date.parse(receipt.expiresAt),
    ])
      expect(
        inspectReleaseReceipt(receipt, identity, "SWAP", at).errors,
      ).toContain("RECEIPT_TIME_INVALID");
  });
  it.each([
    { externalAuditHashes: [] },
    { legalApprovalReferences: [] },
    { globalKill: true },
    { feeBps: 1 },
    { revocation: { id: "revoked-test", revoked: true } },
    { ownerApproval: null },
  ])("rejects incomplete/revoked receipt %j", (change) =>
    expect(
      inspectReleaseReceipt({ ...receipt, ...change }, identity, "SWAP", now)
        .errors,
    ).toContain("RECEIPT_SCHEMA_INVALID"),
  );
});

describe("V1.16 configuration and secret custody", () => {
  const production = {
    OTHERBRIDGE_DEPLOYMENT_ENV: "production",
    OTHERBRIDGE_SECRET_ENVIRONMENT: "production",
    OTHERBRIDGE_APP_ORIGINS: "https://veined.xyz",
    OTHERBRIDGE_PUBLIC_ORIGIN: "https://veined.xyz",
    NEXT_PUBLIC_PRIVY_APP_ID: "production-public-app-id",
  };
  const config = {
    schemaVersion: 1,
    identity,
    origin: "https://veined.xyz",
    apiOrigin: "https://veined.xyz",
    processCount: 1,
    providerEndpoints: PROVIDER_ENDPOINTS,
    rpcOrigins: [
      "https://ethereum-rpc.publicnode.com",
      "https://bsc-rpc.publicnode.com",
      "https://base-rpc.publicnode.com",
      "https://api.mainnet-beta.solana.com",
    ],
    routerPinsSha256: "a".repeat(64),
    solanaPinsSha256: "b".repeat(64),
    evidenceManifest: "release/evidence.json",
    evidenceManifestSha256: "c".repeat(64),
    privyAppId: production.NEXT_PUBLIC_PRIVY_APP_ID,
    privyDashboardReviewRef: "synthetic-dashboard-review",
    secretEnvironment: "production",
    execution: "CLOSED",
    globalKill: true,
    feeBps: 0,
  };
  it.each([
    [{}, "development"],
    [{ NODE_ENV: "test" }, "test"],
    [{ NODE_ENV: "production" }, "staging-equivalent"],
    [production, "production"],
    [{ OTHERBRIDGE_PUBLIC_DEPLOYMENT: "true" }, "production"],
  ])("classifies profile %j", (env, expected) =>
    expect(environmentProfile(env as Record<string, string>)).toBe(expected),
  );
  it("refuses absent production evidence before starting", () =>
    expect(() => assertReleaseStartup(production)).toThrow(
      "PRODUCTION_CONFIG_UNAVAILABLE",
    ));
  it("keeps production RPCs awaiting legal approval blocked", () =>
    expect(releaseConfigurationErrors(production, config)).toContain(
      "UNAPPROVED_RPC",
    ));
  it.each([
    "test-key",
    "placeholder-secret-xxxxxxxxxxxxxxxxxxxx",
    "staging-xxxxxxxxxxxxxxxxxxxxxxxx",
    "short",
  ])("rejects non-production secret %s", (value) =>
    expect(
      releaseConfigurationErrors(
        { ...production, UNISWAP_API_KEY: value },
        config,
      ),
    ).toContain("INVALID_SECRET_UNISWAP_API_KEY"),
  );
  it.each([
    { origin: "http://localhost:3101" },
    { processCount: 2 },
    { execution: "OPEN" },
    { feeBps: 10 },
    {
      providerEndpoints: {
        ...PROVIDER_ENDPOINTS,
        uniswap: "https://attacker.invalid",
      },
    },
  ])("rejects unsafe production configuration %j", (change) =>
    expect(
      productionConfigSchema.safeParse({ ...config, ...change }).success,
    ).toBe(false),
  );
  it("rejects secrets in the public namespace", () =>
    expect(
      releaseConfigurationErrors({ NEXT_PUBLIC_UNISWAP_API_KEY: "canary" }),
    ).toContain("PUBLIC_SECRET_FORBIDDEN"));
  it.each([
    "apiKey",
    "TITAN_AUTH_TOKEN",
    "privyToken",
    "cookie",
    "authorization",
    "databasePassword",
    "headers",
    "rawTransaction",
    "providerResponse",
    "responseBody",
  ])("redacts %s regardless of secret value syntax", (key) =>
    expect(redactValue("v116-short-canary!", key)).toBe("[secret]"),
  );
  it("redacts wallet identifiers and cookie text", () => {
    expect(redactValue("0x" + "1".repeat(40))).toBe("[address]");
    expect(redactValue("Cookie: session=short-canary")).not.toContain("canary");
  });
});
describe("V1.16 egress, quotas and provider kills", () => {
  it.each([
    "http://127.0.0.1",
    "https://169.254.169.254/",
    "https://api.jup.ag/swap/v2/execute",
    "https://api.jup.ag.evil.invalid/swap/v2/order",
    "https://user:pass@api.jup.ag/swap/v2/order",
    "https://api.jup.ag/swap/v2/order#fragment",
    "wss://attacker.invalid/ws",
  ])("refuses arbitrary or write target %s", (url) =>
    expect(() => assertSwapEgress(url)).toThrow("REVIEW_REQUIRED"),
  );
  it("caps shared Uniswap traffic below its documented 6 RPS", () => {
    const quota = new ProviderQuota(),
      origin = "https://trade-api.gateway.uniswap.org";
    for (let i = 0; i < 5; i++) quota.take(origin, 1000);
    expect(() => quota.take(origin, 1001)).toThrow("RATE_LIMITED");
    expect(() => quota.take(origin, 2000)).not.toThrow();
    quota.throttle(origin, 2001);
    expect(() => quota.take(origin, 3000)).toThrow("RATE_LIMITED");
    expect(() => quota.take(origin, 62001)).not.toThrow();
  });
  it.each(MODES)(
    "kills %s even on an already created coordinator",
    async (mode) => {
      const quote = vi.fn(),
        coordinator = new QuoteCoordinator([
          {
            mode,
            provider: "Uniswap",
            chains: ["1"],
            exactOut: true,
            quote,
          },
        ]);
      vi.stubEnv("SWAP_DISABLED_PROVIDERS", mode);
      const events: unknown[] = [];
      await coordinator.compete(
        swapIntent(),
        new AbortController().signal,
        (e) => events.push(e),
      );
      expect(quote).not.toHaveBeenCalled();
      expect(events).toContainEqual({ type: "providers", providers: [] });
    },
  );
});
