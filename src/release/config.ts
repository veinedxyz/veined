import { z } from "zod";
import { CANARY_RPC_POOL, RPC_ORIGINS } from "../swap/server/config";
import {
  provenanceForUrl,
  registryProfile,
} from "../data/registry/rpc-provenance";
import { sha256Schema, releaseIdentitySchema } from "./receipt";

type Env = Readonly<Record<string, string | undefined>>;
export const SECRET_NAMES = [
  "UNISWAP_API_KEY",
  "JUPITER_API_KEY",
  "PCSX_INTEGRATOR_KEY",
  "TITAN_AUTH_TOKEN",
  "OTHERBRIDGE_DATA_PSEUDONYM_KEY",
  "OTHERBRIDGE_METRICS_TOKEN",
] as const;
export const PROVIDER_ENDPOINTS = Object.freeze({
  uniswap: "https://trade-api.gateway.uniswap.org/v1/quote",
  pcsx: "https://x.pancakeswap.com/order-price/get-price",
  jupiterOrder: "https://api.jup.ag/swap/v2/order",
  jupiterBuild: "https://api.jup.ag/swap/v2/build",
  titan: "wss://api.titan.exchange/api/v1/ws",
});
export const productionConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: releaseIdentitySchema,
    origin: z.literal("https://veined.xyz"),
    apiOrigin: z.literal("https://veined.xyz"),
    processCount: z.literal(1),
    // One process per provider key/egress budget until a shared limiter is reviewed.
    providerEndpoints: z
      .object({
        uniswap: z.literal(PROVIDER_ENDPOINTS.uniswap),
        pcsx: z.literal(PROVIDER_ENDPOINTS.pcsx),
        jupiterOrder: z.literal(PROVIDER_ENDPOINTS.jupiterOrder),
        jupiterBuild: z.literal(PROVIDER_ENDPOINTS.jupiterBuild),
        titan: z.literal(PROVIDER_ENDPOINTS.titan),
      })
      .strict(),
    rpcOrigins: z.array(z.string().url()).min(1).max(300),
    routerPinsSha256: sha256Schema,
    solanaPinsSha256: sha256Schema,
    evidenceManifest: z.string().regex(/^release\/[A-Za-z0-9_./-]+\.json$/),
    evidenceManifestSha256: sha256Schema,
    privyAppId: z.string().min(10).max(100),
    privyDashboardReviewRef: z.string().min(8).max(300),
    secretEnvironment: z.literal("production"),
    execution: z.literal("CLOSED"),
    globalKill: z.literal(true),
    feeBps: z.literal(0),
  })
  .strict();

