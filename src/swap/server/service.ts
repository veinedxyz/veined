import {
  assertQuote,
  canonical,
  POLICY,
  quoteEligible,
  SwapError,
  type QuoteEvent,
  type SwapIntent,
  type SwapQuote,
} from "../model";
import { swapConfig } from "./config";
import { QuoteCoordinator } from "./coordinator";
import { digest } from "./digest";
import { decodeEvm } from "./evm";
import { verifyPools } from "./pools";
import { inspectSolana, assertSolanaReviewable } from "./solana";
import { simulate } from "./simulation";
import { simulateEvmEconomic } from "./evm-simulation";
import type { QuoteAdapter } from "./provider";
import { uniswap } from "./providers/uniswap";
import { uniswapx } from "./providers/uniswapx";
import { pancake } from "./providers/pancake";
import { aerodrome } from "./providers/aerodrome";
import { jupiter } from "./providers/jupiter";
import { titan } from "./providers/titan";
import { pcsx } from "./providers/pcsx";
import { recordSwapHealth } from "./health";
import { registry } from "../../data/observability/metrics";
export class SwapService {
  readonly coordinator: QuoteCoordinator;
  private quotes = new Map<string, { q: SwapQuote; i: SwapIntent }>();
  constructor(private adapters: QuoteAdapter[]) {
    this.coordinator = new QuoteCoordinator(adapters);
  }
  async quote(
    i: SwapIntent,
    signal: AbortSignal,
    emit: (e: QuoteEvent) => void,
  ) {
    const started = Date.now();
    let first = true;
    await this.coordinator.compete(i, signal, (e) => {
      if (e.type === "quote") {
        if (first)
          registry().observe("swap_first_quote_ms", {}, Date.now() - started);
        first = false;
        this.quotes.set(e.quote.id, {
          q: structuredClone(e.quote),
          i: structuredClone(i),
        });
        while (this.quotes.size > POLICY.maxEntries)
          this.quotes.delete(this.quotes.keys().next().value!);
      }
      emit(e);
    });
  }
  async review(id: string, i: SwapIntent, signal: AbortSignal) {
    const stored = this.quotes.get(id);
    if (!stored) throw new SwapError("QUOTE_STALE");
    const { q } = stored;
    if (canonical(stored.i) !== canonical(i))
      throw new SwapError("REVIEW_REQUIRED");
    assertQuote(q, i, digest(i));
    if (!quoteEligible(q)) throw new SwapError("HIGH_PRICE_IMPACT");
    const config = swapConfig();
    if (!config.review || !config.build || config.killed.has(q.mode))
      throw new SwapError("BUILD_REVIEW_REQUIRED");
    const adapter = this.adapters.find((a) => a.mode === q.mode);
    if (!adapter?.build || q.build !== "UNSIGNED_BUILD")
      throw new SwapError("BUILD_REVIEW_REQUIRED");
    const started = Date.now(),
      build = await adapter.build(q, i, signal),
      buildMs = Date.now() - started;
    let phase: "decode" | "simulation" = "decode";
    try {
      const decoded =
        build.ecosystem === "EVM"
          ? decodeEvm(build, q, i)
          : await inspectSolana(build, i, signal, q);
      const poolProof =
        build.ecosystem === "EVM" ? await verifyPools(q, i, signal) : null;
      recordSwapHealth({
        mode: q.mode,
        chain: i.chain,
        phase,
        status: "OK",
        latencyMs: Math.min(120000, Date.now() - started),
      });
      phase = "simulation";
      const simStart = Date.now(),
        simulation =
          build.ecosystem === "EVM"
            ? await simulateEvmEconomic(build, i, q, signal, poolProof!.block)
            : await simulate(
                build,
                i,
                signal,
                (decoded as Awaited<ReturnType<typeof inspectSolana>>)
                  .economics,
              );
      if (build.ecosystem === "SVM")
        assertSolanaReviewable(
          decoded as Awaited<ReturnType<typeof inspectSolana>>,
        );
      assertQuote(q, i, digest(i));
      if (simulation.transactionDigest !== digest(build))
        throw new SwapError("REVIEW_REQUIRED");
      const review = {
        state: "EXECUTION_CLOSED" as const,
        verifiedForReview: true,
        quote: q,
        intent: i,
        decoded,
        poolProof,
        simulation,
        expiresAt: q.expiresAt,
        transactionDigest: digest(build),
        timings: { buildMs, simulationMs: Date.now() - simStart },
      };
      recordSwapHealth({
        mode: q.mode,
        chain: i.chain,
        phase,
        status: "OK",
        latencyMs: Math.min(120000, Date.now() - simStart),
      });
      return { ...review, digest: digest(review) };
    } catch (e) {
      recordSwapHealth({
        mode: q.mode,
        chain: i.chain,
        phase,
        status: e instanceof SwapError ? e.code : "PROVIDER_UNAVAILABLE",
        latencyMs: Math.min(120000, Date.now() - started),
      });
      throw e;
    }
  }
}
let singleton: SwapService | undefined,
  configKey = "";
export function swapService() {
  const c = swapConfig(),
    key = digest({ ...c, killed: [...c.killed].sort() });
  if (!singleton || key !== configKey) {
    configKey = key;
    const adapters = [
      uniswap(c.uniswapKey),
      uniswapx(c.uniswapKey),
      pancake,
      pcsx(c.pcsx, c.pcsxKey),
      aerodrome(),
      aerodrome(false),
      jupiter(c.jupiterKey, "JUPITER_META"),
      jupiter(c.jupiterKey, "JUPITER_ROUTER"),
      titan(c.titanEndpoint, c.titanToken),
    ].filter((a) => !c.killed.has(a.mode));
    singleton = new SwapService(adapters);
  }
  return singleton;
}
