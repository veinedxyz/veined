import { z } from "zod";
import { releaseIdentitySchema, sha256Schema } from "./receipt";

export const GATE_CATEGORIES = [
  "OWNER_INPUT",
  "PROVIDER_ONBOARDING",
  "DOMAIN_CONTROL",
  "HOSTING_DECISION",
  "RPC_COMMERCIAL_TERMS",
  "EXTERNAL_SECURITY_AUDIT",
  "EXTERNAL_PENTEST",
  "LEGAL_REVIEW",
  "OWNER_RELEASE_APPROVAL",
  "OWNER_G7_PILOT_APPROVAL",
  "OWNER_SWAP_PILOT_APPROVAL",
] as const;
export const V116_BLOCKERS = [
  "OWNER_INPUT_UNISWAP_API_KEY",
  "OWNER_INPUT_JUPITER_API_KEY",
  "OWNER_INPUT_TITAN_WS_ENDPOINT",
  "OWNER_INPUT_TITAN_AUTH_TOKEN",
  "OWNER_INPUT_PCSX_TRAFFIC_QUOTA",
  "OWNER_INPUT_DOMAIN_CONTROL",
  "OWNER_INPUT_PRIVY_PRODUCTION",
  "OWNER_INPUT_HOSTING",
  "OWNER_INPUT_RPC_TERMS",
  "EXTERNAL_SECURITY_AUDIT",
  "EXTERNAL_PENTEST",
  "LEGAL_PROVIDER_PRIVACY",
  "OWNER_RELEASE_APPROVAL",
  "OWNER_G7_PILOT_APPROVAL",
  "OWNER_SWAP_PILOT_APPROVAL",
  "OWNER_UPSTREAM_WHIRLPOOL_REVIEW",
] as const;
const text = z.string().min(8).max(4000);
const url = z.url({ protocol: /^https$/ });
export const V116_TECHNICAL_BASE = Object.freeze({
  rcId: "OTHERBRIDGE_RC_V1_16_20261015T133159055Z-16dfa3",
  sourceCheckpoint:
    "11bea158a16dc3f0528c4b6a9c24950728e1f26a3a3be86c2ca3ba5cabd5fcb9",
  sourceManifest:
    "08d5c3005ef6174e9491d0de9314d5cf53e383127a3f2ac4a5d3a901c95a3b96",
  buildHash: "60daa71188eb424bd1a8d84765d78bd9c2f0853b7a46cf4f3192ed60ddf0b052",
  protectedBaseline:
    "cf7025aeeedac022b8ffa08540ed88345e561d23b50f05ae794f3f5dec1991b4",
});
export const V116_AUDIT_PACKAGE_SHA256 =
  "1ca5636aa97c3bd35e7338a282ee7ec576c6a85c9527bde5ebd7c7bd33eb928e";
export const gateActionSchema = z
  .object({
    id: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    category: z.enum(GATE_CATEGORIES),
    priority: z.enum(["P0", "P1", "P2", "P3"]),
    status: z.enum([
      "OWNER_ACTION_REQUIRED",
      "CONDITIONAL_OWNER_ACTION",
      "SATISFIED_WITH_EVIDENCE",
    ]),
    action: text,
    website: z.union([url, z.string().regex(/^local:[A-Za-z0-9_./-]+$/)]),
    secret: z.boolean(),
    configure: text,
    validate: text,
    blocks: text,
    evidenceExpected: text,
    documentation: text,
    predecessorIds: z.array(z.enum(V116_BLOCKERS)).min(1),
    evidence: z.array(z.string().min(8)).min(1),
  })
  .strict();
export const externalGateManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    technicalBase: releaseIdentitySchema,
    auditPackageSha256: sha256Schema,
    execution: z.literal("CLOSED"),
    internalEngineeringBlockers: z.literal(0),
    actions: z.array(gateActionSchema).min(16),
    providerDecisions: z
      .object({
        pcsx: z.enum([
          "ANONYMOUS_QUOTA_SUFFICIENT_FOR_LAUNCH",
          "INTEGRATOR_KEY_REQUIRED",
        ]),
        aerodrome: z.literal(
          "PRODUCTION_CONFIG_READY / NO_PROVIDER_CREDENTIAL_REQUIRED",
        ),
      })
      .strict(),
  })
  .strict();

const severitySchema = z
  .object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    informational: z.number().int().nonnegative(),
  })
  .strict();
