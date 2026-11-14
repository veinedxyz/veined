import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "postgres";
export { POINTS_SCHEMA_VERSION, pointsSchemaVersion } from "./schema-version";
// Points schema migrator: separate from the data-plane migrator on purpose (own schema, own version table, own
// advisory lock), never run implicitly. Up-only and checksum-pinned; destructive statements are refused.
export const POINTS_MIGRATIONS_DIR = join(
  process.cwd(),
  "src/points/migrations",
);
const destructive =
  /\b(DROP\s+(TABLE|SCHEMA|DATABASE|COLUMN|INDEX|VIEW|TYPE|FUNCTION|ROLE|OWNED|TRIGGER)|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+[^;]*\s+DROP|ALTER\s+[^;]*\s+RENAME|REASSIGN\s+OWNED)\b/i;

export async function loadPointsMigrations(dir = POINTS_MIGRATIONS_DIR) {
  const names = (await readdir(dir))
    .filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n))
    .sort();
  const files = [];
  for (const name of names) {
    const sql = await readFile(join(dir, name), "utf8");
    const version = Number(name.slice(0, 4));
    if (version !== files.length + 1)
      throw Error(`MIGRATION_SEQUENCE_GAP:${name}`);
    const stripped = sql
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, "");
    if (destructive.test(stripped))
      throw Error(`DESTRUCTIVE_MIGRATION_REJECTED:${name}`);
    files.push({
      version,
      name,
      sql,
      checksum: createHash("sha256")
        .update(sql.replace(/\r\n/g, "\n"))
        .digest("hex"),
    });
  }
  return files;
}

export async function migratePoints(sql: Sql, dir = POINTS_MIGRATIONS_DIR) {
  const files = await loadPointsMigrations(dir);
  const reserved = await sql.reserve();
  const applied: string[] = [];
  try {
    await reserved`SELECT pg_advisory_lock(hashtext('veined-points-migrations'))`;
    await reserved`CREATE TABLE IF NOT EXISTS public.veined_points_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const rows = await reserved<
      { version: number; checksum: string; name: string }[]
    >`
      SELECT version, name, checksum FROM public.veined_points_migrations ORDER BY version`;
    for (const row of rows) {
      const file = files.find((f) => f.version === row.version);
      if (!file) throw Error(`SCHEMA_AHEAD_OF_CODE:${row.version}`);
      if (file.checksum !== row.checksum)
        throw Error(`MIGRATION_CHECKSUM_MISMATCH:${row.name}`);
    }
    for (const file of files) {
      if (rows.some((r) => r.version === file.version)) continue;
      await reserved`BEGIN`;
      try {
        await reserved.unsafe(file.sql);
        await reserved`INSERT INTO public.veined_points_migrations (version, name, checksum)
          VALUES (${file.version}, ${file.name}, ${file.checksum})`;
        await reserved`COMMIT`;
      } catch (error) {
        await reserved`ROLLBACK`;
        throw error;
      }
      applied.push(file.name);
    }
    return { applied, schemaVersion: files.length };
  } finally {
    await reserved`SELECT pg_advisory_unlock(hashtext('veined-points-migrations'))`.catch(
      () => {},
    );
    reserved.release();
  }
}