/** The origins of the canary's read-only RPC pool (src/swap/server/config.ts CANARY_RPC_POOL), as release egress. */
export function canaryReleaseOrigins(): string[] {
  return [
    ...new Set(
      Object.values(CANARY_RPC_POOL).flatMap((pool) =>
        pool.map((s) => new URL(s.url).origin),
      ),
    ),
  ].sort();
}
export function environmentProfile(env: Env) {
  const value = env.OTHERBRIDGE_DEPLOYMENT_ENV;
  if (
    value === "production" ||
    (env.OTHERBRIDGE_PUBLIC_DEPLOYMENT === "true" &&
      registryProfile({ ...env, NODE_ENV: "production" }).profile !== "staging")
  )
    return "production";
  if (value === "staging") return "staging-equivalent";
  if (value === "test" || env.NODE_ENV === "test") return "test";
  if (!value || value === "development" || value === "local")
    return env.NODE_ENV === "production" ? "staging-equivalent" : "development";
  return "invalid";
}
export function releaseConfigurationErrors(env: Env, raw?: unknown): string[] {
  const errors: string[] = [],
    profile = environmentProfile(env);
  if (profile === "invalid") errors.push("ENVIRONMENT_PROFILE_INVALID");
  for (const name of [
    "OTHERBRIDGE_EXECUTION_ENABLED",
    "SWAP_EXECUTION_ENABLED",
    "BRIDGE_EXECUTION_ENABLED",
    "G7_EXECUTION_ENABLED",
  ])
    if (env[name] && env[name] !== "false")
      errors.push("EXECUTION_FLAG_FORBIDDEN");
  if (env.OTHERBRIDGE_GLOBAL_KILL && env.OTHERBRIDGE_GLOBAL_KILL !== "true")
    errors.push("GLOBAL_KILL_REQUIRED");
  for (const name of Object.keys(env))
    if (
      name.startsWith("NEXT_PUBLIC_") &&
      /(?:API_KEY|AUTH_TOKEN|SECRET|PASSWORD|DATABASE_URL)/.test(name) &&
      env[name]
    )
      errors.push("PUBLIC_SECRET_FORBIDDEN");
  if (profile !== "production") return [...new Set(errors)];
  if (env.OTHERBRIDGE_DEPLOYMENT_ENV !== "production")
    errors.push("PRODUCTION_PROFILE_REQUIRED");
  for (const name of SECRET_NAMES) {
    const value = env[name];
    if (
      value &&
      (value.length < 24 ||
        /(?:placeholder|changeme|example|your[_-]|^test|^demo|^staging)/i.test(
          value,
        ))
    )
      errors.push(`INVALID_SECRET_${name}`);
  }
  if (env.OTHERBRIDGE_SECRET_ENVIRONMENT !== "production")
    errors.push("PRODUCTION_SECRET_NAMESPACE_REQUIRED");
  const config = productionConfigSchema.safeParse(raw);
  if (!config.success)
    return [...new Set([...errors, "PRODUCTION_CONFIG_INVALID"])];
  if (env.NEXT_PUBLIC_PRIVY_APP_ID !== config.data.privyAppId)
    errors.push("PRIVY_APP_MISMATCH");
  if (
    env.OTHERBRIDGE_APP_ORIGINS !== config.data.origin ||
    env.OTHERBRIDGE_PUBLIC_ORIGIN !== config.data.origin
  )
    errors.push("EXACT_API_ORIGIN_REQUIRED");
  if (
    env.OTHERBRIDGE_PUBLIC_DEPLOYMENT !== "true" ||
    env.OTHERBRIDGE_REQUIRE_DURABLE_RATE_LIMIT !== "true" ||
    !env.OTHERBRIDGE_DATA_DATABASE_URL
  )
    errors.push("PRODUCTION_DURABLE_DATA_REQUIRED");
  for (const origin of config.data.rpcOrigins) {
    try {
      const url = new URL(origin);
      if (
        url.protocol !== "https:" ||
        url.origin !== origin ||
        !provenanceForUrl(origin).releaseAllowed
      )
        errors.push("UNAPPROVED_RPC");
    } catch {
      errors.push("UNAPPROVED_RPC");
    }
  }
  for (const origin of Object.values(RPC_ORIGINS))
    if (!config.data.rpcOrigins.includes(origin))
      errors.push("SWAP_RPC_NOT_IN_RELEASE_ALLOWLIST");
  // G14 closure (B4): the canary's read-only RPC pool is egress too. Every one of its origins must be in the release
  // allowlist — and so pass the same provenance check as every other RPC above — or the release is refused. Nothing
  // is deployed or allowed by this: it only keeps a later start from ignoring the pool.
  for (const url of canaryReleaseOrigins())
    if (!config.data.rpcOrigins.includes(url))
      errors.push("CANARY_RPC_NOT_IN_RELEASE_ALLOWLIST");
  if (
    env.TITAN_WS_ENDPOINT &&
    env.TITAN_WS_ENDPOINT !== PROVIDER_ENDPOINTS.titan
  )
    errors.push("UNKNOWN_TITAN_ENDPOINT");
  return [...new Set(errors)];
}