const reportBase = releaseIdentitySchema.extend({
  schemaVersion: z.literal(1),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  reportSha256: sha256Schema,
  reportReference: text,
  independentReviewer: text,
  scopeCheckpoint: sha256Schema,
  verificationReference: text,
});
const retest = z
  .object({
    performed: z.boolean(),
    date: z.iso.datetime().nullable(),
    reportSha256: sha256Schema.nullable(),
    remainingFindings: z.array(text),
  })
  .strict();
export const securityAuditResultSchema = reportBase
  .extend({
    kind: z.literal("SECURITY_AUDIT"),
    auditor: text,
    scope: z.array(text).min(1),
    severityCounts: severitySchema,
    unresolvedFindings: z.array(
      z
        .object({
          id: text,
          severity: z.enum([
            "critical",
            "high",
            "medium",
            "low",
            "informational",
          ]),
          disposition: text,
        })
        .strict(),
    ),
    retest,
  })
  .strict();
export const pentestResultSchema = reportBase
  .extend({
    kind: z.literal("PENTEST"),
    target: z.url(),
    targetEnvironment: z.enum(["private-staging", "local-staging"]),
    authorizedBy: text,
    rulesOfEngagementSha256: sha256Schema,
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    severityCounts: severitySchema,
    unresolvedFindings: z.array(text),
    retest,
  })
  .strict();
export const legalApprovalSchema = reportBase
  .extend({
    kind: z.literal("LEGAL_APPROVAL"),
    version: z.literal("V1.17"),
    documentsReviewed: z
      .array(z.object({ path: text, sha256: sha256Schema }).strict())
      .min(1),
    providerTerms: z
      .array(
        z
          .object({
            provider: text,
            reference: text,
            approved: z.literal(true),
          })
          .strict(),
      )
      .min(1),
    rpcTerms: z
      .array(
        z
          .object({
            operator: text,
            reference: text,
            approved: z.literal(true),
          })
          .strict(),
      )
      .min(1),
    jurisdictionPolicy: text,
    approvalIdentity: text,
    approvalReference: text,
    conditions: z.array(text),
  })
  .strict();
export const ownerEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: releaseIdentitySchema,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    domain: z
      .object({
        domain: z.literal("otherbridge.io"),
        registrar: text,
        dnsProvider: text,
        controlReference: text,
      })
      .strict()
      .optional(),
    privy: z
      .object({
        appId: text,
        origin: z.literal("https://otherbridge.io"),
        externalWalletOnly: z.literal(true),
        embeddedWallets: z.literal(false),
        emailSocial: z.literal(false),
        delegatedSigner: z.literal(false),
        sessionSigner: z.literal(false),
        serverWalletExecution: z.literal(false),
        reviewReference: text,
      })
      .strict()
      .optional(),
    hosting: z
      .object({
        decisionReference: text,
        secretCustodyReference: text,
        processCount: z.literal(1),
        sharedEgressQuotaReference: text,
      })
      .strict()
      .optional(),
    rpc: z
      .object({
        reviewReference: text,
        operators: z.array(text).min(2),
        arbitrumWitnessReference: text,
        avalancheWitnessReference: text,
      })
      .strict()
      .optional(),
  })
  .strict();

export const externalStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    observedAt: z.iso.datetime(),
    technicalBase: releaseIdentitySchema,
    domain: z
      .object({
        dns: z.enum(["NXDOMAIN", "RESOLVED", "UNAVAILABLE"]),
        ownerControl: z.literal("UNKNOWN"),
      })
      .strict(),
    privy: z
      .object({
        appIdConfigured: z.boolean(),
        dashboard: z.literal("OWNER_DASHBOARD_VERIFICATION_REQUIRED"),
      })
      .strict(),
    rpc: z
      .object({
        productionApproved: z.literal(0),
        arbitrumWitness: z.enum([
          "PERSONAL_TOKEN_REQUIRED",
          "READ_ONLY_MATCH",
          "UNAVAILABLE",
        ]),
        avalancheWitness: z.enum(["READ_ONLY_MATCH", "UNAVAILABLE"]),
        terms: z.literal("LEGAL_REVIEW_REQUIRED"),
      })
      .strict(),
    whirlpool: z.literal("UNVERIFIED_UPSTREAM_CHANGE"),
    execution: z.literal("CLOSED"),
  })
  .strict();

