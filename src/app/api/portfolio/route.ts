import { randomUUID } from "node:crypto";
import { z } from "zod";
import { apiGuard, guardStatus } from "../../../server/api-guard";
import { boundedBody } from "../../../server/body";
import { RoutingError } from "../../../routing/model";
import { identitySchema } from "../../../portfolio/model";
import { identityScope, scanPortfolio } from "../../../portfolio/service";
import type { PortfolioResult } from "../../../portfolio/model";
import {
  parseWalletLine,
  resultLineSchema,
  type WalletReceipt,
} from "../../../portfolio/stream";
import { NativePortfolioProvider } from "../../../portfolio/providers";
import { routingCore, upstreamRead } from "../../../adapters/routing-core";
import { getDataPlane } from "../../../data/plane";
import { SelfHostedPortfolioProvider } from "../../../data/portfolio/provider";
import { walletPseudonym } from "../../../data/core/privacy";
import { logEvent } from "../../../data/observability/log";
import { registry } from "../../../data/observability/metrics";
export const runtime = "nodejs";
// V1.11 single-flight: identical scans (same wallet scope, continuation, priority and extra contracts) that
// arrive concurrently — e.g. two tabs — share one upstream scan instead of doubling RPC load.
// V1.14.2: a flight also records its validated progress lines, so a second identical request (another tab) replays
// them and follows the same scan; a JSON request simply awaits the complete round.
interface Flight {
  lines: string[];
  listeners: Set<(line: string) => void>;
  started: Promise<void>;
  result: Promise<{ result: PortfolioResult; receipt?: WalletReceipt }>;
}
const inflight = new Map<string, Flight>();
const chainId = z.string().regex(/^\d{1,18}$/);
const NDJSON = "application/x-ndjson";
const errorCode = (e: unknown) =>
  e instanceof RoutingError
    ? e.code
    : e instanceof Error && /CONTINUATION/.test(e.message)
      ? "INVALID_CONTINUATION"
      : "INVALID_REQUEST";
