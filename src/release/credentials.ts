import { MODES } from "../swap/model";

export const CREDENTIAL_PROVIDERS = [
  "Uniswap",
  "Jupiter",
  "Titan",
  "PCSX",
] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];
type Env = Readonly<Record<string, string | undefined>>;
export type CredentialStatus =
  | "OWNER_INPUT_REQUIRED"
  | "CONFIGURED_NOT_CHECKED"
  | "READ_ONLY_PASS"
  | "READ_ONLY_FAILED"
  | "KILLED"
  | "OPT_IN_DISABLED"
  | "ANONYMOUS_QUOTA_SUFFICIENT"
  | "INVALID_CONFIGURATION";
export type Probe = (
  provider: CredentialProvider,
  activeModes: readonly string[],
) => Promise<boolean>;
export async function validateJupiterModes(
  activeModes: readonly string[],
  quote: (mode: "JUPITER_META" | "JUPITER_ROUTER") => Promise<boolean>,
  pause: (ms: number) => Promise<void>,
) {
  let checked = 0;
  for (const mode of ["JUPITER_META", "JUPITER_ROUTER"] as const) {
    if (!activeModes.includes(mode)) continue;
    // Preserve the reviewed organization-wide1/rolling-second budget between fast replies.
    if (checked) await pause(1005);
    if (!(await quote(mode))) return false;
    checked++;
  }
  return checked > 0;
}
export function credentialConfigurationErrors(env: Env): string[] {
  const errors: string[] = [];
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
  if (
    Object.keys(env).some(
      (name) =>
        name.startsWith("NEXT_PUBLIC_") &&
        /(?:API_KEY|AUTH_TOKEN|SECRET|PASSWORD|DATABASE_URL)/.test(name) &&
        env[name],
    )
  )
    errors.push("PUBLIC_SECRET_FORBIDDEN");
  if (
    (env.SWAP_DISABLED_PROVIDERS ?? "")
      .split(",")
      .filter(Boolean)
      .some((mode) => !MODES.includes(mode as (typeof MODES)[number]))
  )
    errors.push("PROVIDER_KILL_CONFIGURATION_INVALID");
  if (
    env.TITAN_WS_ENDPOINT &&
    env.TITAN_WS_ENDPOINT !== "wss://api.titan.exchange/api/v1/ws"
  )
    errors.push("TITAN_ENDPOINT_REVIEW_REQUIRED");
  return errors;
}
/** Only fixed enums/booleans leave this boundary. No exception text, response or env value is returned. */
export async function checkCredentials(env: Env, probe?: Probe) {
  const errors = credentialConfigurationErrors(env);
  const killed = new Set((env.SWAP_DISABLED_PROVIDERS ?? "").split(","));
  const names = {
    Uniswap: "UNISWAP_API_KEY",
    Jupiter: "JUPITER_API_KEY",
    Titan: "TITAN_AUTH_TOKEN",
    PCSX: "PCSX_INTEGRATOR_KEY",
  } as const;
  const modes = {
    Uniswap: ["UNISWAP"],
    Jupiter: ["JUPITER_META", "JUPITER_ROUTER"],
    Titan: ["TITAN"],
    PCSX: ["PANCAKESWAP_X_INTENT"],
  };
  const providers: {
    provider: CredentialProvider;
    configured: boolean;
    status: CredentialStatus;
    requestsAttempted: boolean;
    activeModes: string[];
  }[] = [];
  for (const provider of CREDENTIAL_PROVIDERS) {
    const value = env[names[provider]];
    const configured = !!value?.trim();
    const activeModes = modes[provider].filter((mode) => !killed.has(mode));
    let status: CredentialStatus,
      requestsAttempted = false;
    if (
      errors.length ||
      (configured && (value!.length > 4096 || /[\r\n\0]/.test(value!)))
    )
      status = "INVALID_CONFIGURATION";
    else if (!activeModes.length) status = "KILLED";
    else if (provider === "PCSX" && env.PCSX_QUOTE_ENABLED !== "true")
      status = "OPT_IN_DISABLED";
    else if (provider === "PCSX" && !configured)
      status = "ANONYMOUS_QUOTA_SUFFICIENT";
    else if (!configured || (provider === "Titan" && !env.TITAN_WS_ENDPOINT))
      status = "OWNER_INPUT_REQUIRED";
    else if (!probe) status = "CONFIGURED_NOT_CHECKED";
    else {
      requestsAttempted = true;
      try {
        status = (await probe(provider, activeModes))
          ? "READ_ONLY_PASS"
          : "READ_ONLY_FAILED";
      } catch {
        status = "READ_ONLY_FAILED";
      }
    }
    providers.push({
      provider,
      configured,
      status,
      requestsAttempted,
      activeModes,
    });
  }
  return {
    schemaVersion: 1 as const,
    at: new Date().toISOString(),
    providers,
    privy: "OWNER_DASHBOARD_VERIFICATION_REQUIRED" as const,
    errors,
    pcsxQuota: {
      anonymousRps: 15,
      anonymousBurst: 30,
      appRps: 5,
      processCount: 1,
      sharedEgressVerification: "OWNER_INPUT_REQUIRED",
    },
    execution: "CLOSED" as const,
    walletRequests: 0,
    signatures: 0,
    broadcasts: 0,
  };
}

/** Dedicated fixed GET, outside the application egress surface; no caller URL or redirects. */
export async function checkUniswapChains(
  apiKey: string,
  fetcher: typeof fetch = fetch,
) {
  try {
    const response = await fetcher(
      "https://trade-api.gateway.uniswap.org/v1/supported_chains",
      {
        method: "GET",
        headers: { "x-api-key": apiKey, Accept: "application/json" },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const reader = response.body?.getReader();
    if (!reader) return false;
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 262144) {
          await reader.cancel();
          return false;
        }
        chunks.push(value);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !body ||
        typeof body !== "object" ||
        !("chains" in body) ||
        !Array.isArray(body.chains)
      )
        return false;
      const chains = body.chains;
      return [1, 56, 8453].every((id) =>
        chains.some(
          (row: unknown) =>
            !!row &&
            typeof row === "object" &&
            "chainId" in row &&
            Number(row.chainId) === id,
        ),
      );
    } finally {
      reader.releaseLock();
    }
  } catch {
    return false;
  }
}