export function manifestErrors(input: unknown) {
  const parsed = externalGateManifestSchema.safeParse(input);
  if (!parsed.success) return ["MANIFEST_SCHEMA_INVALID"];
  const errors: string[] = [];
  for (const key of Object.keys(
    V116_TECHNICAL_BASE,
  ) as (keyof typeof V116_TECHNICAL_BASE)[])
    if (parsed.data.technicalBase[key] !== V116_TECHNICAL_BASE[key])
      errors.push("CANONICAL_BASE_MISMATCH_" + key);
  if (parsed.data.auditPackageSha256 !== V116_AUDIT_PACKAGE_SHA256)
    errors.push("AUDIT_PACKAGE_MISMATCH");
  const ids = parsed.data.actions.map((row) => row.id);
  if (new Set(ids).size !== ids.length) errors.push("DUPLICATE_ACTION_ID");
  for (const id of V116_BLOCKERS) {
    // Preserve the original IDs as well as lineage; a blocker cannot disappear via renaming.
    if (!ids.includes(id)) errors.push("MISSING_BLOCKER_" + id);
    if (
      !parsed.data.actions.some(
        (row) => row.id === id && row.predecessorIds.includes(id),
      )
    )
      errors.push("MISSING_LINEAGE_" + id);
  }
  return errors;
}
type ReceiptKind = "audit" | "pentest" | "legal";
export function inspectExternalReceipt(
  kind: ReceiptKind,
  raw: unknown,
  identity: z.infer<typeof releaseIdentitySchema>,
  now = Date.now(),
) {
  const schema = {
    audit: securityAuditResultSchema,
    pentest: pentestResultSchema,
    legal: legalApprovalSchema,
  }[kind];
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return {
      accepted: false as const,
      status: "RECEIPT_SCHEMA_INVALID",
      errors: ["RECEIPT_SCHEMA_INVALID"],
    };
  const data = parsed.data;
  const errors: string[] = [];
  for (const key of Object.keys(identity) as (keyof typeof identity)[])
    if (data[key] !== identity[key]) errors.push("RECEIPT_IDENTITY_MISMATCH");
  if (data.scopeCheckpoint !== identity.sourceCheckpoint)
    errors.push("RECEIPT_SCOPE_MISMATCH");
  if (
    !Number.isFinite(now) ||
    Date.parse(data.issuedAt) > now ||
    Date.parse(data.expiresAt) <= now ||
    Date.parse(data.expiresAt) <= Date.parse(data.issuedAt)
  )
    errors.push("RECEIPT_TIME_INVALID");
  if (
    "severityCounts" in data &&
    (data.severityCounts.critical || data.severityCounts.high)
  )
    errors.push("SEVERITY_REQUIRES_INDEPENDENT_DISPOSITION");
  if ("unresolvedFindings" in data && data.unresolvedFindings.length)
    errors.push("UNRESOLVED_FINDINGS");
  if (
    "retest" in data &&
    (!data.retest.performed ||
      !data.retest.date ||
      !data.retest.reportSha256 ||
      data.retest.remainingFindings.length)
  )
    errors.push("RETEST_REQUIRED");
  if (
    "retest" in data &&
    data.retest.date &&
    (Date.parse(data.retest.date) > now ||
      Date.parse(data.retest.date) > Date.parse(data.issuedAt))
  )
    errors.push("RETEST_DATE_INVALID");
  if (
    data.kind === "PENTEST" &&
    (Date.parse(data.startedAt) > Date.parse(data.endedAt) ||
      Date.parse(data.endedAt) > now)
  )
    errors.push("PENTEST_DATES_INVALID");
  // Repository JSON is untrusted. Actual report bytes/identity/scope must be independently verified.
  errors.push("EXTERNAL_AUTHORITY_NOT_VERIFIED");
  return {
    accepted: false as const,
    status:
      errors.length === 1
        ? "SCHEMA_VALID_REQUIRES_INDEPENDENT_VERIFICATION"
        : "RECEIPT_REJECTED",
    errors: [...new Set(errors)],
  };
}

