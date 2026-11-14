import {
  assertQuote,
  POLICY,
  SwapError,
  type ProviderHealth,
  type QuoteEvent,
  type SwapIntent,
  type SwapQuote,
} from "../model";
import { digest } from "./digest";
import type { QuoteAdapter } from "./provider";
import { recordSwapHealth } from "./health";
import { swapConfig } from "./config";
type Flight = {
  promise: Promise<SwapQuote[]>;
  listeners: Set<(q: SwapQuote) => void>;
  latest: SwapQuote[];
  cancel: () => void;
};
type Lane = {
  active: number;
  failures: number;
  cooldown: number;
  flights: Map<string, Flight>;
  cache: Map<string, { until: number; quotes: SwapQuote[] }>;
  health: ProviderHealth;
};
/** Bounded shared upstream work; cancelling one subscriber never cancels another subscriber's quote. */
export class QuoteCoordinator {
  private lanes = new Map<string, Lane>();
  constructor(
    readonly adapters: QuoteAdapter[],
    private timeoutMs: number = POLICY.timeoutMs,
  ) {}
  health() {
    return [...this.lanes.values()].map((l) => ({ ...l.health }));
  }
  private lane(a: QuoteAdapter) {
    let l = this.lanes.get(a.mode);
    if (!l) {
      l = {
        active: 0,
        failures: 0,
        cooldown: 0,
        flights: new Map(),
        cache: new Map(),
        health: {
          mode: a.mode,
          status: "PENDING",
          latencyMs: null,
          quoteCount: 0,
        },
      };
      this.lanes.set(a.mode, l);
    }
    return l;
  }
  async compete(
    i: SwapIntent,
    signal: AbortSignal,
    emit: (event: QuoteEvent) => void,
  ) {
    const started = Date.now(),
      binding = digest(i);
    const eligible = this.adapters.filter(
      (a) =>
        !swapConfig().killed.has(a.mode) &&
        a.chains.includes(i.chain) &&
        (i.kind === "EXACT_IN" || a.exactOut),
    );
    const send = (e: QuoteEvent) => {
      if (!signal.aborted) emit(e);
    };
    send({
      type: "providers",
      providers: eligible.map((a) => ({
        mode: a.mode,
        status: "PENDING",
        latencyMs: null,
        quoteCount: 0,
      })),
    });
    await Promise.allSettled(
      eligible.map(async (a) => {
        const began = Date.now();
        const l = this.lane(a);
        let count = 0;
        const receive = (q: SwapQuote) => {
          if (swapConfig().killed.has(a.mode)) throw new SwapError("CANCELLED");
          assertQuote(q, i, binding);
          count++;
          send({ type: "quote", quote: structuredClone(q) });
        };
        try {
          const cached = l.cache.get(binding);
          if (
            cached &&
            cached.until > Date.now() &&
            cached.quotes.every((q) => q.expiresAt > Date.now())
          )
            cached.quotes.forEach(receive);
          else {
            let flight = l.flights.get(binding);
            if (!flight) {
              if (l.cooldown > Date.now() || l.active >= POLICY.concurrency)
                throw new SwapError("RATE_LIMITED");
              l.active++;
              const listeners = new Set<(q: SwapQuote) => void>(),
                latest: SwapQuote[] = [];
              const abort = new AbortController();
              let timer: ReturnType<typeof setTimeout>;
              const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  reject(new SwapError("PROVIDER_TIMEOUT"));
                  abort.abort();
                }, this.timeoutMs);
              });
              let cancelFlight: () => void = () => {};
              const cancelled = new Promise<never>((_, reject) => {
                cancelFlight = () => {
                  reject(new SwapError("CANCELLED"));
                  abort.abort();
                };
              });
              const publish = (q: SwapQuote) => {
                if (abort.signal.aborted) return;
                if (swapConfig().killed.has(a.mode))
                  throw new SwapError("CANCELLED");
                assertQuote(q, i, binding);
                q.latencyMs = Date.now() - began;
                latest.push(structuredClone(q));
                if (latest.length > 32) latest.shift();
                for (const f of listeners) f(q);
              };
              const promise = Promise.race([
                Promise.resolve().then(() => {
                  if (swapConfig().killed.has(a.mode))
                    throw new SwapError("CANCELLED");
                  return a.quote(i, abort.signal, publish);
                }),
                timeout,
                cancelled,
              ])
                .then((qs) => {
                  if (abort.signal.aborted) throw new SwapError("CANCELLED");
                  qs.forEach((q) => {
                    if (!latest.some((v) => v.id === q.id)) publish(q);
                  });
                  if (!latest.length) throw new SwapError("NO_LIQUIDITY");
                  l.failures = 0;
                  l.cooldown = 0;
                  l.cache.set(binding, {
                    until: Date.now() + POLICY.cacheMs,
                    quotes: structuredClone(latest),
                  });
                  while (l.cache.size > POLICY.maxEntries)
                    l.cache.delete(l.cache.keys().next().value!);
                  return latest;
                })
                .catch((e) => {
                  if (e instanceof SwapError && e.code === "CANCELLED") throw e;
                  l.failures++;
                  l.cooldown =
                    Date.now() +
                    Math.min(30000, 1000 * 2 ** Math.min(l.failures, 5));
                  throw e;
                })
                .finally(() => {
                  clearTimeout(timer);
                  abort.abort();
                  l.active--;
                  l.flights.delete(binding);
                });
              flight = { promise, listeners, latest, cancel: cancelFlight };
              l.flights.set(binding, flight);
            }
            flight.latest.forEach(receive);
            flight.listeners.add(receive);
            let rejectSubscriber: () => void = () => {};
            const subscriberCancelled = new Promise<never>((_, reject) => {
              rejectSubscriber = () => reject(new SwapError("CANCELLED"));
            });
            const onAbort = () => {
              flight!.listeners.delete(receive);
              if (!flight!.listeners.size) flight!.cancel();
              rejectSubscriber();
            };
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
            try {
              await Promise.race([flight.promise, subscriberCancelled]);
            } finally {
              signal.removeEventListener("abort", onAbort);
              flight.listeners.delete(receive);
            }
          }
          l.health = {
            mode: a.mode,
            status: "OK",
            latencyMs: Date.now() - began,
            quoteCount: count,
          };
        } catch (e) {
          l.health = {
            mode: a.mode,
            status: e instanceof SwapError ? e.code : "PROVIDER_UNAVAILABLE",
            latencyMs: Date.now() - began,
            quoteCount: count,
          };
        }
        if (l.health.status !== "PENDING" && l.health.status !== "CANCELLED")
          recordSwapHealth({
            mode: a.mode,
            chain: i.chain,
            phase: "quote",
            status: l.health.status,
            latencyMs: Math.min(120000, Date.now() - began),
            cooldownUntil: l.cooldown,
          });
        send({ type: "health", health: { ...l.health } });
      }),
    );
    send({ type: "settled", elapsedMs: Date.now() - started });
  }
}
