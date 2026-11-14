// G7 controlled pilot gate (owner-approved, local only). Decided on the server for every request; no query
// parameter, cookie or browser state can turn it on. All of the following must hold:
//   - the build-time bundle constant is "1": only the separate local-g7-pilot artifact (`.next-g7-pilot`, built by
//     `pnpm g7:product-pilot:build`) has it; every public build folds it to "0" (next.config.ts), so the gate can
//     never open in a public artifact whatever its runtime environment says,
//   - the production runtime of that artifact (never the development server),
//   - OTHERBRIDGE_G7_LOCAL_PILOT=1 and the loopback origin set by the `pnpm g7:product-pilot` launcher,
//   - the request Host is exactly that 127.0.0.1 origin.
// The gate only lets the page render the pilot panel; the send capability itself lives in the launcher's
// one-shot session behind a per-run token, and GLOBAL_EXECUTION_ENABLED stays false for the product.
export interface G7LocalPilotGate {
  apiBase: "/g7-pilot/api";
  origin: string;
}
export function g7LocalPilotGate(
  host: string | null,
  env: Record<string, string | undefined> = process.env,
  bundle: string | undefined = process.env.OTHERBRIDGE_G7_LOCAL_PILOT_BUNDLE,
): G7LocalPilotGate | null {
  if (bundle !== "1") return null;
  if (env.NODE_ENV !== "production") return null;
  if (env.OTHERBRIDGE_G7_LOCAL_PILOT !== "1") return null;
  const origin = env.OTHERBRIDGE_G7_LOCAL_PILOT_ORIGIN ?? "";
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(origin);
  if (!match || host !== `127.0.0.1:${match[1]}`) return null;
  return { apiBase: "/g7-pilot/api", origin };
}
