// Otherbridge V1.5 PostgreSQL backup / verify / isolated restore drill (local + staging-equivalent).
// pg_dump/pg_restore run inside the database container through `docker exec` as the least-privilege
// backup role over the container's local socket; no password is placed on a command line. Backups are
// written OUTSIDE the repository. Restores only ever target a NEW, uniquely named disposable instance;
// an existing database is never a restore target. Nothing here signs, approves or broadcasts.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { hostname } from "node:os";
import { loadMigrations } from "../src/data/store/migrate";
import {
  countSecrets,
  createSecretScanner,
} from "../src/data/backup/secret-scan";
import {
  decryptBackup as decrypt,
  encryptBackup as encrypt,
} from "../src/data/backup/crypto";
const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const repo = resolve(".");
const env = (process.env.OTHERBRIDGE_BACKUP_ENV ?? "local").trim();
if (!/^(local|staging)$/.test(env))
  throw Error("OTHERBRIDGE_BACKUP_ENV must be local|staging");
const container =
  process.env.OTHERBRIDGE_BACKUP_SOURCE_CONTAINER ??
  (env === "staging"
    ? "otherbridge-staging-postgres"
    : "otherbridge-data-postgres");
const database = "otherbridge_data";
const dumpRole = process.env.OTHERBRIDGE_BACKUP_ROLE ?? "otherbridge_backup";
if (
  !/^[a-z][a-z0-9_-]{2,62}$/.test(container) ||
  !/^[a-z_]{3,40}$/.test(dumpRole)
)
  throw Error("BACKUP_CONFIG_INVALID");
const backupRoot = resolve(
  process.env.OTHERBRIDGE_BACKUP_DIR ??
    join(repo, "..", "otherbridge-backups", env),
);
// Backups contain database contents: never inside the repository (git, review bundles).
if (backupRoot === repo || backupRoot.startsWith(repo + sep))
  throw Error("BACKUP_DIR_INSIDE_REPOSITORY");
