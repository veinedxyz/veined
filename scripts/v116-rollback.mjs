import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  lstatSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
const [oldArg, manifestArg, out] = process.argv.slice(2);
if (!out) throw Error("PRIOR_APP_MANIFEST_NEW_OUTPUT_REQUIRED");
const old = resolve(oldArg),
  target = resolve(
    ".otherbridge/v116-rollback",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
if (
  !old.startsWith(resolve(".otherbridge") + "\\") ||
  !target.startsWith(resolve(".otherbridge/v116-rollback") + "\\")
)
  throw Error("WORKSPACE_SCOPE_REQUIRED");
const sha = (b) => createHash("sha256").update(b).digest("hex"),
  hashes = {};
mkdirSync(out, { recursive: true });
mkdirSync(target, { recursive: true });
const source = JSON.parse(readFileSync(manifestArg));
const entries = source.hashes ?? source.files;
if (!entries) throw Error("MANIFEST_REQUIRED");
for (const [p, h] of Object.entries(entries))
  if (
    /^(src|scripts|services|content|public|swap-providers)\//.test(p) ||
    [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "next.config.ts",
      "tsconfig.json",
      ".env.example",
    ].includes(p)
  ) {
    const b = readFileSync(join(old, p));
    if (sha(b) !== (typeof h === "string" ? h : h.sha256))
      throw Error("PRIOR_SOURCE_DRIFT:" + p);
    mkdirSync(dirname(join(target, p)), { recursive: true });
    writeFileSync(join(target, p), b);
    hashes[p] = sha(b);
  }
function copy(p) {
  for (const n of readdirSync(join(old, p))) {
    const file = p + "/" + n,
      info = lstatSync(join(old, file));
    if (info.isSymbolicLink()) {
      const resolved = realpathSync(join(old, file));
      if (!resolved.startsWith(join(old, "node_modules") + "\\"))
        throw Error("BUILD_LINK_OUTSIDE_LOCKED_DEPS");
      mkdirSync(dirname(join(target, file)), { recursive: true });
      symlinkSync(resolved, join(target, file), "junction");
      continue;
    }
    if (info.isDirectory()) {
      if (n === "cache" || n === "dev") continue;
      mkdirSync(join(target, file), { recursive: true });
      copy(file);
    } else {
      mkdirSync(dirname(join(target, file)), { recursive: true });
      copyFileSync(join(old, file), join(target, file));
      hashes[file] = sha(readFileSync(join(target, file)));
    }
  }
}
copy(".next");
symlinkSync(
  join(old, "node_modules"),
  join(target, "node_modules"),
  "junction",
);
symlinkSync(
  join(old, "swap-providers/node_modules"),
  join(target, "swap-providers/node_modules"),
  "junction",
);
const env = {
  ...process.env,
  ...parseEnv(readFileSync(".env.data.local", "utf8")),
  NODE_ENV: "production",
  OTHERBRIDGE_MODE: "mainnet-readonly",
  OTHERBRIDGE_APP_ORIGINS: "http://127.0.0.1:3117",
};
const child = spawn(
  process.execPath,
  [
    "scripts/next-pinned.mjs",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3117",
  ],
  { cwd: target, env },
);
let log = "";
child.stdout.on("data", (b) => (log += b));
child.stderr.on("data", (b) => (log += b));
const checks = [];
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch("http://127.0.0.1:3117/")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) throw Error("PRIOR_APP_FAILED_START");
  for (const path of ["/", "/swap", "/portfolio", "/docs"]) {
    const r = await fetch("http://127.0.0.1:3117" + path);
    checks.push({ path, status: r.status, pass: r.status === 200 });
  }
  const gate = await (await fetch("http://127.0.0.1:3117/api/routing")).json();
  checks.push({
    name: "execution-still-closed",
    pass:
      gate.execution.enabled === false &&
      ["sign", "approve", "broadcast", "deploy"].every(
        (k) => gate.execution[k] === null,
      ),
  });
  const r = await fetch("http://127.0.0.1:3117/api/portfolio", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:3117",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      identity: { evm: "0x000000000000000000000000000000000000dEaD" },
      consent: true,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await r.json();
  checks.push({
    name: "prior-app-current-db-read",
    status: r.status,
    keys: Object.keys(data),
    pass: r.status === 200,
  });
} catch (e) {
  checks.push({ name: "rehearsal-error", error: e.message, pass: false });
} finally {
  child.kill();
}
const pass = checks.length === 6 && checks.every((c) => c.pass);
writeFileSync(
  out + "/rollback.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      old,
      target,
      priorManifest: manifestArg,
      priorManifestSha256: sha(readFileSync(manifestArg)),
      buildId: readFileSync(join(target, ".next/BUILD_ID"), "utf8").trim(),
      hashes,
      checks,
      pass,
      method:
        "Isolated previous accepted app artifact and matching source/config against current local schema; no public traffic switch or DB down migration",
      publicWrites: 0,
      execution: "CLOSED",
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  out + "/server.log",
  log.replace(/postgres(?:ql)?:\/\/\S+/g, "[database-url]"),
);
console.log({ pass, checks });
if (!pass) process.exitCode = 1;
