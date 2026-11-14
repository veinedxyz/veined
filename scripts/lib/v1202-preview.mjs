import {
  readFileSync,
  readdirSync,
  lstatSync,
  statSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, sep, relative as relativePath } from "node:path";
import { createServer } from "node:net";
import { sourceInventory, checkpoint } from "../v117-source.mjs";

export function previewPort(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1024 ||
    value > 65535 ||
    value === 3100
  )
    throw Error("PREVIEW_PORT_FORBIDDEN");
  return value;
}

export function previewEnvironment(parent, port = 3130, heapMiB = 1536) {
  previewPort(port);
  const env = {};
  for (const [key, value] of Object.entries(parent))
    if (
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|PNPM_HOME|COREPACK_HOME|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|HOMEDRIVE|HOMEPATH)$/i.test(
        key,
      )
    )
      env[key] = value;
  return Object.assign(env, {
    NODE_ENV: "production",
    NODE_OPTIONS: `--max-old-space-size=${heapMiB}`,
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_PRIVY_APP_ID: "",
    OTHERBRIDGE_PUBLIC_INDEXING: "false",
    OTHERBRIDGE_PUBLIC_DEPLOYMENT: "false",
    OTHERBRIDGE_PUBLIC_ORIGIN: "",
    OTHERBRIDGE_APP_ORIGINS: `http://127.0.0.1:${port}`,
    OTHERBRIDGE_MODE: "mainnet-readonly",
    OTHERBRIDGE_EXECUTION_ENABLED: "false",
    OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION: "false",
  });
}

export async function choosePreviewPort(
  candidates = Array.from({ length: 20 }, (_, i) => 3130 + i),
) {
  for (const port of candidates) {
    previewPort(port);
    const available = await new Promise((done, reject) => {
      const probe = createServer();
      probe.once("error", (error) => {
        if (["EADDRINUSE", "EACCES"].includes(error.code)) done(false);
        else reject(error);
      });
      probe.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
        probe.close(() => done(true)),
      );
    });
    if (available) return port;
  }
  throw Error("NO_FREE_PREVIEW_PORT");
}

export function fileHash(path) {
  const fd = openSync(path, "r"),
    hash = createHash("sha256"),
    buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, count));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function buildInventory(directory) {
  const hashes = {};
  const ancestors = new Set();
  function walk(relative) {
    const absolute = join(directory, relative);
    let info = lstatSync(absolute);
    if (info.isSymbolicLink()) {
      // Turbopack emits direct external-package links here. Accept only this
      // build's own installed packages and hash their content and target path.
      const packages = resolve(directory, "node_modules");
      const target = realpathSync(absolute);
      if (
        !/^\.next\/node_modules\/[^/]+$/.test(relative) ||
        realpathSync(packages) !== packages ||
        !target.startsWith(packages + sep) ||
        !statSync(absolute).isDirectory()
      )
        throw Error("BUILD_SYMLINK_FORBIDDEN");
      hashes[relative] = createHash("sha256")
        .update(
          "owned-package-link:" +
            relativePath(directory, target).replaceAll("\\", "/"),
        )
        .digest("hex");
      info = statSync(absolute);
    }
    if (info.isDirectory()) {
      const target = realpathSync(absolute);
      if (ancestors.has(target)) throw Error("BUILD_LINK_CYCLE_FORBIDDEN");
      ancestors.add(target);
      for (const name of readdirSync(absolute)) {
        // These are development output, mutable image/cache data and non-runtime traces.
        if (
          relative === ".next" &&
          ["dev", "cache", "trace", "trace-build", "diagnostics"].includes(name)
        )
          continue;
        walk(relative + "/" + name);
      }
      ancestors.delete(target);
    } else hashes[relative] = fileHash(absolute);
  }
  walk(".next");
  if (!hashes[".next/BUILD_ID"]) throw Error("PRODUCTION_BUILD_REQUIRED");
  return hashes;
}

export function verifySourcePair(manifest, current, frozen) {
  if (
    checkpoint(manifest.sourceHashes) !== manifest.sourceCheckpoint ||
    checkpoint(current) !== manifest.sourceCheckpoint ||
    checkpoint(frozen) !== manifest.sourceCheckpoint
  )
    throw Error("CURRENT_AND_FROZEN_SOURCE_MUST_MATCH");
}

export function verifyBuildPair(manifest, actual) {
  if (
    checkpoint(manifest.buildHashes) !== manifest.buildCheckpoint ||
    checkpoint(actual) !== manifest.buildCheckpoint
  )
    throw Error("BUILD_ARTIFACT_CHANGED_REBUILD_REQUIRED");
}

export function verifyPreview(root) {
  const manifestPath = join(root, ".otherbridge/v1202-preview/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.execution !== "CLOSED" ||
    manifest.credentialsCopied !== 0 ||
    manifest.environmentFilesCopied !== 0 ||
    manifest.buildExitCode !== 0
  )
    throw Error("VERIFIED_CLOSED_PREVIEW_MANIFEST_REQUIRED");
  const directory = resolve(root, manifest.artifactDirectory);
  const allowed = resolve(root, ".otherbridge/v1202-preview/artifacts") + sep;
  if (
    !directory.startsWith(allowed) ||
    realpathSync(directory) !== directory ||
    realpathSync(allowed.slice(0, -1)) !== allowed.slice(0, -1)
  )
    throw Error("OWNED_PREVIEW_DIRECTORY_REQUIRED");
  const privateEnvs = readdirSync(directory).filter(
    (name) => name.startsWith(".env") && name !== ".env.example",
  );
  if (privateEnvs.length) throw Error("PRIVATE_ENVIRONMENT_FILE_PRESENT");
  verifySourcePair(manifest, sourceInventory(root), sourceInventory(directory));
  verifyBuildPair(manifest, buildInventory(directory));
  if (
    readFileSync(join(directory, ".next/BUILD_ID"), "utf8").trim() !==
    manifest.buildId
  )
    throw Error("BUILD_ID_MISMATCH");
  return {
    manifest,
    manifestPath,
    manifestSha256: fileHash(manifestPath),
    directory,
  };
}
