// Artifact separation check: the PUBLIC production artifact (`.next`) must not contain the in-product G7 pilot
// module (client or server) nor a pilot build manifest; each local-g7-pilot artifact present must contain it.
//   node --experimental-transform-types --import ./scripts/ts-hooks.mjs scripts/g7-pilot-artifacts.ts [out.json]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILD_MANIFEST,
  PILOT_CLIENT_MARKERS,
  PILOT_DIST_DIRS,
  scanClientChunks,
} from "./g7-pilot/build-profile";
import { REPO } from "./g7-pilot/launch";

function scanServer(distDir: string) {
  const hits: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) {
        const text = readFileSync(p, "utf8");
        if (PILOT_CLIENT_MARKERS.some((m) => text.includes(m))) hits.push(p);
      }
    }
  };
  walk(join(REPO, distDir, "server"));
  return hits.length;
}
const describe = (distDir: string) => {
  const root = join(REPO, distDir);
  if (!existsSync(join(root, "BUILD_ID"))) return null;
  const client = scanClientChunks(REPO, distDir);
  return {
    distDir,
    buildId: readFileSync(join(root, "BUILD_ID"), "utf8").trim(),
    clientFiles: client.files,
    clientChunksWithPilotModule: client.chunksWithMarkers,
    serverFilesWithPilotModule: scanServer(distDir),
    pilotManifest: existsSync(join(root, BUILD_MANIFEST)),
  };
};
const publicArtifact = describe(".next");
const pilots = Object.values(PILOT_DIST_DIRS).map(describe);
const failures: string[] = [];
if (!publicArtifact) failures.push("PUBLIC_ARTIFACT_MISSING");
else {
  if (publicArtifact.clientChunksWithPilotModule > 0)
    failures.push("PUBLIC_CLIENT_CONTAINS_PILOT_MODULE");
  if (publicArtifact.serverFilesWithPilotModule > 0)
    failures.push("PUBLIC_SERVER_CONTAINS_PILOT_MODULE");
  if (publicArtifact.pilotManifest) failures.push("PUBLIC_HAS_PILOT_MANIFEST");
}
for (const p of pilots)
  if (p && (p.clientChunksWithPilotModule < 1 || !p.pilotManifest))
    failures.push(`PILOT_ARTIFACT_INCOMPLETE ${p.distDir}`);
const result = {
  at: new Date().toISOString(),
  markers: PILOT_CLIENT_MARKERS,
  public: publicArtifact,
  pilots: pilots.filter(Boolean),
  failures,
  pass: failures.length === 0,
};
if (process.argv[2])
  writeFileSync(process.argv[2], JSON.stringify(result, null, 1) + "\n");
console.log(JSON.stringify(result, null, 1));
process.exit(result.pass ? 0 : 1);
