import type { NextConfig } from "next";
// Next's phase names (equal to next/constants, asserted by the unit tests), inlined so the launcher and the safety
// scan can import this file under plain Node ESM.
export const PHASE_PRODUCTION_BUILD = "phase-production-build";
export const PHASE_PRODUCTION_SERVER = "phase-production-server";
// G7 controlled pilot (owner-approved, local only). Two strictly separated artifacts:
//   production-public  default `next build` / `next start` into `.next`: the bundle constant is always "0", so the
//                      pilot client module is constant-folded out and the server-side gate can never open.
//   local-g7-pilot     OTHERBRIDGE_BUILD_PROFILE=local-g7-pilot (`pnpm g7:product-pilot:build`) builds into its own
//                      `.next-g7-pilot` directory with the constant "1"; only the `pnpm g7:product-pilot` launcher
//                      (OTHERBRIDGE_G7_LOCAL_PILOT=1, 127.0.0.1 only) may serve it. `local-g7-pilot-test` is the same
//                      profile with the test-only Privy App ID for the fixture suites (`.next-g7-pilot-test`).
// Every other combination fails closed here: the pilot flag without a pilot profile, a pilot profile in the
// development server or `next start`, and an unknown profile.
export const G7_PILOT_PROFILES = Object.freeze({
  "local-g7-pilot": ".next-g7-pilot",
  "local-g7-pilot-test": ".next-g7-pilot-test",
} as const);
export type G7PilotProfile = keyof typeof G7_PILOT_PROFILES;
export function g7BuildProfile(
  phase: string,
  profile: string | undefined,
  flag: string | undefined,
): { bundle: "0" | "1"; distDir?: string } {
  if (!profile && !flag) return { bundle: "0" };
  if (!profile)
    throw new Error(
      "OTHERBRIDGE_G7_LOCAL_PILOT needs the local-g7-pilot build profile; refusing to build or start the public product with it",
    );
  if (!Object.hasOwn(G7_PILOT_PROFILES, profile))
    throw new Error(`UNKNOWN_OTHERBRIDGE_BUILD_PROFILE ${profile}`);
  const distDir = G7_PILOT_PROFILES[profile as G7PilotProfile];
  if (phase === PHASE_PRODUCTION_BUILD && !flag)
    return { bundle: "1", distDir };
  if (phase === PHASE_PRODUCTION_SERVER && flag === "1")
    return { bundle: "1", distDir };
  throw new Error(
    "The local-g7-pilot profile is built by `pnpm g7:product-pilot:build` and served only by the `pnpm g7:product-pilot` launcher; refusing",
  );
}
export default function config(phase: string): NextConfig {
  const profile = g7BuildProfile(
    phase,
    process.env.OTHERBRIDGE_BUILD_PROFILE,
    process.env.OTHERBRIDGE_G7_LOCAL_PILOT,
  );
  return {
    poweredByHeader: false,
    devIndicators: false,
    // Reclaim persisted compiler data only in the explicitly isolated E2E dev
    // server. Production builds/servers and normal development keep defaults.
    ...(phase === "phase-development-server" &&
    process.env.NODE_ENV === "development" &&
    process.env.OTHERBRIDGE_MODE === "local-test" &&
    process.env.OTHERBRIDGE_E2E_ISOLATED === "1"
      ? { experimental: { turbopackMemoryEviction: "full" as const } }
      : {}),
    ...(profile.distDir ? { distDir: profile.distDir } : {}),
    // V1.4: the PostgreSQL driver runs in Node only and is never bundled for the browser.
    serverExternalPackages: ["postgres"],
    // The accepted root lock is immutable. Resolve production bundle consumers to
    // separately locked patched packages; raw root audit findings remain disclosed.
    turbopack: {
      resolveAlias: {
        "decode-uri-component": "./src/security/decode-uri-component.cjs",
        "source-map-js":
          "./swap-providers/node_modules/source-map-js/source-map.js",
      },
    },
    env: {
      OTHERBRIDGE_G7_LOCAL_PILOT_BUNDLE: profile.bundle,
    },
    async headers() {
      return [
        {
          source: "/:path*",
          headers: [
            { key: "X-Content-Type-Options", value: "nosniff" },
            // Ignored over loopback http; enforced by browsers once served over HTTPS.
            { key: "Strict-Transport-Security", value: "max-age=31536000" },
            { key: "Referrer-Policy", value: "no-referrer" },
            {
              key: "Permissions-Policy",
              value: "camera=(), microphone=(), geolocation=()",
            },
          ],
        },
      ];
    },
  };
}
