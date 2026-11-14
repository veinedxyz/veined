import { z } from "zod";
import { apiGuard, guardStatus } from "../../../../server/api-guard";
import { boundedBody } from "../../../../server/body";
import { getDataPlane } from "../../../../data/plane";
import { upstreamRead } from "../../../../adapters/routing-core";
import { scanDefi } from "../../../../defi/scanner";
import {
  deploymentCoverageSchema,
  positionSchema,
} from "../../../../defi/model";
export const runtime = "nodejs";
// V1.14.1 progressive response: a client that accepts NDJSON receives one validated line per finished deployment
// (its coverage, positions and replaced wallet assets) and a final line with the complete schema-checked round, so a
// slow or failing adapter never holds back the results that are already exact. Any other client gets the V1.14 JSON.
const NDJSON = "application/x-ndjson";
const progressSchema = z
  .object({
    coverage: deploymentCoverageSchema,
    positions: z.array(positionSchema).max(5000),
    replaced: z.array(z.string().max(160)).max(5000),
  })
  .strict();
export async function POST(req: Request) {
  const headers = {
    "Cache-Control": "private, no-store",
    Vary: "Origin, Accept",
  };
  try {
    await apiGuard(req, "portfolio-defi", 30);
    const input = z
      .object({
        wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        consent: z.literal(true),
        chains: z
          .array(z.string().regex(/^\d{1,18}$/))
          .min(1)
          .max(24)
          .optional(),
        continuation: z
          .array(z.string().regex(/^[a-z0-9-]{1,120}$/))
          .min(1)
          .max(1000)
          .optional(),
        // V1.14: exact held token ids order candidates (receipt discovery); positions are still read on-chain.
        held: z
          .array(z.string().regex(/^\d{1,20}:0x[0-9a-f]{40}$/))
          .max(1000)
          .optional(),
      })
      .strict()
      .parse(JSON.parse(await boundedBody(req, 64000)));
    const plane = await getDataPlane();
    const options = {
      chains: input.chains,
      deploymentIds: input.continuation,
      held: input.held,
      clientScope: "app-explicit-public-address",
      priceRead: upstreamRead,
    };
    if (!(req.headers.get("accept") ?? "").includes(NDJSON))
      return Response.json(await scanDefi(input.wallet, plane, options), {
        headers,
      });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: unknown) =>
          controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
        try {
          const scan = await scanDefi(input.wallet, plane, {
            ...options,
            onResult: (part) => {
              const parsed = progressSchema.safeParse(part);
              if (parsed.success) send({ type: "progress", ...parsed.data });
            },
          });
          send({ type: "scan", scan });
        } catch {
          send({ type: "error", error: "SCAN_FAILED" });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(body, {
      headers: {
        ...headers,
        "Content-Type": NDJSON + "; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    const code =
      e instanceof Error &&
      /^(RATE_LIMITED|ORIGIN_REJECTED|INVALID_ORIGIN|DURABLE_RATE_LIMIT_UNAVAILABLE)$/.test(
        e.message,
      )
        ? e.message
        : "INVALID_REQUEST";
    return Response.json(
      { error: code },
      { status: guardStatus(code), headers },
    );
  }
}
