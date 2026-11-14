import { z } from "zod";
import { activeCatalog } from "../../../catalog/service";
import {
  apiGuard,
  guardStatus,
  refreshAllowed,
} from "../../../server/api-guard";
import { boundedBody } from "../../../server/body";
import { RoutingError } from "../../../routing/model";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    await apiGuard(req, "catalog", 60);
    const input = z
      .object({ refresh: z.boolean().optional() })
      .strict()
      .parse(JSON.parse(await boundedBody(req)));
    return Response.json(
      await activeCatalog(
        req.signal,
        !!input.refresh && (await refreshAllowed("catalog")),
      ),
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (e) {
    const code = e instanceof RoutingError ? e.code : "INVALID_REQUEST";
    return Response.json(
      { error: code },
      { status: guardStatus(code), headers: { "Cache-Control": "no-store" } },
    );
  }
}
