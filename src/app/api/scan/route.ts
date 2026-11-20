import { z } from "zod";
import { scanIndex, startScanWorker } from "../../../scan/server";
import { apiGuard, guardStatus } from "../../../server/api-guard";
import { boundedBody } from "../../../server/body";
import { ActivityError } from "../../../activity/verify";
const input = z
  .object({
    q: z.string().max(66).default(""),
    chain: z.enum(["all", "8453", "42161"]).default("all"),
    refresh: z.boolean().default(false),
  })
  .strict();
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const started = performance.now();
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  try {
    await apiGuard(req, "scan-read", 90);
    const {
      q: raw,
      chain,
      refresh,
    } = input.parse(JSON.parse(await boundedBody(req, 1024)));
    const q = raw.toLowerCase();
    const index = scanIndex();
    const errors = index.ingest();
    startScanWorker();
    if (q && !/^0x[0-9a-f]{40}$/.test(q) && !/^0x[0-9a-f]{64}$/.test(q))
      return Response.json(
        { error: "INVALID_SEARCH" },
        { status: 422, headers },
      );
    let rows;
    if (q.length === 66) {
      if (chain === "all")
        return Response.json(
          { error: "SELECT_TRANSACTION_CHAIN" },
          { status: 422, headers },
        );
      const saved = index.list(undefined, chain, q);
      rows = refresh || !saved.length ? [await index.lookup(chain, q)] : saved;
    } else
      rows = index
        .list(q || undefined, chain === "all" ? undefined : chain)
        .filter((r) => q || r.provenance === "VEINED_SUBMISSION");
    return Response.json(
      {
        records: rows.slice(0, 200),
        errors,
        coverage:
          "VEINED submissions and verified imports only. Complete public address history requires a historical indexer.",
        durationMs: Math.round(performance.now() - started),
        asOf: Date.now(),
      },
      { headers },
    );
  } catch (e) {
    const raw = e as { code?: string; message?: string };
    const code = raw.code ?? raw.message ?? "SCAN_UNAVAILABLE";
    const error = /^[A-Z][A-Z0-9_]{0,64}$/.test(code)
      ? code
      : "SCAN_UNAVAILABLE";
    return Response.json(
      {
        error,
        ...(e instanceof ActivityError ? { sources: e.sources } : {}),
        durationMs: Math.round(performance.now() - started),
      },
      {
        status: e instanceof ActivityError ? 503 : guardStatus(error),
        headers,
      },
    );
  }
}
