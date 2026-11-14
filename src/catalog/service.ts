import { createHash } from "node:crypto";
import { publicData } from "../server/public-data";
import { routingCore } from "../adapters/routing-core";
import { normalizeActive, type ActiveCatalog } from "./model";
import { getDataPlane, portfolioCapabilities } from "../data/plane";
import snapshot from "./snapshot.json" with { type: "json" };
let cache: { raw: unknown; at: number; hash: string } | undefined,
  pending: Promise<ActiveCatalog> | undefined;
export async function activeCatalog(
  signal?: AbortSignal,
  refresh = false,
): Promise<ActiveCatalog> {
  const routes = await routingCore.listNetworks(signal);
  const tiers = await getDataPlane()
    .then(portfolioCapabilities)
    .catch(() => undefined);
  // The shared refresh is not bound to one caller's signal; client refresh is throttled at the route.
  if (!refresh && cache && Date.now() - cache.at < 300000)
    return normalizeActive(cache.raw, routes, cache.at, cache.hash, tiers);
  if (pending) return pending;
  pending = (async () => {
    try {
      const raw = await publicData("https://api.llama.fi/v2/chains"),
        at = Date.now(),
        hash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
      const result = normalizeActive(raw, routes, at, hash, tiers);
      if (result.chains.length < 2) throw Error("INVALID_CATALOG");
      cache = { raw, at, hash };
      return result;
    } catch {
      const old = cache ?? {
        raw: snapshot.raw,
        at: snapshot.observedAt,
        hash: "packaged-stale",
      };
      return {
        ...normalizeActive(old.raw, routes, old.at, old.hash, tiers),
        stale: true,
      };
    }
  })();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}