const evidence = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
const ID = /^[0-9]{8}T[0-9]{6}Z-[a-z]+-[0-9a-f]{6}$/;
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function report(name: string, data: unknown) {
  if (!evidence) return;
  await mkdir(`${evidence}/backup`, { recursive: true });
  await writeFile(`${evidence}/backup/${name}`, JSON.stringify(data, null, 2));
}
// Runs a binary with an argument array (no shell); optional stdin buffer; returns stdout buffer.
function run(
  cmd: string,
  args: string[],
  input?: Buffer,
  timeoutMs = 600000,
  sink?: (chunk: Buffer) => void,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    // A sink consumes stdout as a stream (large renderings are never buffered whole).
    child.stdout.on("data", (d) => (sink ? sink(d) : out.push(d)));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => (clearTimeout(timer), fail(e)));
    child.on("close", (code) => {
      clearTimeout(timer);
      done({
        code: code ?? 1,
        stdout: Buffer.concat(out),
        stderr: err
          .replace(/postgres(ql)?:\/\/\S+/g, "[database-url]")
          .slice(0, 4000),
      });
    });
    // A reader may legitimately stop early (e.g. a TOC listing); never crash on EPIPE.
    child.stdin.on("error", () => {});
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}
async function psql(
  target: string,
  sqlText: string,
  role = dumpRole,
  vars: Record<string, string> = {},
) {
  const args = [
    "exec",
    "-i",
    target,
    "psql",
    "-X",
    "-q",
    "-t",
    "-A",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    role,
    "-d",
    database,
  ];
  // Variables travel on stdin (\set), never on a command line; values are charset-validated and
  // inserted by psql's own quoting (:'name').
  let prelude = "";
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[a-z_]{1,30}$/.test(k) || !/^[A-Za-z0-9_.:, =-]{0,200}$/.test(v))
      throw Error("PSQL_VAR_INVALID");
    prelude += "\\set " + k + " '" + v + "'\n";
  }
  const r = await run("docker", args, Buffer.from(prelude + sqlText));
  if (r.code !== 0) throw Error(`PSQL_FAILED:${r.stderr.split("\n")[0]}`);
  return r.stdout.toString("utf8").trim();
}
const CRITICAL_TABLES = [
  "schema_migrations",
  "chains",
  "rpc_endpoints",
  "rpc_health",
  "indexer_checkpoints",
  "indexed_block_windows",
  "indexed_window_witnesses",
  "erc20_transfers",
  "wallet_token_discovery",
  "tokens",
  "portfolio_scan_runs",
  "api_clients",
  "api_keys",
  "api_usage_events",
  "api_usage_daily",
  "rate_limit_buckets",
  "ops_backup_events",
];
// Order-insensitive comparison of JSON summaries: aggregate key order differs between a source and
// its restored copy (physical row order changes), which must never be reported as a mismatch.
function canonical(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
          )
        : x;
  return JSON.stringify(sort(v));
}
async function inventory(target: string, role: string) {
  const counts = JSON.parse(
    await psql(
      target,
      `SELECT json_build_object(${CRITICAL_TABLES.map((t) => `'${t}', (SELECT count(*) FROM ${t})`).join(", ")});`,
      role,
    ),
  ) as Record<string, number>;
  const schemaVersion = Number(
    await psql(target, "SELECT max(version) FROM schema_migrations;", role),
  );
  const pgVersion = await psql(target, "SHOW server_version;", role);
  const structure = JSON.parse(
    await psql(
      target,
      `SELECT json_build_object(
        'tables', (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'),
        'indexes', (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'),
        'constraints', (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'),
        'checkpoints', (SELECT json_agg(json_build_object('chain', chain_id, 'from', indexed_from_block::text,
           'through', indexed_through_block::text, 'hash', through_block_hash, 'halted', halted_reason) ORDER BY chain_id) FROM indexer_checkpoints),
        'witnessByConsensus', (SELECT json_object_agg(consensus, n ORDER BY consensus) FROM (SELECT consensus, count(*) n FROM indexed_window_witnesses GROUP BY 1) w),
        'keysByStatus', (SELECT json_object_agg(status, n ORDER BY status) FROM (SELECT status, count(*) n FROM api_keys GROUP BY 1) k),
        'migrations', (SELECT json_agg(json_build_object('version', version, 'name', name, 'checksum', checksum) ORDER BY version) FROM schema_migrations)
      );`,
      role,
    ),
  );
  return { counts, schemaVersion, pgVersion, structure };
}
async function recordEvent(
  target: string,
  kind: "BACKUP" | "VERIFY" | "RESTORE_DRILL",
  ok: boolean,
  e: {
    id?: string;
    sha?: string;
    size?: number;
    ms?: number;
    detail?: string;
  } = {},
) {
  // psql variables are validated above and quoted by psql (:'var'), never concatenated.
  await psql(
    target,
    `INSERT INTO ops_backup_events (kind, ok, at, backup_id, sha256, size_bytes, duration_ms, detail)
     VALUES (:'kind', :'ok'::boolean, now(), NULLIF(:'id', ''), NULLIF(:'sha', ''), NULLIF(:'size', '')::bigint,
       NULLIF(:'ms', '')::int, NULLIF(:'detail', ''));`,
    dumpRole,
    {
      kind,
      ok: String(ok),
      id: e.id ?? "",
      sha: e.sha ?? "",
      size: e.size === undefined ? "" : String(e.size),
      ms: e.ms === undefined ? "" : String(Math.round(e.ms)),
      detail: (e.detail ?? "")
        .replace(/[^A-Za-z0-9_:. ,=-]/g, "_")
        .slice(0, 200),
    },
  ).catch(() => {
    /* event recording is best effort; the manifest/evidence remain authoritative */
  });
}
// Optional AES-256-GCM envelope for production-like custody; the key is operator-supplied (32 bytes,
// base64 in a file outside the repository) and never stored with the backup. Local test data: none.
function keyFrom(path: string | undefined) {
  if (!path) return null;
  const abs = resolve(path);
  if (abs.startsWith(repo + sep))
    throw Error("ENCRYPTION_KEY_INSIDE_REPOSITORY");
  const key = Buffer.from(readFileSync(abs, "utf8").trim(), "base64");
  if (key.length !== 32) throw Error("ENCRYPTION_KEY_INVALID");
  return key;
}
interface Manifest {
  version: 1;
  id: string;
  createdAt: string;
  environment: string;
  source: { container: string; database: string; host: string };
  postgresVersion: string;
  pgDumpVersion: string;
  schemaVersion: number;
  codeMigrations: { version: number; name: string; checksum: string }[];
  format: string;
  file: string;
  sizeBytes: number;
  sha256: string;
  dumpSha256: string;
  encryption: {
    status: "NONE" | "AES-256-GCM";
    keyId: string | null;
    note: string;
  };
  rowCounts: Record<string, number>;
  structure: unknown;
  durationMs: number;
}
async function readManifest(id: string): Promise<Manifest> {
  if (!ID.test(id)) throw Error("BACKUP_ID_INVALID");
  const m = JSON.parse(
    await readFile(join(backupRoot, id, "manifest.json"), "utf8"),
  ) as Manifest;
  if (m.version !== 1 || m.id !== id || !/^[0-9a-f]{64}$/.test(m.sha256))
    throw Error("MANIFEST_INVALID");
  return m;
}
async function renderedSecretScan(target: string, dump: Buffer) {
  const scanner = createSecretScanner();
  const r = await run(
    "docker",
    ["exec", "-i", target, "pg_restore", "-f", "-"],
    dump,
    600000,
    (chunk) => scanner.push(chunk),
  );
  return { code: r.code, stderr: r.stderr, secrets: scanner.hits };
}
// Integrity gate used before any restore: hash, encryption envelope, archive TOC, code compatibility,
// and a plaintext-secret scan of the dump bytes. Throws with a precise reason.
async function verifyBackup(
  id: string,
  key: Buffer | null = keyFrom(
    process.env.OTHERBRIDGE_BACKUP_ENCRYPTION_KEY_FILE,
  ),
) {
  const m = await readManifest(id);
  const blob = await readFile(join(backupRoot, id, m.file));
  if (blob.length !== m.sizeBytes) throw Error("BACKUP_SIZE_MISMATCH");
  if (sha256(blob) !== m.sha256) throw Error("BACKUP_HASH_MISMATCH");
  const dump =
    m.encryption.status === "AES-256-GCM"
      ? key
        ? decrypt(blob, key)
        : null
      : blob;
  if (!dump) throw Error("BACKUP_KEY_REQUIRED");
  if (sha256(dump) !== m.dumpSha256) throw Error("BACKUP_DUMP_HASH_MISMATCH");
  const code = await loadMigrations();
  if (m.schemaVersion !== code.length)
    throw Error(
      `BACKUP_SCHEMA_VERSION_MISMATCH:${m.schemaVersion}!=${code.length}`,
    );
  for (const f of code) {
    const rec = m.codeMigrations.find((x) => x.version === f.version);
    if (!rec || rec.checksum !== f.checksum)
      throw Error(`BACKUP_MIGRATION_CHECKSUM_MISMATCH:${f.name}`);
  }
  // Full sequential read of every data block (decompression included) catches truncation/corruption
  // even when the table of contents at the head of the archive is intact; the decompressed rendering
  // is streamed through the plaintext-secret scanner (table data is compressed in the archive).
  const full = await renderedSecretScan(container, dump);
  if (full.code !== 0)
    throw Error(`BACKUP_ARCHIVE_CORRUPT:${full.stderr.split("\n")[0]}`);
  const toc = await run(
    "docker",
    ["exec", "-i", container, "pg_restore", "--list"],
    dump,
  );
  if (toc.code !== 0)
    throw Error(`BACKUP_ARCHIVE_UNREADABLE:${toc.stderr.split("\n")[0]}`);
  const listing = toc.stdout.toString("utf8");
  for (const t of CRITICAL_TABLES)
    if (!new RegExp(`TABLE DATA public ${t} `).test(listing))
      throw Error(`BACKUP_TABLE_MISSING:${t}`);
  // No plaintext API key, connection string or private key may exist in a backup (keys are stored as
  // verifiers): both the archive bytes (TOC/schema) and the decompressed data rendering are scanned.
  const secrets = countSecrets(dump) + full.secrets;
  if (secrets) throw Error(`BACKUP_PLAINTEXT_SECRET_FOUND:${secrets}`);
  return {
    manifest: m,
    dump,
    tocEntries: listing.split("\n").filter((l) => /^\d+;/.test(l)).length,
  };
}
const commands: Record<string, () => Promise<number>> = {
  async "backup:create"() {
    const started = Date.now();
    await mkdir(backupRoot, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const id = `${stamp}-${env}-${randomBytes(3).toString("hex")}`;
    const dir = join(backupRoot, id);
    await mkdir(dir);
    try {
      const before = await inventory(container, dumpRole);
      const dumpRun = await run("docker", [
        "exec",
        container,
        "pg_dump",
        "-U",
        dumpRole,
        "-d",
        database,
        "-Fc",
        "-Z",
        "6",
        "--no-owner",
      ]);
      if (dumpRun.code !== 0)
        throw Error(`PG_DUMP_FAILED:${dumpRun.stderr.split("\n")[0]}`);
      const pgDumpVersion = (
        await run("docker", ["exec", container, "pg_dump", "--version"])
      ).stdout
        .toString()
        .trim();
      const dump = dumpRun.stdout;
      const key = keyFrom(process.env.OTHERBRIDGE_BACKUP_ENCRYPTION_KEY_FILE);
      const blob = key ? encrypt(dump, key) : dump;
      const file = key ? "otherbridge.dump.enc" : "otherbridge.dump";
      await writeFile(join(dir, file), blob, { mode: 0o600 });
      const code = await loadMigrations();
      const manifest: Manifest = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        environment: env,
        source: {
          container,
          database,
          host: hostname()
            .replace(/[^A-Za-z0-9-]/g, "")
            .slice(0, 48),
        },
        postgresVersion: before.pgVersion,
        pgDumpVersion,
        schemaVersion: before.schemaVersion,
        codeMigrations: code.map((f) => ({
          version: f.version,
          name: f.name,
          checksum: f.checksum,
        })),
        format: "pg_dump custom archive (-Fc, zlib level 6, --no-owner)",
        file,
        sizeBytes: blob.length,
        sha256: sha256(blob),
        dumpSha256: sha256(dump),
        encryption: key
          ? {
              status: "AES-256-GCM",
              keyId: sha256(key).slice(0, 16),
              note: "Operator-supplied key; not stored with the backup.",
            }
          : {
              status: "NONE",
              keyId: null,
              note: "Local/staging synthetic or public-chain data only. Production backups require encryption with KMS/secret-manager key custody (release gate).",
            },
        rowCounts: before.counts,
        structure: before.structure,
        durationMs: Date.now() - started,
      };
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        { mode: 0o600 },
      );
      await writeFile(
        join(dir, `${file}.sha256`),
        `${manifest.sha256}  ${file}\n`,
      );
      await recordEvent(container, "BACKUP", true, {
        id,
        sha: manifest.sha256,
        size: blob.length,
        ms: manifest.durationMs,
      });
      const summary = {
        id,
        dir,
        file,
        sizeBytes: blob.length,
        sha256: manifest.sha256,
        schemaVersion: manifest.schemaVersion,
        encryption: manifest.encryption.status,
        durationMs: manifest.durationMs,
      };
      await report(`backup-${id}.json`, {
        manifest: { ...manifest, source: { ...manifest.source } },
      });
      console.log(JSON.stringify(summary));
      return 0;
    } catch (error) {
      await recordEvent(container, "BACKUP", false, {
        id,
        ms: Date.now() - started,
        detail: String((error as Error).message).slice(0, 120),
      });
      throw error;
    }
  },
  async "backup:verify"() {
    const id = flag("id");
    if (!id) throw Error("--id required");
    const started = Date.now();
    try {
      const v = await verifyBackup(id);
      const out = {
        id,
        result: "PASS",
        sha256: v.manifest.sha256,
        tocEntries: v.tocEntries,
        schemaVersion: v.manifest.schemaVersion,
        encryption: v.manifest.encryption.status,
        durationMs: Date.now() - started,
      };
      await recordEvent(container, "VERIFY", true, {
        id,
        sha: v.manifest.sha256,
        ms: out.durationMs,
      });
      await report(`verify-${id}.json`, out);
      console.log(JSON.stringify(out));
      return 0;
    } catch (error) {
      const out = { id, result: "FAIL", reason: (error as Error).message };
      await recordEvent(container, "VERIFY", false, {
        id,
        detail: out.reason.slice(0, 120),
      });
      await report(`verify-${id}-fail.json`, out);
      console.log(JSON.stringify(out));
      return 1;
    }
  },
  async "backup:list"() {
    const rows = [];
    if (existsSync(backupRoot))
      for (const name of (await readdir(backupRoot)).sort())
        if (ID.test(name))
          try {
            const m = await readManifest(name);
            rows.push({
              id: m.id,
              createdAt: m.createdAt,
              sizeBytes: m.sizeBytes,
              sha256: m.sha256,
              schemaVersion: m.schemaVersion,
              encryption: m.encryption.status,
            });
          } catch {
            rows.push({ id: name, error: "MANIFEST_UNREADABLE" });
          }
    console.log(JSON.stringify({ backupRoot, backups: rows }, null, 2));
    return 0;
  },
  // Retention: dry-run by default. Deletion needs --apply --yes and only touches tool-created dirs.
  async "backup:prune"() {
    const keep = Number(flag("keep") ?? 14);
    if (!Number.isInteger(keep) || keep < 3) throw Error("--keep must be >= 3");
    const ids = existsSync(backupRoot)
      ? (await readdir(backupRoot)).filter((n) => ID.test(n)).sort()
      : [];
    const candidates = ids.slice(0, Math.max(0, ids.length - keep));
    const apply = has("apply") && has("yes");
    if (apply)
      for (const id of candidates) {
        await readManifest(id); // refuse anything that is not a tool-created backup
        await rm(join(backupRoot, id), { recursive: true });
      }
    const out = {
      backupRoot,
      keep,
      total: ids.length,
      wouldDelete: apply ? [] : candidates,
      deleted: apply ? candidates : [],
      mode: apply ? "APPLIED" : "DRY_RUN",
    };
    await report(`prune-${apply ? "applied" : "dry-run"}.json`, out);
    console.log(JSON.stringify(out));
    return 0;
  },
  async "backup:restore-test"() {
    const id = flag("id");
    if (!id) throw Error("--id required");
    return restoreDrill(id);
  },
  async "backup:corruption-test"() {
    const id = flag("id");
    if (!id) throw Error("--id required");
    return corruptionTest(id);
  },
  async help() {
    console.log(Object.keys(commands).join("\n"));
    return 0;
  },
};
async function imageOf(name: string) {
  const r = await run("docker", ["inspect", "--format", "{{.Image}}", name]);
  if (r.code !== 0) throw Error("SOURCE_CONTAINER_MISSING");
  return r.stdout.toString().trim();
}
async function waitReady(name: string) {
  for (let i = 0; i < 120; i++) {
    const r = await run("docker", [
      "exec",
      name,
      "pg_isready",
      "-U",
      "otherbridge_owner",
      "-d",
      database,
    ]);
    if (r.code === 0) {
      const q = await run("docker", [
        "exec",
        "-i",
        name,
        "psql",
        "-X",
        "-U",
        "otherbridge_owner",
        "-d",
        database,
        "-tAc",
        "SELECT 1",
      ]);
      if (q.code === 0) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("RESTORE_TARGET_NOT_READY");
}
async function corruptionTest(id: string) {
  const results: Record<string, unknown> = {};
  const sourceBefore = await inventory(container, dumpRole);
  const m = await readManifest(id);
  const original = await readFile(join(backupRoot, id, m.file));
  const cases: {
    name: string;
    mutate: (b: Buffer, m: Manifest) => { blob: Buffer; manifest: Manifest };
  }[] = [
    {
      name: "byte-flip",
      mutate: (b, mm) => {
        const c = Buffer.from(b);
        c[Math.floor(c.length / 2)] ^= 0xff;
        return { blob: c, manifest: mm };
      },
    },
    {
      name: "truncated",
      mutate: (b, mm) => ({
        blob: b.subarray(0, Math.floor(b.length / 3)),
        manifest: mm,
      }),
    },
    {
      name: "truncated-with-forged-manifest-hash",
      mutate: (b, mm) => {
        const c = b.subarray(0, Math.floor(b.length / 3));
        return {
          blob: c,
          manifest: {
            ...mm,
            sizeBytes: c.length,
            sha256: sha256(c),
            dumpSha256: sha256(c),
          },
        };
      },
    },
    {
      name: "wrong-schema-version",
      mutate: (b, mm) => ({
        blob: b,
        manifest: { ...mm, schemaVersion: mm.schemaVersion + 1 },
      }),
    },
    {
      name: "migration-checksum-mismatch",
      mutate: (b, mm) => ({
        blob: b,
        manifest: {
          ...mm,
          codeMigrations: mm.codeMigrations.map((x, i) =>
            i === 0 ? { ...x, checksum: "0".repeat(64) } : x,
          ),
        },
      }),
    },
  ];
  const savedRoot = backupRoot;
  for (const c of cases) {
    const fakeId = `${id.slice(0, 16)}-${env}-${randomBytes(3).toString("hex")}`;
    const dir = join(savedRoot, fakeId);
    await mkdir(dir, { recursive: true });
    const { blob, manifest } = c.mutate(original, m);
    await writeFile(join(dir, m.file), blob);
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ ...manifest, id: fakeId }, null, 2),
    );
    let refused: string | null = null;
    try {
      await verifyBackup(fakeId);
    } catch (error) {
      refused = (error as Error).message;
    }
    // A refused backup never reaches a restore target: restoreDrill verifies first and exits.
    const drill = refused
      ? null
      : await restoreDrill(fakeId, true).catch((e) => (e as Error).message);
    results[c.name] = {
      refusedBeforeRestore: !!refused,
      reason: refused,
      drill,
    };
    await rm(dir, { recursive: true });
  }
  const sourceAfter = await inventory(container, dumpRole);
  const unchanged =
    JSON.stringify({ ...sourceBefore.counts, ops_backup_events: 0 }) ===
    JSON.stringify({ ...sourceAfter.counts, ops_backup_events: 0 });
  const allRefused = Object.values(results).every(
    (r) => (r as { refusedBeforeRestore: boolean }).refusedBeforeRestore,
  );
  const out = {
    id,
    at: new Date().toISOString(),
    cases: results,
    allRefusedBeforeRestore: allRefused,
    sourceUnchanged: unchanged,
    restoreTargetsCreated: 0,
  };
  await report("corruption-test.json", out);
  console.log(JSON.stringify(out));
  return allRefused && unchanged ? 0 : 1;
}
async function restoreDrill(id: string, verifyOnly = false): Promise<number> {
  const t0 = Date.now();
  const verified = await verifyBackup(id); // integrity gate before any target exists
  if (verifyOnly) return 0;
  const m = verified.manifest;
  const suffix = randomBytes(3).toString("hex");
  const target = `otherbridge-restore-drill-${suffix}`;
  const volume = `otherbridge-restore-drill-${suffix}-pgdata`;
  if (target === container || !target.startsWith("otherbridge-restore-"))
    throw Error("RESTORE_TARGET_INVALID");
  const exists = await run("docker", ["inspect", target]);
  if (exists.code === 0) throw Error("RESTORE_TARGET_EXISTS");
  const port = Number(flag("port") ?? 55481);
  const ownerPw = randomBytes(24).toString("base64url");
  const image =
    process.env.OTHERBRIDGE_RESTORE_IMAGE ?? (await imageOf(container));
  const out: Record<string, unknown> = {
    id,
    target,
    volume,
    image,
    source: container,
    startedAt: new Date().toISOString(),
  };
  const cleanup = async () => {
    await run("docker", ["rm", "-f", target]);
    await run("docker", ["volume", "rm", volume]);
  };
  try {
    // Fresh isolated instance: new name, new volume, loopback-only port, generated secret via env file.
    const envFile = join(backupRoot, `.drill-${suffix}.env`);
    await writeFile(envFile, `POSTGRES_PASSWORD=${ownerPw}\n`, { mode: 0o600 });
    const created = await run("docker", [
      "run",
      "-d",
      "--name",
      target,
      "--label",
      "otherbridge.restore-drill=true",
      "-v",
      `${volume}:/var/lib/postgresql/data`,
      "-p",
      `127.0.0.1:${port}:5432`,
      "--env-file",
      envFile,
      "-e",
      "POSTGRES_USER=otherbridge_owner",
      "-e",
      `POSTGRES_DB=${database}`,
      "-e",
      "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
      "--security-opt",
      "no-new-privileges",
      image,
      "postgres",
      "-c",
      "password_encryption=scram-sha-256",
    ]);
    await rm(envFile, { force: true });
    if (created.code !== 0)
      throw Error(
        `RESTORE_TARGET_CREATE_FAILED:${created.stderr.split("\n")[0]}`,
      );
    await waitReady(target);
    const tRestore = Date.now();
    // Roles first (fresh generated passwords), so grants re-apply exactly as on the source.
    const roles: Record<string, string> = {};
    for (const role of [
      "otherbridge_api",
      "otherbridge_indexer",
      "otherbridge_monitor",
      "otherbridge_backup",
    ]) {
      roles[role] = randomBytes(24).toString("base64url");
      await psql(
        target,
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';
        GRANT CONNECT ON DATABASE ${database} TO ${role}; GRANT USAGE ON SCHEMA public TO ${role};`,
        "otherbridge_owner",
        { pw: roles[role] },
      );
    }
    const restore = await run(
      "docker",
      [
        "exec",
        "-i",
        target,
        "pg_restore",
        "-U",
        "otherbridge_owner",
        "-d",
        database,
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--single-transaction",
      ],
      verified.dump,
    );
    if (restore.code !== 0)
      throw Error(`PG_RESTORE_FAILED:${restore.stderr.split("\n")[0]}`);
    await psql(
      target,
      await readFile("src/data/store/grants.sql", "utf8"),
      "otherbridge_owner",
    );
    const restoreMs = Date.now() - tRestore;
    const after = await inventory(target, "otherbridge_owner");
    const checks: Record<string, boolean> = {
      schemaVersion: after.schemaVersion === m.schemaVersion,
      rowCounts: canonical(after.counts) === canonical(m.rowCounts),
      structure: canonical(after.structure) === canonical(m.structure),
    };
    // Secret-scan probe on the isolated copy only: a planted key-shaped value in compressed table data
    // must be invisible to a raw archive scan and caught by the rendered scan used by verify.
    checks.secretScanCoversTableData = await secretScanProbe(target);
    out.restoreMs = restoreMs;
    out.checks = checks;
    out.restored = { counts: after.counts, schemaVersion: after.schemaVersion };
    if (!Object.values(checks).every(Boolean))
      throw Error(`RESTORE_VERIFICATION_FAILED:${JSON.stringify(checks)}`);
    out.urls = { port };
    out.ok = true;
    out.totalMs = Date.now() - t0;
    if (has("keep")) {
      // Hand-off for the caller's service checks (Data API boot, verify-index, resume). Secrets are
      // written to a 0600 file outside the repository and deleted by `backup:drill-cleanup`.
      const handoff = join(backupRoot, `.drill-${suffix}.json`);
      await writeFile(
        handoff,
        JSON.stringify({ target, volume, port, database, roles }),
        { mode: 0o600 },
      );
      out.handoff = handoff;
    } else await cleanup();
    await recordEvent(container, "RESTORE_DRILL", true, {
      id,
      ms: Date.now() - t0,
      detail: `restore_ms=${restoreMs}`,
    });
    await report(`restore-drill-${id}.json`, out);
    console.log(JSON.stringify(out));
    return 0;
  } catch (error) {
    out.ok = false;
    out.error = (error as Error).message;
    await cleanup();
    await recordEvent(container, "RESTORE_DRILL", false, {
      id,
      detail: String(out.error).slice(0, 120),
    });
    await report(`restore-drill-${id}-fail.json`, out);
    console.log(JSON.stringify(out));
    return 1;
  }
}
async function secretScanProbe(target: string) {
  if (!target.startsWith("otherbridge-restore-drill-"))
    throw Error("REFUSING_NON_DRILL_TARGET");
  const planted = [
    "ob",
    "test",
    randomBytes(6).toString("hex"),
    randomBytes(24).toString("base64url"),
  ].join("_");
  await psql(
    target,
    `CREATE TABLE ob_drill_secret_probe (v text);
    INSERT INTO ob_drill_secret_probe SELECT repeat('x', 40) || :'v' FROM generate_series(1, 50);`,
    "otherbridge_owner",
    { v: planted },
  );
  try {
    const dumped = await run("docker", [
      "exec",
      target,
      "pg_dump",
      "-U",
      "otherbridge_owner",
      "-d",
      database,
      "-Fc",
      "-Z",
      "6",
      "-t",
      "ob_drill_secret_probe",
    ]);
    if (dumped.code !== 0) return false;
    const raw = countSecrets(dumped.stdout);
    const rendered = await renderedSecretScan(target, dumped.stdout);
    return raw === 0 && rendered.code === 0 && rendered.secrets > 0;
  } finally {
    await psql(
      target,
      "DROP TABLE ob_drill_secret_probe;",
      "otherbridge_owner",
    );
  }
}
commands["backup:drill-cleanup"] = async () => {
  const handoff = flag("handoff");
  if (!handoff) throw Error("--handoff required");
  const h = JSON.parse(await readFile(handoff, "utf8")) as {
    target: string;
    volume: string;
  };
  if (
    !h.target.startsWith("otherbridge-restore-drill-") ||
    !h.volume.startsWith("otherbridge-restore-drill-")
  )
    throw Error("REFUSING_NON_DRILL_TARGET");
  await run("docker", ["rm", "-f", h.target]);
  await run("docker", ["volume", "rm", h.volume]);
  await rm(handoff, { force: true });
  console.log(JSON.stringify({ removed: h.target, volume: h.volume }));
  return 0;
};
const go = commands[command];
if (!go) {
  console.error(`Unknown command ${command}`);
  process.exit(2);
}
go()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(
      String(error instanceof Error ? error.message : error).replace(
        /postgres(ql)?:\/\/[^\s]+/g,
        "[database-url]",
      ),
    );
    process.exit(1);
  });
