import { z } from "zod";
import inventoryFile from "./rpc-provenance.json" with { type: "json" };
// V1.5 RPC provenance / terms inventory and release policy. Engineering preparation only: no entry is
// legal approval. Independence for log witnessing is claimed only between two KNOWN, DIFFERENT
// operator groups; an unknown operator is never counted as independent of anything.
export const reviewStatusSchema = z.enum([
  "APPROVED_FOR_RELEASE",
  "APPROVED_FOR_STAGING",
  "LEGAL_REVIEW_REQUIRED",
  "PROHIBITED",
  "UNKNOWN",
]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;
const host = z
  .string()
  .regex(/^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const httpsUrl = z
  .string()
  .regex(/^https:\/\/[^\s"'<>]{4,300}$/)
  .nullable();
export const provenanceGroupSchema = z
  .object({
    operatorGroup: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    operator: z.string().min(1).max(160),
    hosts: z.array(host).min(1).max(200),
    backingProvider: z.string().max(160).nullable(),
    // Independence key when a hostname is served by another operator's infrastructure (e.g. a chain
    // foundation hostname backed by an infrastructure provider). Defaults to operatorGroup.
    backingOperatorGroup: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
      .nullable(),
    provenance: z.enum([
      "official-chain-docs",
      "operator-docs",
      "public-registry",
      "unknown",
    ]),
    officialDocsUrl: httpsUrl,
    termsUrl: httpsUrl,
    privacyUrl: httpsUrl,
    commercialUseStatus: z.enum([
      "PERMITTED_WITH_LIMITS",
      "NOT_STATED",
      "RESTRICTED",
      "PROHIBITED",
      "UNKNOWN",
    ]),
    commercialUseEvidence: z.string().max(600),
    rateLimitNotes: z.string().max(400),
    attributionRequirement: z.string().max(300),
    reviewStatus: reviewStatusSchema,
    // Only counsel/owner may set APPROVED_FOR_RELEASE, and only with a reference to that review.
    legalReviewRef: z.string().min(8).max(200).nullable(),
    witnessEligible: z.boolean(),
    observedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    uncertainty: z.string().max(600),
  })
  .strict()
  .refine(
    (g) => g.reviewStatus !== "APPROVED_FOR_RELEASE" || !!g.legalReviewRef,
    "APPROVED_FOR_RELEASE requires legalReviewRef",
  )
  .refine(
    (g) => !(g.reviewStatus === "PROHIBITED" && g.witnessEligible),
    "PROHIBITED operators cannot be witnesses",
  );
export type ProvenanceGroup = z.infer<typeof provenanceGroupSchema>;
export const provenanceInventorySchema = z
  .object({
    version: z.literal(1),
    observedAt: z.string(),
    disclaimer: z.string().min(20).max(800),
    groups: z.array(provenanceGroupSchema).max(400),
  })
  .strict()
  .superRefine((inv, ctx) => {
    const seenGroup = new Set<string>(),
      seenHost = new Set<string>();
    for (const g of inv.groups) {
      if (seenGroup.has(g.operatorGroup))
        ctx.addIssue({
          code: "custom",
          message: `DUP_GROUP:${g.operatorGroup}`,
        });
      seenGroup.add(g.operatorGroup);
      for (const h of g.hosts) {
        if (seenHost.has(h))
          ctx.addIssue({ code: "custom", message: `DUP_HOST:${h}` });
        seenHost.add(h);
      }
    }
  });
export type ProvenanceInventory = z.infer<typeof provenanceInventorySchema>;
export const provenanceInventory: ProvenanceInventory =
  provenanceInventorySchema.parse(inventoryFile);
export interface EndpointProvenance {
  // Independence key (backing operator); null = operator not established.
  operatorGroup: string | null;
  inventoryGroup?: string | null;
  reviewStatus: ReviewStatus;
  witnessEligible: boolean;
  releaseAllowed: boolean;
}
const UNKNOWN: EndpointProvenance = Object.freeze({
  operatorGroup: null,
  reviewStatus: "UNKNOWN",
  witnessEligible: false,
  releaseAllowed: false,
});
// Exact host first, then the longest "*.suffix" match. Anything else is UNKNOWN.
export function provenanceForUrl(
  url: string,
  inventory: ProvenanceInventory = provenanceInventory,
): EndpointProvenance {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return UNKNOWN;
  }
  let best: { g: ProvenanceGroup; len: number } | null = null;
  for (const g of inventory.groups)
    for (const h of g.hosts) {
      if (h === hostname) {
        if (!best || best.len < 10000) best = { g, len: 10000 };
      } else if (
        h.startsWith("*.") &&
        hostname.endsWith(h.slice(1)) &&
        (!best || best.len < h.length)
      )
        best = { g, len: h.length };
    }
  if (!best) return UNKNOWN;
  const g = best.g;
  return {
    // An inventory row whose operator itself is unverified never establishes independence.
    operatorGroup:
      g.provenance === "unknown"
        ? null
        : (g.backingOperatorGroup ?? g.operatorGroup),
    inventoryGroup: g.operatorGroup,
    reviewStatus: g.reviewStatus,
    witnessEligible:
      g.witnessEligible &&
      g.provenance !== "unknown" &&
      g.reviewStatus !== "PROHIBITED",
    releaseAllowed:
      g.reviewStatus === "APPROVED_FOR_RELEASE" && !!g.legalReviewRef,
  };
}
export type RegistryProfile = "development" | "staging" | "release";
// Reserved (RFC 6761 / 2606) names and loopback/private addresses only: a staging marker may relax the
// RPC policy of a public-mode deployment only when every host it serves is not internet-facing.
function nonPublicHost(raw: string) {
  let h = raw.trim().toLowerCase();
  if (h.startsWith("[")) h = h.slice(1, h.indexOf("]"));
  else if (h.split(":").length === 2) h = h.split(":")[0]!;
  if (h === "::1" || /(^|\.)(localhost|test|internal)$/.test(h)) return true;
  return /^(127\.\d{1,3}|10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/.test(
    h,
  );
}
function stagingHostsNonPublic(env: Record<string, string | undefined>) {
  const list = (v: string | undefined) =>
    (v ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const origins = list(env.OTHERBRIDGE_APP_ORIGINS);
  if (!origins.length) return false;
  const hosts = list(env.OTHERBRIDGE_DATA_API_HOSTS);
  for (const o of origins)
    try {
      hosts.push(new URL(o).host);
    } catch {
      return false;
    }
  return hosts.every(nonPublicHost);
}
// Strict parsing: an unrecognised value is a configuration error, never a silent default.
export function registryProfile(
  env: Record<string, string | undefined> = process.env,
): { profile: RegistryProfile; errors: string[] } {
  const errors: string[] = [];
  const deployment = env.OTHERBRIDGE_DEPLOYMENT_ENV;
  if (
    deployment !== undefined &&
    !["local", "staging", "production"].includes(deployment)
  ) {
    // An unrecognised marker is treated as production (strictest), and reported as an error.
    errors.push("OTHERBRIDGE_DEPLOYMENT_ENV");
    return { profile: "release", errors };
  }
  const publicProduction =
    env.NODE_ENV === "production" &&
    env.OTHERBRIDGE_PUBLIC_DEPLOYMENT === "true";
  // A public production deployment (or an explicit production marker) may only use release-approved
  // RPC endpoints. Unknown/legal-review endpoints are limited to local research and staging.
  if (
    deployment === "production" ||
    (publicProduction && deployment !== "staging")
  )
    return { profile: "release", errors };
  // A public-mode "staging" marker on internet-facing origins is a configuration error and gets the
  // strictest profile: one environment variable must never loosen a production RPC policy.
  if (publicProduction && !stagingHostsNonPublic(env)) {
    errors.push("OTHERBRIDGE_DEPLOYMENT_ENV_STAGING_PUBLIC_HOST");
    return { profile: "release", errors };
  }
  if (deployment === "staging") return { profile: "staging", errors };
  return { profile: "development", errors };
}
export function profileAllows(
  profile: RegistryProfile,
  p: Pick<EndpointProvenance, "reviewStatus" | "releaseAllowed">,
) {
  if (p.reviewStatus === "PROHIBITED") return false;
  if (profile === "release") return p.releaseAllowed;
  return true;
}
// Two endpoints are operationally independent only when both operators are known and differ, and
// their normalized URLs differ (aliases of one endpoint never witness each other).
export function independent(
  a: { url: string; operatorGroup?: string | null },
  b: { url: string; operatorGroup?: string | null },
) {
  const norm = (u: string) => u.toLowerCase().replace(/\/+$/, "");
  return (
    !!a.operatorGroup &&
    !!b.operatorGroup &&
    a.operatorGroup !== b.operatorGroup &&
    norm(a.url) !== norm(b.url)
  );
}
