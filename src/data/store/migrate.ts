import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "postgres";
export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}
export const MIGRATIONS_DIR = join(process.cwd(), "src/data/store/migrations");
// Destructive statements require a separate, explicitly approved operator procedure; never automated.
const destructive =
  /\b(DROP\s+(TABLE|SCHEMA|DATABASE|COLUMN|INDEX|VIEW|TYPE|FUNCTION|ROLE|OWNED)|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+[^;]*\s+DROP|ALTER\s+[^;]*\s+RENAME|REASSIGN\s+OWNED)\b/i;
export function assertNonDestructive(m: Pick<MigrationFile, "name" | "sql">) {
  // Block comments are removed too, so `DROP/**/TABLE` cannot hide from the guard.
  const stripped = m.sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, "");
  if (destructive.test(stripped))
    throw Error(`DESTRUCTIVE_MIGRATION_REJECTED:${m.name}`);
}
export async function loadMigrations(
  dir = MIGRATIONS_DIR,
): Promise<MigrationFile[]> {
  const names = (await readdir(dir))
    .filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n))
    .sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(join(dir, name), "utf8");
    const version = Number(name.slice(0, 4));
    if (version !== files.length + 1)
      throw Error(`MIGRATION_SEQUENCE_GAP:${name}`);
    const file = {
      version,
      name,
      sql,
      checksum: createHash("sha256")
        .update(sql.replace(/\r\n/g, "\n"))
        .digest("hex"),
    };
    assertNonDestructive(file);
    files.push(file);
  }
  return files;
}
export interface MigrationReport {
  applied: string[];
  alreadyApplied: string[];
  schemaVersion: number;
}
// Up-only, checksum-pinned, serialized by an advisory lock, one transaction per migration.
export async function migrate(
  sql: Sql,
  files: MigrationFile[],
): Promise<MigrationReport> {
  const reserved = await sql.reserve();
  try {
    await reserved`SELECT pg_advisory_lock(hashtext('otherbridge-data-migrations'))`;
    await reserved`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;
    const rows = await reserved<
      { version: number; name: string; checksum: string }[]
    >`
      SELECT version, name, checksum FROM schema_migrations ORDER BY version`;
    const known = new Map(files.map((f) => [f.version, f]));
    for (const row of rows) {
      const file = known.get(row.version);
      if (!file) throw Error(`SCHEMA_AHEAD_OF_CODE:${row.version}`);
      if (file.checksum !== row.checksum)
        throw Error(`MIGRATION_CHECKSUM_MISMATCH:${row.name}`);
    }
    const done = new Set(rows.map((r) => r.version));
    const report: MigrationReport = {
      applied: [],
      alreadyApplied: [],
      schemaVersion: 0,
    };
    for (const file of files) {
      if (done.has(file.version)) {
        report.alreadyApplied.push(file.name);
        continue;
      }
      await reserved`BEGIN`;
      try {
        await reserved.unsafe(file.sql);
        await reserved`
          INSERT INTO schema_migrations (version, name, checksum)
          VALUES (${file.version}, ${file.name}, ${file.checksum})`;
        await reserved`COMMIT`;
      } catch (error) {
        await reserved`ROLLBACK`;
        throw error;
      }
      report.applied.push(file.name);
    }
    report.schemaVersion = files.length;
    return report;
  } finally {
    await reserved`SELECT pg_advisory_unlock(hashtext('otherbridge-data-migrations'))`.catch(
      () => {},
    );
    reserved.release();
  }
}
export async function schemaVersion(sql: Sql): Promise<number | null> {
  try {
    const [row] = await sql<
      { v: number | null }[]
    >`SELECT max(version) AS v FROM schema_migrations`;
    return row?.v ?? 0;
  } catch {
    return null;
  }
}
