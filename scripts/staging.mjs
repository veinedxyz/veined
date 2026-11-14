// Otherbridge V1.5 local staging-equivalent stack controller (init | up | down | ps | purge).
// Secrets are generated once into git-ignored files and never printed. Only Otherbridge staging
// resources (project "otherbridge-staging") are touched.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
const envFile = ".env.staging.local";
const secretsDir = "infra/staging/secrets";
const compose = [
  "compose",
  "--env-file",
  envFile,
  "-f",
  "infra/staging/compose.yaml",
];
const ignored = (path) => {
  try {
    execFileSync("git", ["check-ignore", "-q", path]);
    return true;
  } catch {
    return false;
  }
};
const docker = (args, opts = {}) => {
  const r = spawnSync("docker", args, {
    stdio: opts.capture ? "pipe" : "inherit",
    encoding: "utf8",
    timeout: opts.timeout ?? 1800000,
  });
  if (r.status !== 0 && !opts.allowFail)
    throw Error(`docker ${args.slice(0, 6).join(" ")} failed (${r.status})`);
  return r;
};
const cmd = process.argv[2] ?? "ps";
const secret = (n = 24) => randomBytes(n).toString("base64url");
if (cmd === "init") {
  if (!ignored(envFile) || !ignored(`${secretsDir}/metrics_token`))
    throw Error("REFUSING: staging secret paths are not git-ignored");
  const created = !existsSync(envFile);
  if (created) {
    const lines = [
      "# Local staging-equivalent secrets (generated; git-ignored; never commit; never production).",
      `OTHERBRIDGE_PG_OWNER_PASSWORD=${secret()}`,
      `OTHERBRIDGE_PG_API_PASSWORD=${secret()}`,
      `OTHERBRIDGE_PG_INDEXER_PASSWORD=${secret()}`,
      `OTHERBRIDGE_PG_MONITOR_PASSWORD=${secret()}`,
      `OTHERBRIDGE_PG_BACKUP_PASSWORD=${secret()}`,
      `OTHERBRIDGE_DATA_PSEUDONYM_KEY=${secret(36)}`,
      `OTHERBRIDGE_METRICS_TOKEN=${secret(32)}`,
      `OTHERBRIDGE_GRAFANA_ADMIN_PASSWORD=${secret()}`,
    ];
    await writeFile(envFile, lines.join("\n") + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  const token = /OTHERBRIDGE_METRICS_TOKEN=(\S+)/.exec(
    await readFile(envFile, "utf8"),
  )[1];
  mkdirSync(secretsDir, { recursive: true });
  await writeFile(`${secretsDir}/metrics_token`, token, { mode: 0o600 });
  console.log(JSON.stringify({ envFile, created, secretsDir, keys: 8 }));
} else if (cmd === "up") {
  docker([...compose, "build", "app", "migrate"]);
  docker([...compose, "up", "-d", "--wait", "--wait-timeout", "900"]);
} else if (cmd === "down") {
  // Stops and removes only this project's containers/networks; named volumes are kept.
  docker([...compose, "down", "--remove-orphans"]);
} else if (cmd === "purge") {
  if (!process.argv.includes("--yes"))
    throw Error("purge removes staging volumes: pass --yes");
  docker([...compose, "down", "--remove-orphans", "--volumes"]);
} else if (cmd === "ps") {
  docker([...compose, "ps", "-a"]);
} else throw Error(`unknown command ${cmd}`);