export function evaluateExternalGates(
  input: {
    manifest: unknown;
    credentials: unknown;
    ownerEvidence?: unknown;
    audit?: unknown;
    pentest?: unknown;
    legal?: unknown;
    ownerRelease?: unknown;
    canonicalBase?: unknown;
    externalStatus?: unknown;
  },
  now = Date.now(),
) {
  const errors = manifestErrors(input.manifest);
  const observations = externalStatusSchema.safeParse(input.externalStatus);
  if (
    input.externalStatus !== undefined &&
    (!observations.success ||
      Object.keys(V116_TECHNICAL_BASE).some(
        (key) =>
          observations.data.technicalBase[
            key as keyof typeof V116_TECHNICAL_BASE
          ] !== V116_TECHNICAL_BASE[key as keyof typeof V116_TECHNICAL_BASE],
      ))
  )
    errors.push("EXTERNAL_STATUS_INVALID");
  if (input.canonicalBase !== undefined) {
    const c = releaseIdentitySchema.safeParse(input.canonicalBase);
    if (
      !c.success ||
      Object.keys(V116_TECHNICAL_BASE).some(
        (key) =>
          c.data[key as keyof typeof c.data] !==
          V116_TECHNICAL_BASE[key as keyof typeof V116_TECHNICAL_BASE],
      )
    )
      errors.push("CANONICAL_CANDIDATE_DRIFT");
  }
  const manifest = externalGateManifestSchema.safeParse(input.manifest);
  const credentialSchema = z.object({
    schemaVersion: z.literal(1),
    at: z.iso.datetime(),
    execution: z.literal("CLOSED"),
    errors: z.array(z.string()),
    providers: z.array(
      z.object({
        provider: z.enum(["Uniswap", "Jupiter", "Titan", "PCSX"]),
        configured: z.boolean(),
        status: z.string(),
        requestsAttempted: z.boolean(),
      }),
    ),
  });
  const creds = credentialSchema.safeParse(input.credentials);
  const credentialsCurrent =
    creds.success &&
    Date.parse(creds.data.at) <= now &&
    now - Date.parse(creds.data.at) <= 15 * 60 * 1000;
  if (!credentialsCurrent)
    errors.push("CREDENTIAL_STATUS_MISSING_INVALID_OR_STALE");
  if (creds.success && creds.data.errors.length)
    errors.push("CREDENTIAL_CONFIGURATION_INVALID");
  const credentials = ["Uniswap", "Jupiter", "Titan"].map((provider) => ({
    provider,
    status:
      credentialsCurrent &&
      creds.success &&
      creds.data.providers.filter((row) => row.provider === provider).length ===
        1 &&
      creds.data.providers.find((row) => row.provider === provider)?.status ===
        "READ_ONLY_PASS"
        ? "READ_ONLY_PASS"
        : "OWNER_INPUT_REQUIRED",
  }));
  const owner = ownerEvidenceSchema.safeParse(input.ownerEvidence);
  const ownerCurrent =
    owner.success &&
    manifest.success &&
    Object.keys(manifest.data.technicalBase).every(
      (key) =>
        owner.data.identity[key as keyof typeof owner.data.identity] ===
        manifest.data.technicalBase[key as keyof typeof owner.data.identity],
    ) &&
    Date.parse(owner.data.issuedAt) <= now &&
    Date.parse(owner.data.expiresAt) > now &&
    Date.parse(owner.data.expiresAt) > Date.parse(owner.data.issuedAt);
  const receipts = Object.fromEntries(
    (["audit", "pentest", "legal"] as const).map((kind) => [
      kind,
      input[kind] === undefined
        ? { accepted: false, status: "RESULT_RECEIPT_MISSING" }
        : manifest.success
          ? inspectExternalReceipt(
              kind,
              input[kind],
              manifest.data.technicalBase,
              now,
            )
          : { accepted: false, status: "MANIFEST_INVALID" },
    ]),
  );
  const ownerStatuses = Object.fromEntries(
    (["domain", "privy", "hosting", "rpc"] as const).map((key) => [
      key,
      ownerCurrent && owner.success && owner.data[key]
        ? "OWNER_EVIDENCE_REQUIRES_INDEPENDENT_VERIFICATION"
        : "OWNER_INPUT_REQUIRED",
    ]),
  );
  return {
    schemaVersion: 1,
    at: new Date(now).toISOString(),
    execution: "CLOSED",
    status: "EXTERNAL_GATES_INCOMPLETE",
    authorization: false,
    errors: [...new Set(errors)],
    credentials,
    ownerStatuses,
    observedStatus: observations.success
      ? {
          observedAt: observations.data.observedAt,
          domain: observations.data.domain,
          privy: observations.data.privy,
          rpc: observations.data.rpc,
          whirlpool: observations.data.whirlpool,
        }
      : "EXTERNAL_STATUS_NOT_SUPPLIED",
    receipts,
    ownerRelease:
      input.ownerRelease === undefined
        ? "OWNER_RELEASE_RECEIPT_MISSING"
        : "OWNER_SIGNATURE_NOT_VERIFIED",
    actions: manifest.success
      ? manifest.data.actions.map((row) => ({
          id: row.id,
          category: row.category,
          status: row.status,
        }))
      : [],
    financialExecutionAllowed: false,
  };
}
