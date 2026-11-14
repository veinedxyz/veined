import { isIP } from "node:net";
import { registryProfile } from "./registry/rpc-provenance";
import { invariantDeviations } from "../security/invariants";
// Server-only data-plane configuration. Malformed values fail closed instead of being guessed.
export interface DataConfig {
  production: boolean;
  databaseUrl: string | null;
  rateLimitBackend: "memory" | "postgres";
  requireDurableRateLimit: boolean;
  pseudonymKeyConfigured: boolean;
  publicApiEnabled: boolean;
  errors: string[];
}
const dbUrl = /^postgres(ql)?:\/\/[^\s]+$/;
// V1.5: booleans accept exactly "true" | "false" | unset. Anything else ("TRUE", "1", "yes",
// "false ") is a configuration error, never silently read as false.
function strictBool(
  env: Record<string, string | undefined>,
  name: string,
  errors: string[],
): boolean {
  const v = env[name];
  if (v === undefined || v === "") return false;
  if (v === "true") return true;
  if (v === "false") return false;
  errors.push(name);
  return false;
}
const WEAK_PASSWORDS =
  /^(postgres|password|passw0rd|admin|root|secret|changeme|otherbridge|example|test|default|123456.*)$/i;
const privateHost = (host: string) => {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(".") && !isIP(h)) return true; // service name on a private network
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fd[0-9a-f]{2}:)/.test(h);
};
export function dataConfig(
  env: Record<string, string | undefined> = process.env,
): DataConfig {
  const errors: string[] = [];
  const production = env.NODE_ENV === "production";
  const databaseUrl = env.OTHERBRIDGE_DATA_DATABASE_URL?.trim() || null;
  if (databaseUrl && !dbUrl.test(databaseUrl))
    errors.push("OTHERBRIDGE_DATA_DATABASE_URL");
  const backend = (
    env.OTHERBRIDGE_RATE_LIMIT_BACKEND ?? (databaseUrl ? "postgres" : "memory")
  ).trim();
  if (backend !== "memory" && backend !== "postgres")
    errors.push("OTHERBRIDGE_RATE_LIMIT_BACKEND");
  if (backend === "postgres" && !databaseUrl)
    errors.push("RATE_LIMIT_BACKEND_REQUIRES_DATABASE");
  const publicDeployment = strictBool(
    env,
    "OTHERBRIDGE_PUBLIC_DEPLOYMENT",
    errors,
  );
  const requireDurable =
    strictBool(env, "OTHERBRIDGE_REQUIRE_DURABLE_RATE_LIMIT", errors) ||
    (production && publicDeployment);
  if (requireDurable && backend !== "postgres")
    errors.push("DURABLE_RATE_LIMIT_REQUIRED");
  const key = env.OTHERBRIDGE_DATA_PSEUDONYM_KEY ?? "";
  if (key && key.length < 32) errors.push("OTHERBRIDGE_DATA_PSEUDONYM_KEY");
  if (production && publicDeployment && key.length < 32)
    errors.push("PSEUDONYM_KEY_REQUIRED");
  // V1.5 public-mode database hygiene: no weak/default password; a non-private database host must
  // be reached over TLS (sslmode=require|verify-ca|verify-full).
  if (production && publicDeployment && databaseUrl && dbUrl.test(databaseUrl))
    try {
      const u = new URL(databaseUrl);
      const pw = decodeURIComponent(u.password);
      if (pw.length < 24 || WEAK_PASSWORDS.test(pw))
        errors.push("DATABASE_PASSWORD_WEAK");
      if (
        !privateHost(u.hostname) &&
        !/^(require|verify-ca|verify-full)$/.test(
          u.searchParams.get("sslmode") ?? "",
        )
      )
        errors.push("DATABASE_TLS_REQUIRED");
    } catch {
      errors.push("OTHERBRIDGE_DATA_DATABASE_URL");
    }
  for (const e of registryProfile(env).errors) errors.push(e);
  // Frozen security invariants: a build whose execution gate, fee policy, write registry or kill
  // switch deviates refuses to serve (no environment variable can change these values).
  for (const d of invariantDeviations())
    errors.push(
      d === "execution_gate_open"
        ? "EXECUTION_GATE_ANOMALY"
        : d === "fee_collection_enabled"
          ? "FEE_COLLECTION_ANOMALY"
          : `SECURITY_INVARIANT_ANOMALY:${d}`,
    );
  return {
    production,
    databaseUrl: errors.includes("OTHERBRIDGE_DATA_DATABASE_URL")
      ? null
      : databaseUrl,
    rateLimitBackend: backend === "postgres" ? "postgres" : "memory",
    requireDurableRateLimit: requireDurable,
    pseudonymKeyConfigured: key.length >= 32,
    // The developer API is not launched: it is served only by the separate loopback service.
    publicApiEnabled: false,
    errors,
  };
}
