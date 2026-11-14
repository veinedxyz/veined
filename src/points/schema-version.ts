import type { Sql } from "postgres";
// Runtime schema check, kept free of filesystem access so the application bundle never includes the migrator
// (src/points/migrate.ts) or traces the project tree.
export const POINTS_SCHEMA_VERSION = 1;

export async function pointsSchemaVersion(sql: Sql): Promise<number> {
  try {
    const [row] = await sql<
      { v: number | null }[]
    >`SELECT max(version) AS v FROM public.veined_points_migrations`;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}
