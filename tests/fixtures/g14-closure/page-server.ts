// G14 follow-up (F2) — SYNTHETIC_TEST_ONLY: the page's same-origin server as the wallet adapter sees it.
// The adapter captures the page's fetch when its module is evaluated and mints a canary dispatch authority only from
// the answers that come back through it (src/features/wallet/adapter.ts obtainCanaryDispatchAuthority). Tests
// therefore install, BEFORE the adapter module is evaluated (import this module first), a delegating global fetch:
// "/api/execution" goes to whatever `pageServer.handler` is at the time of the call — the REAL API route of the
// test's process, the real runtime directly, or a stub that plays a server answer — and anything else goes to the
// fetch that was there before. Nothing here reaches a network.
type Handler = (body: Record<string, unknown>) => Promise<Response>;
const KEY = Symbol.for("veined.g14.page-server");
type State = {
  handler: Handler | null;
  /** Where every OTHER URL goes (default: the fetch that was there before); a test may point it at a fake chain. */
  next: typeof fetch | null;
  calls: Record<string, unknown>[];
};
const g = globalThis as unknown as Record<symbol, State | undefined>;
export const pageServer: State = (g[KEY] ??= (() => {
  const state: State = { handler: null, next: null, calls: [] };
  const prior = globalThis.fetch?.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/execution") {
      const body = JSON.parse(String(init?.body ?? "null")) as Record<
        string,
        unknown
      >;
      state.calls.push(body);
      if (!state.handler) throw new TypeError("NO_PAGE_SERVER");
      return state.handler(body);
    }
    const other = state.next ?? prior;
    if (!other) throw new TypeError("NO_FETCH");
    return other(input, init);
  }) as typeof fetch;
  return state;
})());
export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
/** "/api/execution" answered by a route handler of this process (the real API route), as the browser would call it. */
export function routeServer(
  post: (req: Request) => Promise<Response>,
  make: (body: string) => Request,
): Handler {
  return (body) => post(make(JSON.stringify(body)));
}
/**
 * A stub server playing the two answers the adapter asks for, from the legacy test callbacks:
 *   confirmPrepared(p) -> the preparation the "server" confirms (anything; the adapter checks it);
 *   persistUnknown(ref) -> true = the durable REQUESTED record is committed; a promise that never settles = no answer
 *     (the adapter's own bound); anything else = an answer that is not a commit (outcome unknown).
 */
export function legacyServer(server: {
  confirmPrepared?: (p: {
    record: string;
    action: "APPROVE" | "SEND";
    review: string;
    attempt: string;
    digest: string;
  }) => unknown;
  persistUnknown?: (ref: never) => unknown;
  serverNow?: () => number;
}): Handler {
  return async (body) => {
    if (body.action === "canary-confirm") {
      if (!server.confirmPrepared)
        return json({ error: "ATTEMPT_UNKNOWN" }, 422);
      const preparation = await server.confirmPrepared({
        record: body.record as string,
        action: body.step as "APPROVE" | "SEND",
        review: body.review as string,
        attempt: body.attempt as string,
        digest: body.digest as string,
      });
      return json({
        preparation,
        serverNow: (server.serverNow ?? Date.now)(),
      });
    }
    if (body.action === "canary-record" && body.kind === "requested") {
      const ref = body.ref as Record<string, string>;
      const v = await server.persistUnknown?.(ref as never);
      if (v === true)
        return json({
          ok: true,
          state: "REQUESTED",
          attempt: ref.attempt,
          digest: ref.digest,
          request: ref.request,
        });
      return json({ error: "PROVIDER_UNAVAILABLE" }, 500);
    }
    return json({ error: "INVALID_REQUEST" }, 422);
  };
}
