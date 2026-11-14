// G13 (VBA-P1-03): whether two reads of the routing catalog list exactly the same networks and tools — the content
// the route source's generation hash covers (src/adapters/routing-core.ts, unchanged). Pure; used by the Bridge form
// to tell a timestamp-only catalog refill (adopt it, read the route once more) from a real content change (adopt it
// and ask the user to check the selection). It never decides anything about a quote's own numbers.
import type { Catalog } from "../routing/model";

export function sameCatalogContent(
  a: Pick<Catalog, "networks" | "tools">,
  b: Pick<Catalog, "networks" | "tools">,
): boolean {
  return (
    JSON.stringify([a.networks, a.tools]) ===
    JSON.stringify([b.networks, b.tools])
  );
}
