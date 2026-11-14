import { existsSync, lstatSync, realpathSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Only a live, identity-pinned reproduction owner may rotate its own generated
// dev output. Nothing is deleted; production .next output and normal workspaces
// are outside this operation. A fresh cache makes each chunk independent of the
// routes compiled by earlier chunks.
export function rotateReproductionCache({
  directory,
  cwd,
  expectedOwner,
  currentOwner,
}) {
  const root = realpathSync(directory);
  if (
    root !== realpathSync(cwd) ||
    basename(dirname(root)) !== "v1201-repro" ||
    basename(dirname(dirname(root))) !== ".otherbridge" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(basename(root))
  )
    throw Error("OWNED_REPRODUCTION_CACHE_ROOT_REQUIRED");
  if (
    !Number.isSafeInteger(expectedOwner?.pid) ||
    expectedOwner.pid < 1 ||
    !expectedOwner.created ||
    currentOwner?.pid !== expectedOwner.pid ||
    currentOwner.created !== expectedOwner.created
  )
    throw Error("LIVE_REPRODUCTION_OWNER_REQUIRED");
  const next = join(root, ".next"),
    source = join(next, "dev"),
    destination = join(next, "dev-preserved-" + randomUUID());
  for (const path of [next, source]) {
    if (
      existsSync(path) &&
      (lstatSync(path).isSymbolicLink() || realpathSync(path) !== resolve(path))
    )
      throw Error("REPRODUCTION_CACHE_LINK_REFUSED");
  }
  if (dirname(source) !== next || dirname(destination) !== next)
    throw Error("REPRODUCTION_CACHE_BOUNDARY_REQUIRED");
  const rotated = existsSync(source);
  if (rotated) renameSync(source, destination);
  return {
    at: new Date().toISOString(),
    root,
    owner: expectedOwner,
    source,
    destination: rotated ? destination : null,
    rotated,
    deletedFiles: 0,
    freshDevCache: !existsSync(source),
  };
}
