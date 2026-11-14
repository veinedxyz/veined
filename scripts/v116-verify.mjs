import { readFileSync } from "node:fs";
import { sourceInventory, checkpoint, sha256 } from "./v116-source.mjs";
const path = process.argv[2];
if (!path) throw Error("SOURCE_MANIFEST_REQUIRED");
const manifest = JSON.parse(readFileSync(path, "utf8")),
  actual = sourceInventory();
const missing = Object.keys(manifest.hashes).filter((p) => !(p in actual));
const changed = Object.keys(manifest.hashes).filter(
  (p) => p in actual && actual[p] !== manifest.hashes[p],
);
const added = Object.keys(actual).filter((p) => !(p in manifest.hashes));
const pass =
  !missing.length &&
  !changed.length &&
  !added.length &&
  checkpoint(actual) === manifest.checkpoint;
console.log(
  JSON.stringify(
    {
      pass,
      files: Object.keys(actual).length,
      checkpoint: checkpoint(actual),
      manifestSha256: sha256(readFileSync(path)),
      missing,
      changed,
      added,
    },
    null,
    2,
  ),
);
if (!pass) process.exitCode = 1;
