// Versioned, quiescent artifact verification. The caller must supply an independently
// recorded manifest digest. This is an integrity check, never release authorization.
import {
  readdirSync,
  lstatSync,
  statSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { resolve, join, sep, relative } from "node:path";
import { createHash } from "node:crypto";
import { fileHash } from "./v1202-preview.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, function (_key, v) {
    return v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v;
  });
const ROUTES = [
  "favicon.ico",
  "icon.svg",
  "manifest.webmanifest",
  "robots.txt",
  "sitemap.xml",
];
const validPath = (p) =>
  typeof p === "string" &&
  p.startsWith(".next/") &&
  !p.includes("\\") &&
  !p.includes(":") &&
  !p.split("/").some((x) => ["", ".", ".."].includes(x));
function tree(directory) {
  const root = resolve(directory);
  if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink())
    throw Error("ARTIFACT_ROOT_LINK");
  const files = {},
    directories = [],
    ancestors = new Set(),
    seen = new Set();
  function walk(p) {
    const absolute = join(root, p);
    if (seen.has(p.toLowerCase())) throw Error("CASE_COLLISION");
    seen.add(p.toLowerCase());
    let info = lstatSync(absolute);
    if (info.isSymbolicLink()) {
      const packages = join(root, "node_modules"),
        target = realpathSync(absolute);
      if (
        !/^\.next\/node_modules\/[^/]+$/.test(p) ||
        realpathSync(packages) !== packages ||
        !target.startsWith(packages + sep) ||
        !statSync(absolute).isDirectory()
      )
        throw Error("ARTIFACT_LINK_ESCAPE");
      files[p] = {
        kind: "owned-package-link",
        sha256: hash(relative(root, target).replaceAll("\\", "/")),
      };
      info = statSync(absolute);
    }
    if (info.isDirectory()) {
      const target = realpathSync(absolute);
      if (ancestors.has(target)) throw Error("ARTIFACT_LINK_CYCLE");
      ancestors.add(target);
      directories.push(p);
      for (const name of readdirSync(absolute).sort()) walk(p + "/" + name);
      ancestors.delete(target);
    } else if (info.isFile())
      files[p] = { kind: "file", sha256: fileHash(absolute), bytes: info.size };
    else throw Error("SPECIAL_FILE_FORBIDDEN");
  }
  walk(".next");
  if (!files[".next/BUILD_ID"]) throw Error("BUILD_ID_MISSING");
  return { files, directories };
}
function runtimePolicy(directory) {
  const policy = {};
  for (const route of ROUTES) {
    const seed = `.next/server/app/${route}`;
    const body = join(directory, seed + ".body"),
      metaPath = join(directory, seed + ".meta");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const sourceRoute = `/${route}/route`;
    const key = `/route-cache/APP_ROUTE/${hash(sourceRoute)}/$/${route}`;
    if (
      meta.status !== 200 ||
      canonical(meta.routeCache) !==
        canonical({
          key,
          owner: { kind: "APP_ROUTE", sourceRoute },
          isFallback: false,
        }) ||
      "routeCacheLastModified" in meta
    )
      throw Error("UNSUPPORTED_CACHE_SEED");
    const base = ".next/server" + key;
    policy[base + ".body"] = {
      kind: "body",
      seed: seed + ".body",
      sha256: fileHash(body),
    };
    // Next's seed promotion stores Date.getTime(), which rounds Windows file times.
    policy[base + ".meta"] = {
      kind: "metadata",
      seed: seed + ".meta",
      metadata: meta,
      lastModified: statSync(body).mtime.getTime(),
    };
  }
  return policy;
}
function runtimeDirectories(policy) {
  const result = new Set();
  for (const p of Object.keys(policy)) {
    const parts = p.split("/");
    parts.pop();
    while (parts.length) {
      result.add(parts.join("/"));
      parts.pop();
    }
  }
  return result;
}
function checkRuntime(directory, files, policy) {
  let count = 0;
  for (const [p, rule] of Object.entries(policy)) {
    if (!files[p]) continue; // A cache miss is valid. Its original seed is mandatory.
    if (files[p].kind !== "file") throw Error("CACHE_LINK_FORBIDDEN");
    if (rule.kind === "body") {
      if (files[p].sha256 !== rule.sha256) throw Error("CACHE_BODY_CHANGED");
    } else {
      if (files[p].bytes > 16384) throw Error("CACHE_METADATA_OVERSIZE");
      const meta = JSON.parse(readFileSync(join(directory, p), "utf8"));
      if (meta.routeCacheLastModified !== rule.lastModified)
        throw Error("CACHE_TIMESTAMP_CHANGED");
      delete meta.routeCacheLastModified;
      if (canonical(meta) !== canonical(rule.metadata))
        throw Error("CACHE_METADATA_CHANGED");
    }
    count++;
  }
  return count;
}
export function sealArtifact(directory, sourceCheckpoint) {
  if (!/^[a-f0-9]{64}$/.test(sourceCheckpoint))
    throw Error("SOURCE_CHECKPOINT_REQUIRED");
  const snapshot = tree(directory),
    runtime = runtimePolicy(directory);
  checkRuntime(directory, snapshot.files, runtime);
  for (const p of Object.keys(snapshot.files))
    if (p.includes("/route-cache/") && !runtime[p])
      throw Error("UNKNOWN_RUNTIME_FILE");
  const cacheDirs = runtimeDirectories(runtime);
  for (const p of snapshot.directories)
    if (p.includes("/route-cache") && !cacheDirs.has(p))
      throw Error("UNKNOWN_RUNTIME_DIRECTORY");
  return {
    schemaVersion: 1,
    execution: "CLOSED",
    sourceCheckpoint,
    buildId: readFileSync(join(directory, ".next/BUILD_ID"), "utf8").trim(),
    immutable: Object.fromEntries(
      Object.entries(snapshot.files).filter(([p]) => !runtime[p]),
    ),
    immutableDirectories: snapshot.directories.filter(
      (p) => !p.startsWith(".next/server/route-cache"),
    ),
    runtime,
    policy: "five-exact-static-metadata-seed-copies-v1",
  };
}
export function verifyArtifact(
  directory,
  manifestBytes,
  expectedSha256,
  expectedSourceCheckpoint,
) {
  if (
    !/^[a-f0-9]{64}$/.test(expectedSha256) ||
    hash(manifestBytes) !== expectedSha256
  )
    throw Error("MANIFEST_DIGEST_MISMATCH");
  const m = JSON.parse(manifestBytes);
  if (
    m.schemaVersion !== 1 ||
    m.execution !== "CLOSED" ||
    m.policy !== "five-exact-static-metadata-seed-copies-v1" ||
    m.sourceCheckpoint !== expectedSourceCheckpoint
  )
    throw Error("MANIFEST_CONTRACT_MISMATCH");
  if (
    !Object.keys(m.immutable).every(validPath) ||
    !Object.keys(m.runtime).every(validPath)
  )
    throw Error("MANIFEST_PATH_INVALID");
  const actual = tree(directory);
  for (const [p, entry] of Object.entries(m.immutable))
    if (canonical(actual.files[p]) !== canonical(entry))
      throw Error("IMMUTABLE_FILE_CHANGED_OR_MISSING:" + p);
  const allowedDirs = new Set([
    ...m.immutableDirectories,
    ...runtimeDirectories(m.runtime),
  ]);
  if (
    actual.directories.some((p) => !allowedDirs.has(p)) ||
    m.immutableDirectories.some((p) => !actual.directories.includes(p))
  )
    throw Error("DIRECTORY_INVENTORY_CHANGED");
  for (const p of Object.keys(actual.files))
    if (!m.immutable[p] && !m.runtime[p]) throw Error("UNEXPECTED_FILE:" + p);
  // Re-derive route identity and seed payloads; manifest must not grant arbitrary cache paths.
  const derived = runtimePolicy(directory);
  if (canonical(derived) !== canonical(m.runtime))
    throw Error("CACHE_POLICY_MISMATCH");
  const runtimeFiles = checkRuntime(directory, actual.files, m.runtime);
  if (
    readFileSync(join(directory, ".next/BUILD_ID"), "utf8").trim() !== m.buildId
  )
    throw Error("BUILD_ID_MISMATCH");
  return {
    pass: true,
    immutableFiles: Object.keys(m.immutable).length,
    runtimeFiles,
    sourceCheckpoint: m.sourceCheckpoint,
    execution: "CLOSED",
  };
}
