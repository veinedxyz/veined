import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  checkCredentials,
  checkUniswapChains,
  validateJupiterModes,
} from "../../src/release/credentials";
import {
  evaluateExternalGates,
  inspectExternalReceipt,
  manifestErrors,
  securityAuditResultSchema,
  pentestResultSchema,
  legalApprovalSchema,
  V116_BLOCKERS,
} from "../../src/release/external-gates";

const identity = {
  rcId: "OTHERBRIDGE_RC_V1_16_synthetic-only",
  sourceCheckpoint: "a".repeat(64),
  sourceManifest: "b".repeat(64),
  buildHash: "c".repeat(64),
  protectedBaseline: "d".repeat(64),
};
const now = Date.parse("2026-10-15T12:00:00Z");
const base = {
  ...identity,
  schemaVersion: 1,
  issuedAt: "2026-10-15T00:00:00Z",
  expiresAt: "2026-10-16T00:00:00Z",
  reportSha256: "e".repeat(64),
  reportReference: "synthetic-negative-test",
  independentReviewer: "synthetic-not-auditor",
  scopeCheckpoint: identity.sourceCheckpoint,
  verificationReference: "synthetic-unverified",
};
const severityCounts = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  informational: 0,
};
const retest = {
  performed: true,
  date: base.issuedAt,
  reportSha256: "f".repeat(64),
  remainingFindings: [],
};
// Synthetic schema fixtures explicitly lack external authority. Every inspector must reject them.
const audit = {
  ...base,
  kind: "SECURITY_AUDIT",
  auditor: "synthetic-not-auditor",
  scope: ["synthetic scope only"],
  severityCounts,
  unresolvedFindings: [],
  retest,
};
const pentest = {
  ...base,
  kind: "PENTEST",
  target: "https://private-staging.example",
  targetEnvironment: "private-staging",
  authorizedBy: "synthetic-no-authority",
  rulesOfEngagementSha256: "f".repeat(64),
  startedAt: "2026-10-15T01:00:00Z",
  endedAt: "2026-10-15T02:00:00Z",
  severityCounts,
  unresolvedFindings: [],
  retest,
};
const legal = {
  ...base,
  kind: "LEGAL_APPROVAL",
  version: "V1.17",
  documentsReviewed: [{ path: "synthetic-document", sha256: "f".repeat(64) }],
  providerTerms: [
    {
      provider: "synthetic-provider",
      reference: "synthetic-reference",
      approved: true,
    },
  ],
  rpcTerms: [
    {
      operator: "synthetic-operator",
      reference: "synthetic-reference",
      approved: true,
    },
  ],
  jurisdictionPolicy: "synthetic-not-policy",
  approvalIdentity: "synthetic-not-counsel",
  approvalReference: "synthetic-no-approval",
  conditions: [],
};
const manifest = () =>
  JSON.parse(readFileSync("release/EXTERNAL_GATES.json", "utf8"));
