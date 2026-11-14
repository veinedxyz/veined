import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import {
  sourceInventory as priorInventory,
  ordered,
  checkpoint,
  sha256,
} from "./v116-source.mjs";
export { checkpoint, sha256 };
export function sourceInventory(root = process.cwd()) {
  const hashes = priorInventory(root);
  // V1.17 consumes the immutable V1.16 identity as an input, never rewrites it.
  hashes["release/candidate.json"] = sha256(
    readFileSync(resolve(root, "release/candidate.json")),
  );
  function walk(path) {
    const absolute = resolve(root, path),
      info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw Error("SOURCE_SYMLINK");
    if (info.isDirectory())
      for (const row of readdirSync(absolute)) walk(path + "/" + row);
    else if (path.endsWith(".md"))
      hashes[path] = sha256(readFileSync(absolute));
  }
  walk("pentest");
  return ordered(hashes);
}
