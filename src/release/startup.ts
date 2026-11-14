import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import {
  environmentProfile,
  productionConfigSchema,
  releaseConfigurationErrors,
} from "./config";
import { sha256Schema } from "./receipt";
import { invariantDeviations } from "../security/invariants";
import { dataConfig } from "../data/config";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const evidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    rcId: z.string(),
    sourceManifest: sha256Schema,
    sourceManifestFile: z.string(),
    buildHash: sha256Schema,
    buildManifestFile: z.string(),
    files: z.record(z.string(), sha256Schema),
    checks: z
      .object({
        safety: z.literal(true),
        protected107: z.literal(true),
        rootAudit: z.literal(true),
        providerAudit: z.literal(true),
        reproduction: z.literal(true),
        tests: z.literal(true),
        backupRestore: z.literal(true),
      })
      .strict(),
  })
  .strict();
export function releaseFile(root: string, path: string) {
  if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
    throw Error("RELEASE_PATH_INVALID");
  const base = realpathSync(root),
    target = realpathSync(resolve(root, path));
  const rel = relative(base, target);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw Error("RELEASE_PATH_INVALID");
  return readFileSync(target);
}
export function assertReleaseStartup(
  env: Readonly<Record<string, string | undefined>> = process.env,
  root = process.cwd(),
) {
  const production = environmentProfile(env) === "production";
  let config: unknown;
  if (production) {
    try {
      config = JSON.parse(
        releaseFile(
          root,
          env.OTHERBRIDGE_RELEASE_CONFIG ?? "release/production-config.json",
        ).toString(),
      );
    } catch {
      throw Error("RELEASE_STARTUP_REFUSED:PRODUCTION_CONFIG_UNAVAILABLE");
    }
  }
  const errors = releaseConfigurationErrors(env, config);
  if (production) errors.push(...dataConfig(env).errors);
  if (invariantDeviations().length) errors.push("SECURITY_INVARIANT_MISMATCH");
  if (errors.length) throw Error(`RELEASE_STARTUP_REFUSED:${errors.join(",")}`);
  if (!production) return;
  try {
    const c = productionConfigSchema.parse(config);
    const evidenceBytes = releaseFile(root, c.evidenceManifest);
    if (sha(evidenceBytes) !== c.evidenceManifestSha256) throw Error();
    const e = evidenceSchema.parse(JSON.parse(evidenceBytes.toString()));
    if (
      e.rcId !== c.identity.rcId ||
      e.sourceManifest !== c.identity.sourceManifest ||
      e.buildHash !== c.identity.buildHash ||
      Object.keys(e.files).length < 107
    )
      throw Error();
    for (const [path, hash] of Object.entries(e.files))
      if (sha(releaseFile(root, path)) !== hash) throw Error();
    const manifestSchema = z.object({
      hashes: z.record(z.string(), sha256Schema),
    });
    const sourceBytes = releaseFile(root, e.sourceManifestFile);
    if (sha(sourceBytes) !== c.identity.sourceManifest) throw Error();
    const source = manifestSchema.parse(JSON.parse(sourceBytes.toString()));
    const build = manifestSchema.parse(
      JSON.parse(releaseFile(root, e.buildManifestFile).toString()),
    );
    const digestMap = (map: Record<string, string>) =>
      sha(
        Buffer.from(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(map).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
            ),
          ),
        ),
      );
    if (
      digestMap(source.hashes) !== c.identity.sourceCheckpoint ||
      digestMap(build.hashes) !== c.identity.buildHash ||
      !build.hashes[".next/BUILD_ID"] ||
      !source.hashes["src/instrumentation.ts"]
    )
      throw Error();
    for (const [path, hash] of Object.entries({
      ...source.hashes,
      ...build.hashes,
    }))
      if (sha(releaseFile(root, path)) !== hash) throw Error();
    const pointer = releaseFile(root, ".otherbridge/g7-protected-baseline.txt")
      .toString()
      .trim();
    const baseline = releaseFile(root, pointer);
    if (sha(baseline) !== c.identity.protectedBaseline) throw Error();
    const members = z
      .record(z.string(), sha256Schema)
      .parse(JSON.parse(baseline.toString()));
    if (Object.keys(members).length !== 107) throw Error();
    for (const [path, hash] of Object.entries(members))
      if (sha(releaseFile(root, path)) !== hash) throw Error();
    if (
      sha(
        releaseFile(root, "src/swap/server/deployment-pins.generated.json"),
      ) !== c.routerPinsSha256 ||
      sha(
        releaseFile(root, "src/swap/server/solana-program-pins.generated.json"),
      ) !== c.solanaPinsSha256
    )
      throw Error();
  } catch {
    throw Error("RELEASE_STARTUP_REFUSED:EVIDENCE_OR_PIN_MISMATCH");
  }
}
