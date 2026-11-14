// Local owner preview. Full current/frozen source and production artifact hashes must match.
import { fork, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  verifyPreview,
  choosePreviewPort,
  previewEnvironment,
  previewPort,
} from "./lib/v1202-preview.mjs";
import { processIdentity, stopExactProcess } from "./lib/process-identity.mjs";

const mode = process.argv[2] ?? "start";
const root =
  mode === "worker"
    ? resolve(process.argv[3])
    : fileURLToPath(new URL("..", import.meta.url));
const verified = verifyPreview(root);

function ownsListener(port, owner) {
  previewPort(port);
  if (!owner || processIdentity(owner.pid)?.created !== owner.created)
    return false;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$rows=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue); @($rows | Select-Object LocalAddress,OwningProcess) | ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0 || !result.stdout.trim()) return false;
  const data = JSON.parse(result.stdout),
    rows = Array.isArray(data) ? data : [data];
  return (
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.LocalAddress === "127.0.0.1" && row.OwningProcess === owner.pid,
    )
  );
}

if (mode === "worker") {
  if (!process.send || !process.connected)
    throw Error("OWNED_IPC_PARENT_REQUIRED");
  const expectedParent = JSON.parse(process.argv[4]);
  if (
    process.ppid !== expectedParent.pid ||
    processIdentity(expectedParent.pid)?.created !== expectedParent.created
  )
    throw Error("PARENT_IDENTITY_MISMATCH");
  const port = previewPort(Number(process.argv[5]));
  if (process.cwd() !== verified.directory)
    throw Error("FROZEN_WORKING_DIRECTORY_REQUIRED");
  process.once("disconnect", () => process.exit(0));
  process.argv = [
    process.execPath,
    join(verified.directory, "scripts/next-pinned.mjs"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ];
  await import(pathToFileURL(process.argv[1]).href);
} else if (mode === "verify") {
  console.log(
    JSON.stringify({
      pass: true,
      sourceCheckpoint: verified.manifest.sourceCheckpoint,
      buildCheckpoint: verified.manifest.buildCheckpoint,
      buildId: verified.manifest.buildId,
      execution: "CLOSED",
    }),
  );
} else if (mode === "start") {
  const state = join(root, ".otherbridge/v1202-preview"),
    activePath = join(state, "active.json");
  if (existsSync(activePath)) {
    const active = JSON.parse(readFileSync(activePath, "utf8"));
    if (
      active.manifestSha256 === verified.manifestSha256 &&
      active.status === "RUNNING" &&
      processIdentity(active.launcher.pid)?.created ===
        active.launcher.created &&
      ownsListener(active.port, active.server)
    ) {
      console.log(
        `VEINED V1.20.2 already verified and running: ${active.origin}/`,
      );
      process.exit(0);
    }
  }
  const port = await choosePreviewPort(),
    origin = `http://127.0.0.1:${port}`;
  const launcher = processIdentity(process.pid);
  if (!launcher) throw Error("LAUNCHER_IDENTITY_REQUIRED");
  const run = join(
    state,
    "runs",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  mkdirSync(run, { recursive: true });
  const child = fork(
    join(verified.directory, "scripts/v1202-preview.mjs"),
    ["worker", root, JSON.stringify(launcher), String(port)],
    {
      cwd: verified.directory,
      env: previewEnvironment(process.env, port),
      execArgv: [],
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  const closed = new Promise((done) => {
    child.once("close", done);
    child.once("error", () => done(1));
  });
  const server = processIdentity(child.pid);
  if (!server) {
    await closed;
    throw Error("SERVER_IDENTITY_REQUIRED");
  }
  const receipt = {
    at: new Date().toISOString(),
    status: "STARTING",
    launcher,
    server,
    port,
    origin,
    directory: verified.directory,
    sourceCheckpoint: verified.manifest.sourceCheckpoint,
    buildCheckpoint: verified.manifest.buildCheckpoint,
    manifestSha256: verified.manifestSha256,
    credentialsCopied: 0,
    environmentFilesCopied: 0,
    execution: "CLOSED",
    run,
  };
  const save = () => {
    writeFileSync(
      join(run, "preview.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    writeFileSync(activePath, JSON.stringify(receipt, null, 2) + "\n");
  };
  save();
  const stop = () => stopExactProcess(child, server);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) break;
      if (ownsListener(port, server)) {
        try {
          if (
            (
              await fetch(origin + "/app", {
                signal: AbortSignal.timeout(2000),
              })
            ).status === 200
          ) {
            ready = true;
            break;
          }
        } catch {}
      }
      await new Promise((done) => setTimeout(done, 500));
    }
    if (!ready || !ownsListener(port, server))
      throw Error("OWNED_PREVIEW_NOT_READY");
    receipt.status = "RUNNING";
    save();
    console.log(
      `VEINED V1.20.2 ready: ${origin}/ — execution CLOSED; Ctrl+C stops only this preview.`,
    );
    console.log(
      `App: ${origin}/app | Brand gallery (historical V1.20): ${origin}/assets/veined/brand/review.html`,
    );
    const code = await closed;
    if (code && !child.killed) process.exitCode = code;
  } finally {
    stop();
    await closed;
    receipt.status = "STOPPED";
    receipt.stoppedAt = new Date().toISOString();
    receipt.cleanup = {
      identityMatchedProcessRemaining:
        processIdentity(server.pid)?.created === server.created,
      unrelatedProcessesTouched: 0,
    };
    save();
  }
} else throw Error("Usage: node scripts/v1202-preview.mjs [start|verify]");