// Browser -> app server -> Otherbridge data plane (in-process). No API key reaches the browser.
export async function POST(req: Request) {
  const requestId = `req_${randomUUID().replace(/-/g, "")}`;
  const headers = {
    "Cache-Control": "private, no-store",
    Vary: "Origin, Accept",
    "X-Request-Id": requestId,
  };
  try {
    await apiGuard(req, "portfolio", 12);
    const input = z
      .object({
        identity: identitySchema,
        consent: z.literal(true),
        continuation: z.string().max(40000).optional(),
        // V1.11: the connected wallet's chain first (scan order only; never a different identity).
        priority: z.array(chainId).max(5).optional(),
        // V1.11: user-imported exact contracts (fixed balanceOf calldata; ≤ 25 per chain, ≤ 5 chains).
        extraTokens: z
          .record(
            chainId,
            z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).max(25),
          )
          .refine((v) => Object.keys(v).length <= 5)
          .optional(),
        // V1.14.2 scheduling evidence from this client (order only; never a balance): networks where the same
        // identity held value in its previous scan, and the user's current Bridge / Swap network.
        hints: z
          .object({
            recent: z.array(chainId).max(24).optional(),
            context: z.array(chainId).max(5).optional(),
          })
          .strict()
          .optional(),
        // V1.14.2 explicit refresh: the short wallet-chain result cache is skipped.
        fresh: z.literal(true).optional(),
      })
      .strict()
      .parse(JSON.parse(await boundedBody(req)));
    const extraTokens = new Map(
      Object.entries(input.extraTokens ?? {}).map(([k, v]) => [
        k,
        [...new Set(v.map((a) => a.toLowerCase()))],
      ]),
    );
    const flightKey = JSON.stringify([
      identityScope(input.identity),
      input.continuation ?? "",
      input.priority ?? [],
      [...extraTokens.entries()].sort(),
      input.hints?.recent ?? [],
      input.hints?.context ?? [],
      input.fresh ?? false,
    ]);
    // Registered synchronously (before any await) so a concurrent identical request always finds it.
    let flight = inflight.get(flightKey);
    if (!flight) {
      const lines: string[] = [];
      const listeners = new Set<(line: string) => void>();
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => (markStarted = resolve));
      let receipt: WalletReceipt | undefined;
      const result = (async () => {
        const [plane, catalog] = await Promise.all([
          getDataPlane(),
          routingCore.listNetworks(),
        ]);
        const begin = Date.now();
        const value = await scanPortfolio(
          input.identity,
          catalog,
          // A shared scan is bounded by its own deadline, not by the first caller's connection.
          undefined,
          [
            new SelfHostedPortfolioProvider(
              plane,
              catalog,
              upstreamRead,
              undefined,
              extraTokens,
            ),
            new NativePortfolioProvider(),
          ],
          {
            continuation: input.continuation ?? null,
            priority: input.priority,
            concurrency: 8,
            deadlineMs: 18000,
            perChainMs: 7000,
            maxChains: 2000,
            // V1.14.2 progressive multi-wave scan; parallelism adapts between 8 and a hard maximum of 16.
            waves: true,
            maxConcurrency: 16,
            hints: input.hints,
            fresh: input.fresh,
            onEvent: (event) => {
              if (event.type === "scheduler") {
                receipt = event.receipt;
                return;
              }
              // Every streamed unit is schema-validated; an invalid line is never sent.
              let line: string;
              try {
                line = JSON.stringify(parseWalletLine(event));
              } catch {
                return;
              }
              lines.push(line);
              markStarted();
              for (const l of listeners) l(line);
            },
            onRun: ({ elapsedMs, result }) => {
              const s = result.coverageSummary;
              const state = /^[A-Z_]{1,20}$/.test(result.state)
                ? result.state
                : "OTHER";
              registry().inc(
                "portfolio_scans_total",
                { origin: "app", state },
                1,
                "Portfolio scans (no wallet labels).",
              );
              registry().observe(
                "portfolio_scan_duration_ms",
                { origin: "app" },
                elapsedMs,
                "Portfolio scan duration.",
              );
              registry().inc(
                "portfolio_chains_checked_total",
                { origin: "app" },
                s.checked,
              );
              registry().inc(
                "portfolio_chains_failed_total",
                { origin: "app" },
                s.failed,
              );
              registry().inc(
                "portfolio_chains_pending_total",
                { origin: "app" },
                s.pending,
              );
              if (plane.store === null)
                registry().inc(
                  "portfolio_data_plane_unavailable_total",
                  { origin: "app" },
                  1,
                  "Scans served without the datastore (DEGRADED registry).",
                );
              logEvent("portfolio.scan", {
                requestId,
                elapsedMs,
                planned: s.planned,
                checked: s.checked,
                pending: s.pending,
                failed: s.failed,
                state: result.state,
              });
              if (plane.store)
                void plane.store
                  .recordScanRun({
                    id: requestId,
                    walletHash: walletPseudonym(JSON.stringify(input.identity)),
                    origin: "app",
                    clientId: null,
                    startedAt: begin,
                    finishedAt: Date.now(),
                    state: result.state,
                    planned: s.planned,
                    checked: s.checked,
                    pending: s.pending,
                    failed: s.failed,
                    coverage: result.coverage.map((c) => ({
                      chainId: c.chainId,
                      state: c.state,
                      tier: c.tier,
                      observedBlock: c.observedBlock,
                    })),
                  })
                  .catch(() => {});
            },
          },
        );
        return { result: value, receipt };
      })();
      result.catch(() => {});
      flight = { lines, listeners, started, result };
      inflight.set(flightKey, flight);
      void result.finally(() => inflight.delete(flightKey)).catch(() => {});
    }
    const current = flight;
    if (!(req.headers.get("accept") ?? "").includes(NDJSON))
      return Response.json((await current.result).result, { headers });
    // The response starts once the plan exists (a rejected cursor or identity still gets its HTTP status).
    await Promise.race([current.started, current.result]);
    const encoder = new TextEncoder();
    let send: ((line: string) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        send = (line: string) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(line + "\n"));
          } catch {
            open = false;
          }
        };
        for (const line of current.lines) send(line);
        current.listeners.add(send);
        const finish = (line: unknown) => {
          current.listeners.delete(send!);
          send!(JSON.stringify(line));
          open = false;
          try {
            controller.close();
          } catch {
            /* Already closed by the client. */
          }
        };
        current.result.then(
          ({ result, receipt }) => {
            const line = resultLineSchema.safeParse({
              type: "result",
              result,
              ...(receipt ? { receipt } : {}),
            });
            finish(
              line.success
                ? line.data
                : { type: "error", error: "SCAN_FAILED" },
            );
          },
          (e) => finish({ type: "error", error: errorCode(e) }),
        );
      },
      cancel() {
        if (send) current.listeners.delete(send);
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
    const code = errorCode(e);
    return Response.json(
      { error: code, requestId },
      { status: guardStatus(code), headers },
    );
  }
}
