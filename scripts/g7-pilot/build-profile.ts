// The local-g7-pilot artifact (separate from the public `.next` build): which profile it is, which inputs it was
// built from, and whether it is still fresh. The launcher serves an artifact only when its manifest names the
// expected profile, the bundle constant "1", an existing BUILD_ID and a source digest equal to the current one —
// a stale or foreign build is refused, never served.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { G7_PILOT_PROFILES, type G7PilotProfile } from "../../next.config";

export const PILOT_DIST_DIRS = G7_PILOT_PROFILES;
export type PilotBuildProfile = G7PilotProfile;
export const BUILD_MANIFEST = "otherbridge-build-profile.json";
// Must equal tests/e2e/privy-mock.ts TEST_PRIVY_APP_ID (asserted by the unit tests). Not a real Privy app.
export const TEST_ONLY_PRIVY_APP_ID = "obtestprivyapp00000000001";
export const PROFILE_MANIFEST_SCHEMA =
  "otherbridge.g7.pilot-build-profile.v1" as const;

// Everything `next build` compiles into the artifact: the application, the in-product pilot module, static
// files, build configuration, the lockfile and the .env files Next reads for NEXT_PUBLIC_* values.
const SOURCE_DIRS = ["src", "public", "scripts/g7-pilot/product"];
const SOURCE_FILES = [
  "next.config.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
];
export function sourceDigest(repo: string) {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(join(repo, dir))) return;
    for (const e of readdirSync(join(repo, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  SOURCE_DIRS.forEach(walk);
  for (const f of SOURCE_FILES)
    if (existsSync(join(repo, f)) && statSync(join(repo, f)).isFile())
      files.push(f);
  files.sort();
  const h = createHash("sha256");
  for (const f of files)
    h.update(
      `${f}\0${createHash("sha256")
        .update(readFileSync(join(repo, f)))
        .digest("hex")}\n`,
    );
  return { digest: h.digest("hex"), files: files.length };
}

export interface BuildManifest {
  schema: typeof PROFILE_MANIFEST_SCHEMA;
  profile: PilotBuildProfile;
  distDir: string;
  bundleConstant: "1";
  buildId: string;
  sourceDigest: string;
  sourceFiles: number;
  privyAppId: "env-local" | "test-only";
  privyAppIdSha256: string | null;
  nextVersion: string;
  builtAt: string;
  buildDurationMs: number;
  pilotMarkerChunks: number;
}

export type BuildCheck =
  | { ok: true; manifest: BuildManifest; distDir: string }
  | { ok: false; reason: string; distDir: string };
export function verifyPilotBuild(
  repo: string,
  profile: PilotBuildProfile,
): BuildCheck {
  const distDir = PILOT_DIST_DIRS[profile];
  const root = join(repo, distDir);
  const fail = (reason: string): BuildCheck => ({
    ok: false,
    reason,
    distDir,
  });
  let manifest: BuildManifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(root, BUILD_MANIFEST), "utf8"),
    ) as BuildManifest;
  } catch {
    return fail("BUILD_MISSING");
  }
  if (manifest.schema !== PROFILE_MANIFEST_SCHEMA)
    return fail("BUILD_MANIFEST_SCHEMA");
  if (manifest.profile !== profile || manifest.distDir !== distDir)
    return fail(`BUILD_PROFILE_MISMATCH ${manifest.profile}`);
  if (manifest.bundleConstant !== "1" || manifest.pilotMarkerChunks < 1)
    return fail("BUILD_WITHOUT_PILOT_MODULE");
  let buildId = "";
  try {
    buildId = readFileSync(join(root, "BUILD_ID"), "utf8").trim();
  } catch {
    return fail("BUILD_ID_MISSING");
  }
  if (!buildId || buildId !== manifest.buildId)
    return fail("BUILD_ID_MISMATCH");
  if (manifest.sourceDigest !== sourceDigest(repo).digest)
    return fail("BUILD_STALE_SOURCE_CHANGED");
  return { ok: true, manifest, distDir };
}

// Strings that exist only in the in-product pilot client module (scripts/g7-pilot/product): present in the
// local-g7-pilot client chunks, absent from every public artifact.
export const PILOT_CLIENT_MARKERS = [
  "g7-product-pilot-token",
  "WALLET_NOT_AUTHORIZED_FOR_PILOT",
  "This local pilot session expired",
] as const;
export function scanClientChunks(repo: string, distDir: string) {
  const dir = join(repo, distDir, "static");
  const hits: Record<string, string[]> = {};
  let files = 0;
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.js$/.test(e.name)) {
        files++;
        const text = readFileSync(p, "utf8");
        for (const m of PILOT_CLIENT_MARKERS)
          if (text.includes(m))
            (hits[m] ??= []).push(relative(repo, p).replaceAll("\\", "/"));
      }
    }
  };
  walk(dir);
  return {
    files,
    hits,
    chunksWithMarkers: new Set(Object.values(hits).flat()).size,
  };
}