describe("V1.17 credential boundary", () => {
  it("spaces fast successful Jupiter replies within unchanged rolling quota", async () => {
    let clock = 0;
    const starts: number[] = [];
    expect(
      await validateJupiterModes(
        ["JUPITER_META", "JUPITER_ROUTER"],
        async () => {
          starts.push(clock);
          return true;
        },
        async (ms) => {
          clock += ms;
        },
      ),
    ).toBe(true);
    expect(starts).toEqual([0, 1005]);
  });
  it("does not wait or probe a disabled Jupiter mode", async () => {
    const quote = vi.fn(async () => true),
      pause = vi.fn();
    expect(await validateJupiterModes(["JUPITER_ROUTER"], quote, pause)).toBe(
      true,
    );
    expect(quote).toHaveBeenCalledExactlyOnceWith("JUPITER_ROUTER");
    expect(pause).not.toHaveBeenCalled();
  });
  it("propagates Jupiter cancellation without a later request", async () => {
    const quote = vi.fn(async () => true);
    await expect(
      validateJupiterModes(
        ["JUPITER_META", "JUPITER_ROUTER"],
        quote,
        async () => {
          throw Error("synthetic-cancelled");
        },
      ),
    ).rejects.toThrow("synthetic-cancelled");
    expect(quote).toHaveBeenCalledTimes(1);
  });
  it("makes zero network calls without credentials", async () => {
    const probe = vi.fn();
    const r = await checkCredentials({}, probe);
    expect(probe).not.toHaveBeenCalled();
    expect(
      r.providers
        .slice(0, 3)
        .every((row) => row.status === "OWNER_INPUT_REQUIRED"),
    ).toBe(true);
  });
  it("does not treat configured as authenticated", async () => {
    const r = await checkCredentials({
      UNISWAP_API_KEY: "synthetic-private-marker",
    });
    expect(r.providers[0].status).toBe("CONFIGURED_NOT_CHECKED");
    expect(JSON.stringify(r)).not.toContain("synthetic-private-marker");
  });
  it.each(["UNISWAP", "TITAN", "PANCAKESWAP_X_INTENT"])(
    "respects %s kill without a request",
    async (mode) => {
      const probe = vi.fn(async () => true);
      const r = await checkCredentials(
        {
          UNISWAP_API_KEY: "marker",
          JUPITER_API_KEY: "marker",
          TITAN_AUTH_TOKEN: "marker",
          TITAN_WS_ENDPOINT: "wss://api.titan.exchange/api/v1/ws",
          PCSX_INTEGRATOR_KEY: "marker",
          PCSX_QUOTE_ENABLED: "true",
          SWAP_DISABLED_PROVIDERS: mode,
        },
        probe,
      );
      const provider =
        mode === "UNISWAP"
          ? "Uniswap"
          : mode.startsWith("JUPITER")
            ? "Jupiter"
            : mode === "TITAN"
              ? "Titan"
              : "PCSX";
      expect(probe.mock.calls.flat()).not.toContain(provider);
      expect(r.providers.find((row) => row.provider === provider)?.status).toBe(
        "KILLED",
      );
    },
  );
  it.each(["JUPITER_META", "JUPITER_ROUTER"])(
    "checks remaining active Jupiter mode when %s killed",
    async (mode) => {
      const calls: { provider: string; modes: readonly string[] }[] = [];
      const r = await checkCredentials(
        { JUPITER_API_KEY: "marker", SWAP_DISABLED_PROVIDERS: mode },
        async (provider, modes) => {
          calls.push({ provider, modes });
          return true;
        },
      );
      expect(calls).toEqual([
        {
          provider: "Jupiter",
          modes: [mode === "JUPITER_META" ? "JUPITER_ROUTER" : "JUPITER_META"],
        },
      ]);
      expect(r.providers[1].status).toBe("READ_ONLY_PASS");
    },
  );
  it("does not probe fully killed Jupiter", async () => {
    const probe = vi.fn();
    const r = await checkCredentials(
      {
        JUPITER_API_KEY: "marker",
        SWAP_DISABLED_PROVIDERS: "JUPITER_META,JUPITER_ROUTER",
      },
      probe,
    );
    expect(probe).not.toHaveBeenCalled();
    expect(r.providers[1].status).toBe("KILLED");
  });
  it.each([
    "OTHERBRIDGE_EXECUTION_ENABLED",
    "SWAP_EXECUTION_ENABLED",
    "BRIDGE_EXECUTION_ENABLED",
    "G7_EXECUTION_ENABLED",
  ])("refuses %s before authentication", async (key) => {
    const probe = vi.fn();
    const r = await checkCredentials(
      { [key]: "true", UNISWAP_API_KEY: "marker" },
      probe,
    );
    expect(probe).not.toHaveBeenCalled();
    expect(r.errors).toContain("EXECUTION_FLAG_FORBIDDEN");
  });
  it.each([
    { OTHERBRIDGE_GLOBAL_KILL: "false" },
    { NEXT_PUBLIC_UNISWAP_API_KEY: "marker" },
    { TITAN_WS_ENDPOINT: "wss://evil.example" },
    { SWAP_DISABLED_PROVIDERS: "TYPO" },
    { UNISWAP_API_KEY: "marker\nsecret" },
  ])("refuses dangerous configuration %j", async (env) => {
    const probe = vi.fn();
    const r = await checkCredentials(env, probe);
    expect(probe).not.toHaveBeenCalled();
    expect(
      r.providers.some((row) => row.status === "INVALID_CONFIGURATION"),
    ).toBe(true);
  });
  it("redacts exception message, stack, headers and credential", async () => {
    const marker = "synthetic-secret-must-not-escape";
    const r = await checkCredentials({ UNISWAP_API_KEY: marker }, async () => {
      throw Object.assign(Error(marker), {
        headers: { Authorization: marker },
      });
    });
    expect(r.providers[0].status).toBe("READ_ONLY_FAILED");
    expect(JSON.stringify(r)).not.toContain(marker);
  });
  it("does not request PCSX integrator key for anonymous launch", async () => {
    const probe = vi.fn();
    const r = await checkCredentials({ PCSX_QUOTE_ENABLED: "true" }, probe);
    expect(probe).not.toHaveBeenCalled();
    expect(r.providers[3].status).toBe("ANONYMOUS_QUOTA_SUFFICIENT");
    expect(r.pcsxQuota.sharedEgressVerification).toBe("OWNER_INPUT_REQUIRED");
  });
  it("validates fixed Uniswap chain endpoint without exposing response", async () => {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            chains: [{ chainId: 1 }, { chainId: 56 }, { chainId: 8453 }],
          }),
        ),
    );
    expect(await checkUniswapChains("synthetic-marker", f)).toBe(true);
    expect(f.mock.calls[0][0]).toBe(
      "https://trade-api.gateway.uniswap.org/v1/supported_chains",
    );
    expect(f.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      method: "GET",
      headers: { "x-api-key": "synthetic-marker" },
    });
  });
  it.each([401, 403, 429, 500])(
    "rejects HTTP %s without reading reflected secret",
    async (status) =>
      expect(
        await checkUniswapChains(
          "marker",
          async () => new Response("marker", { status }),
        ),
      ).toBe(false),
  );
  it.each(["{}", '{"chains":[{"chainId":1}]}', "not-json", "x".repeat(262145)])(
    "rejects malformed or bounded chain responses",
    async (body) =>
      expect(
        await checkUniswapChains("marker", async () => new Response(body)),
      ).toBe(false),
  );
  it("redacts network failures", async () =>
    expect(
      await checkUniswapChains("marker", async () => {
        throw Error("marker");
      }),
    ).toBe(false));
});
describe("V1.17 external gate contracts", () => {
  it.each([
    "sourceCheckpoint",
    "sourceManifest",
    "buildHash",
    "protectedBaseline",
  ])("rejects canonical identity substitution %s", (key) => {
    const m = manifest();
    m.technicalBase[key] = "0".repeat(64);
    expect(manifestErrors(m)).toContain("CANONICAL_BASE_MISMATCH_" + key);
  });
  it("rejects substituted immutable audit ZIP", () => {
    const m = manifest();
    m.auditPackageSha256 = "0".repeat(64);
    expect(manifestErrors(m)).toContain("AUDIT_PACKAGE_MISMATCH");
  });
  it("rejects canonical candidate file drift", async () => {
    const m = manifest();
    const r = evaluateExternalGates({
      manifest: m,
      credentials: await checkCredentials({}),
      canonicalBase: { ...m.technicalBase, buildHash: "0".repeat(64) },
    });
    expect(r.errors).toContain("CANONICAL_CANDIDATE_DRIFT");
  });
  it("rejects future retest date", () =>
    expect(
      inspectExternalReceipt(
        "audit",
        { ...audit, retest: { ...retest, date: "2030-01-01T00:00:00Z" } },
        identity,
        now,
      ).errors,
    ).toContain("RETEST_DATE_INVALID"));
  it("accounts for every original blocker without engineering categories", () =>
    expect(manifestErrors(manifest())).toEqual([]));
  it.each(V116_BLOCKERS)("cannot drop %s by renaming", (id) => {
    const m = manifest();
    m.actions = m.actions.map((row: { id: string }) =>
      row.id === id ? { ...row, id: "RENAMED_ACTION" } : row,
    );
    expect(manifestErrors(m)).toContain("MISSING_BLOCKER_" + id);
  });
  it("rejects duplicate actions", () => {
    const m = manifest();
    m.actions.push(m.actions[0]);
    expect(manifestErrors(m)).toContain("DUPLICATE_ACTION_ID");
  });
  it.each(["ENGINEERING_TODO", "PRODUCTION_HOST_CONFIGURATION"])(
    "rejects category %s",
    (category) => {
      const m = manifest();
      m.actions[0].category = category;
      expect(manifestErrors(m)).toContain("MANIFEST_SCHEMA_INVALID");
    },
  );
  it.each([null, {}, { status: "PASS" }])(
    "rejects fabricated audit result",
    (raw) =>
      expect(inspectExternalReceipt("audit", raw, identity, now).accepted).toBe(
        false,
      ),
  );
  it.each([
    ["audit", audit, securityAuditResultSchema],
    ["pentest", pentest, pentestResultSchema],
    ["legal", legal, legalApprovalSchema],
  ] as const)(
    "schema-valid %s never establishes external authority",
    (kind, raw, schema) => {
      expect(schema.safeParse(raw).success).toBe(true);
      expect(inspectExternalReceipt(kind, raw, identity, now)).toMatchObject({
        accepted: false,
        errors: ["EXTERNAL_AUTHORITY_NOT_VERIFIED"],
      });
    },
  );
  it.each([
    "rcId",
    "sourceCheckpoint",
    "sourceManifest",
    "buildHash",
    "protectedBaseline",
  ] as const)("rejects stale artifact %s", (key) => {
    expect(
      inspectExternalReceipt(
        "audit",
        {
          ...audit,
          [key]: key === "rcId" ? "OTHERBRIDGE_RC_V1_16_old" : "0".repeat(64),
        },
        identity,
        now,
      ).errors,
    ).toContain("RECEIPT_IDENTITY_MISMATCH");
  });
  it.each([
    Date.parse("2026-10-14T00:00:00Z"),
    Date.parse("2026-10-17T00:00:00Z"),
    NaN,
  ])("rejects stale/future/invalid clock %s", (clock) =>
    expect(
      inspectExternalReceipt("audit", audit, identity, clock).errors,
    ).toContain("RECEIPT_TIME_INVALID"),
  );
  it("rejects critical/high results and unperformed retest", () => {
    const r = inspectExternalReceipt(
      "audit",
      {
        ...audit,
        severityCounts: { ...severityCounts, high: 1 },
        retest: { ...retest, performed: false },
      },
      identity,
      now,
    );
    expect(r.errors).toContain("SEVERITY_REQUIRES_INDEPENDENT_DISPOSITION");
    expect(r.errors).toContain("RETEST_REQUIRED");
  });
  it("rejects production pentest target classification", () =>
    expect(
      pentestResultSchema.safeParse({
        ...pentest,
        targetEnvironment: "production",
      }).success,
    ).toBe(false));
  it("missing owner domain/Privy/RPC evidence stays incomplete", async () => {
    const c = await checkCredentials({});
    const r = evaluateExternalGates({ manifest: manifest(), credentials: c });
    expect(r.ownerStatuses).toEqual({
      domain: "OWNER_INPUT_REQUIRED",
      privy: "OWNER_INPUT_REQUIRED",
      hosting: "OWNER_INPUT_REQUIRED",
      rpc: "OWNER_INPUT_REQUIRED",
    });
    expect(r.status).toBe("EXTERNAL_GATES_INCOMPLETE");
    expect(r.authorization).toBe(false);
  });
  it("all credential keys and fabricated approvals cannot enable execution", async () => {
    const c = await checkCredentials(
      {
        UNISWAP_API_KEY: "marker",
        JUPITER_API_KEY: "marker",
        TITAN_AUTH_TOKEN: "marker",
        TITAN_WS_ENDPOINT: "wss://api.titan.exchange/api/v1/ws",
      },
      async () => true,
    );
    const r = evaluateExternalGates({
      manifest: manifest(),
      credentials: c,
      audit,
      pentest,
      legal,
      ownerRelease: { status: "PASS", signature: "fabricated" },
    });
    expect(r.execution).toBe("CLOSED");
    expect(r.financialExecutionAllowed).toBe(false);
    expect(r.ownerRelease).toBe("OWNER_SIGNATURE_NOT_VERIFIED");
  });
  it("rejects stale credential receipt", async () => {
    const c = { ...(await checkCredentials({})), at: "2000-01-01T00:00:00Z" };
    expect(
      evaluateExternalGates({ manifest: manifest(), credentials: c }).errors,
    ).toContain("CREDENTIAL_STATUS_MISSING_INVALID_OR_STALE");
  });
});
