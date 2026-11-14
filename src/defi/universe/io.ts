import { universeSchema, type Universe } from "./model";
// One entity per line: the accepted catalog stays reviewable and git-delta friendly while remaining plain JSON.
export function serializeUniverse(u: Universe) {
  const list = (items: unknown[]) =>
    items.length
      ? "[\n" + items.map((x) => JSON.stringify(x)).join(",\n") + "\n]"
      : "[]";
  const head = {
    version: u.version,
    syncId: u.syncId,
    generatedAt: u.generatedAt,
    sources: u.sources,
    stats: u.stats,
  };
  return (
    JSON.stringify(head).slice(0, -1) +
    ',\n"categories": ' +
    list(u.categories) +
    ',\n"chains": ' +
    list(u.chains) +
    ',\n"protocols": ' +
    list(u.protocols) +
    ',\n"rows": ' +
    list(u.rows) +
    "\n}\n"
  );
}
export function parseUniverse(text: string): Universe {
  if (text.length > 64 * 1024 * 1024) throw Error("CATALOG_TOO_LARGE");
  return universeSchema.parse(JSON.parse(text));
}
export const writeLines = (items: unknown[]) =>
  "[\n" + items.map((x) => JSON.stringify(x)).join(",\n") + "\n]\n";
