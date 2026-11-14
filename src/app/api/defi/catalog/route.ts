import { z } from "zod";
import { apiGuard, guardStatus } from "../../../../server/api-guard";
import { boundedBody } from "../../../../server/body";
import { RoutingError } from "../../../../routing/model";
import {
  CatalogQueryError,
  coverageReport,
  loadCatalog,
  protocolDetail,
  queryChains,
  queryProtocols,
} from "../../../../defi/universe/store";
export const runtime = "nodejs";
// V1.14 Explore DeFi coverage: bounded pages over the accepted last-good catalog. No upstream fetch happens here and
// no wallet data is involved; TVL is returned only as labelled protocol context.
const text = z.string().max(130).nullable().optional();
const page = {
  cursor: z.string().max(300).nullable().optional(),
  limit: z.number().int().min(1).max(50).optional(),
};
const input = z.discriminatedUnion("view", [
  z
    .object({
      view: z.literal("protocols"),
      q: text,
      category: text,
      chain: text,
      coverage: text,
      status: text,
      vm: text,
      sort: text,
      ...page,
    })
    .strict(),
  z
    .object({ view: z.literal("protocol"), id: z.string().min(1).max(130) })
    .strict(),
  z
    .object({
      view: z.literal("chains"),
      q: text,
      vm: text,
      capability: text,
      status: text,
      sort: text,
      ...page,
    })
    .strict(),
  z.object({ view: z.literal("summary") }).strict(),
]);
export async function POST(req: Request) {
  const headers = { "Cache-Control": "no-store", Vary: "Origin" };
  try {
    await apiGuard(req, "defi-catalog", 120);
    const body = input.parse(JSON.parse(await boundedBody(req)));
    const index = await loadCatalog().catch(() => {
      throw new RoutingError("CATALOG_UNAVAILABLE", 503);
    });
    const result =
      body.view === "protocols"
        ? queryProtocols(index, body)
        : body.view === "chains"
          ? queryChains(index, body)
          : body.view === "protocol"
            ? protocolDetail(index, body.id)
            : (() => {
                const r = coverageReport(index);
                return {
                  catalogVersion: r.catalogVersion,
                  stats: r.stats,
                  protocolHeadline: r.protocolHeadline,
                  chainsByVm: r.chainsByVm,
                };
              })();
    if (result === null)
      return Response.json({ error: "NOT_FOUND" }, { status: 404, headers });
    return Response.json(result, { headers });
  } catch (e) {
    const code =
      e instanceof RoutingError
        ? e.code
        : e instanceof CatalogQueryError
          ? e.message
          : "INVALID_REQUEST";
    return Response.json(
      { error: /^[A-Z_]{3,40}$/.test(code) ? code : "INVALID_REQUEST" },
      {
        status:
          e instanceof CatalogQueryError
            ? 400
            : code === "CATALOG_UNAVAILABLE"
              ? (guardStatus(code), 503)
              : guardStatus(code),
        headers,
      },
    );
  }
}
