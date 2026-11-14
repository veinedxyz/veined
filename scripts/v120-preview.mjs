// Isolated production-build preview: no .env files, credentials or real wallet configuration copied.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { sourceInventory, checkpoint } from "./v117-source.mjs";
const mode = process.argv[2],
  directory = resolve(
    mode === "baseline"
      ? ".otherbridge/v119-preview"
      : ".otherbridge/v120-preview",
  ),
  port = mode === "baseline" ? "3119" : "3121";
if (!["build", "start", "baseline"].includes(mode))
  throw Error("Usage: node scripts/v120-preview.mjs build|start|baseline");
const env = {};
for (const [k, v] of Object.entries(process.env))
  if (
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|COMSPEC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|PNPM_HOME|COREPACK_HOME|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|HOMEDRIVE|HOMEPATH)$/i.test(
      k,
    )
  )
    env[k] = v;
Object.assign(env, {
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_PUBLIC_PRIVY_APP_ID: "",
  OTHERBRIDGE_PUBLIC_INDEXING: "false",
  OTHERBRIDGE_PUBLIC_DEPLOYMENT: "false",
  OTHERBRIDGE_PUBLIC_ORIGIN: "",
  OTHERBRIDGE_APP_ORIGINS: `http://127.0.0.1:${port}`,
  OTHERBRIDGE_EXECUTION_ENABLED: "false",
});
const pnpm = join(
  dirname(process.execPath),
  "node_modules/corepack/dist/pnpm.js",
);
async function run(args) {
  const code = await new Promise((done) => {
    const p = spawn(process.execPath, args, {
      cwd: directory,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    p.on("error", () => done(1));
    p.on("close", done);
  });
  if (code !== 0) throw Error("PREVIEW_STEP_FAILED:" + code);
}
if (mode === "build") {
  const hashes = sourceInventory();
  for (const path of Object.keys(hashes)) {
    const dest = join(directory, path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(path, dest);
  }
  await run([pnpm, "install", "--frozen-lockfile", "--ignore-scripts"]);
  await run([
    pnpm,
    "--dir",
    "swap-providers",
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--store-dir",
    join(directory, ".pnpm-provider-store"),
  ]);
  await run(["scripts/next-pinned.mjs", "build"]);
  writeFileSync(
    join(directory, "preview-receipt.json"),
    JSON.stringify(
      {
        checkpoint: checkpoint(hashes),
        execution: "CLOSED",
        credentialsCopied: 0,
        environmentFilesCopied: 0,
      },
      null,
      2,
    ) + "\n",
  );
} else {
  if (!existsSync(join(directory, ".next/BUILD_ID")))
    throw Error("BUILD_PREVIEW_FIRST");
  const receipt = JSON.parse(
    readFileSync(join(directory, "preview-receipt.json")),
  );
  const frozen = sourceInventory(directory);
  delete frozen["preview-receipt.json"];
  if (receipt.checkpoint !== checkpoint(frozen))
    throw Error("PREVIEW_SNAPSHOT_CHANGED_REBUILD_REQUIRED");
  if (
    mode === "baseline" &&
    receipt.checkpoint !==
      "f5b41238f2a8ca31e12090e8481f527c2294288309c2013c85ff59623c588e4b"
  )
    throw Error("ACCEPTED_V119_BASELINE_REQUIRED");
  const current = sourceInventory();
  const runtime =
    /^(src\/|public\/|services\/|packages\/|swap-providers\/|infra\/|pnpm|package\.json|next\.config|scripts\/(runtime-dependency-pins|next-pinned))/;
  if (
    mode !== "baseline" &&
    Object.keys({ ...frozen, ...current }).some(
      (path) => runtime.test(path) && frozen[path] !== current[path],
    )
  )
    throw Error("RUNTIME_SOURCE_CHANGED_REBUILD_PREVIEW");
  console.log(
    `Built source checkpoint: ${receipt.checkpoint}; documentation and test-tooling changes do not alter this preview build.`,
  );
  console.log(
    `VEINED ${mode === "baseline" ? "V1.19 baseline" : "V1.20"} local preview: http://127.0.0.1:${port} — execution CLOSED; Ctrl+C to stop.`,
  );
  await run([
    "scripts/next-pinned.mjs",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    port,
  ]);
}
