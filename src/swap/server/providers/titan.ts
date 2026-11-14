import { base58 } from "@scure/base";
import {
  connectTitan,
  titanFrameSchema,
  type TitanFrame,
  type TitanConnection,
} from "../titan-transport";
import { SwapError, type SwapIntent, type SwapQuote } from "../../model";
import { baseCosts, makeQuote, type QuoteAdapter } from "../provider";
function safeAmount(n: unknown): bigint {
  if (typeof n === "bigint" && n >= 0n && n < 2n ** 64n) return n;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
    throw new SwapError("INVALID_SCHEMA");
  return BigInt(n);
}
export function normalizeTitan(
  frame: TitanFrame,
  i: SwapIntent,
): { q: SwapQuote; transaction?: Uint8Array }[] {
  try {
    frame = titanFrameSchema.parse(frame);
    if (
      base58.encode(frame.inputMint) !== i.tokenIn.address ||
      base58.encode(frame.outputMint) !== i.tokenOut.address ||
      frame.swapMode !== "ExactIn" ||
      safeAmount(frame.amount) !== i.amount ||
      Object.keys(frame.quotes).length > 16
    )
      throw new SwapError("INVALID_SCHEMA");
    return Object.values(frame.quotes).map((r) => {
      if (
        !Number.isInteger(r.slippageBps) ||
        r.slippageBps < 0 ||
        r.slippageBps > i.slippage.bps ||
        safeAmount(r.inAmount) !== i.amount ||
        r.steps.some(
          (s) =>
            !Number.isInteger(s.allocPpb) ||
            s.allocPpb <= 0 ||
            s.allocPpb > 1_000_000_000,
        ) ||
        r.steps.length > 32 ||
        r.steps.length === 0
      )
        throw new SwapError("INVALID_SCHEMA");
      const costs = baseCosts(i.tokenOut.address);
      if (r.platformFee) {
        costs[1].amount = safeAmount(r.platformFee.amount);
        costs[1].usdMicros = null;
      }
      const q = makeQuote(
        i,
        "Titan",
        "TITAN",
        safeAmount(r.inAmount),
        safeAmount(r.outAmount),
        r.steps.map((s) => ({
          venue: s.label,
          poolType: "SOLANA",
          pool: base58.encode(s.ammKey),
          tokenIn: base58.encode(s.inputMint),
          tokenOut: base58.encode(s.outputMint),
          shareBps: Math.max(1, Math.round(s.allocPpb / 100000)),
        })),
        {
          costs,
          slippageBps: r.slippageBps,
          sourceBlock:
            r.contextSlot === undefined ? null : String(r.contextSlot),
          build: r.transaction ? "UNSIGNED_BUILD" : "QUOTE_ONLY",
        },
      );
      if (r.expiresAtMs !== undefined) {
        if (!Number.isSafeInteger(r.expiresAtMs))
          throw new SwapError("INVALID_SCHEMA");
        q.expiresAt = Math.min(q.expiresAt, r.expiresAtMs);
      }
      return { q, transaction: r.transaction };
    });
  } catch {
    throw new SwapError("INVALID_SCHEMA");
  }
}
export function titan(
  endpoint: string,
  token: string,
  filters: {
    dexes?: string[];
    excludeDexes?: string[];
    providers?: string[];
    venueAllowlist?: Uint8Array[];
    venueBanlist?: Uint8Array[];
  } = {},
  connect: (
    url: string,
    signal: AbortSignal,
  ) => Promise<TitanConnection> = connectTitan,
): QuoteAdapter {
  const builds = new Map<string, Uint8Array>();
  return {
    mode: "TITAN",
    provider: "Titan",
    chains: ["solana"],
    exactOut: false,
    async quote(i, signal, onQuote) {
      if (!endpoint || !token) throw new SwapError("CREDENTIAL_REQUIRED");
      const url = new URL(endpoint);
      if (
        url.protocol !== "wss:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new SwapError("REVIEW_REQUIRED");
      if (
        connect === connectTitan &&
        (url.origin !== "wss://api.titan.exchange" ||
          url.pathname !== "/api/v1/ws")
      )
        throw new SwapError("BUILD_REVIEW_REQUIRED");
      url.searchParams.set("auth", token);
      const collected: SwapQuote[] = [];
      for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
        let client: TitanConnection | undefined;
        const close = () => {
          void client?.close().catch(() => {});
        };
        try {
          client = await connect(url.toString(), signal);
          if (signal.aborted) {
            close();
            throw new SwapError("CANCELLED");
          }
          signal.addEventListener("abort", close, { once: true });
          const { stream } = await client.newSwapQuoteStream({
            swap: {
              inputMint: base58.decode(i.tokenIn.address),
              outputMint: base58.decode(i.tokenOut.address),
              amount: i.amount,
              swapMode: "ExactIn",
              slippageBps: i.slippage.bps,
              ...filters,
            },
            transaction: { userPublicKey: base58.decode(i.taker), feeBps: 0 },
            update: { numQuotes: 3, intervalMs: 1000 },
          });
          const reader = stream.getReader();
          try {
            for (let frame = 0; frame < 4 && !signal.aborted; frame++) {
              const next = await reader.read();
              if (next.done) break;
              for (const { q, transaction } of normalizeTitan(next.value, i)) {
                if (transaction) builds.set(q.id, Uint8Array.from(transaction));
                while (builds.size > 128)
                  builds.delete(builds.keys().next().value!);
                collected.push(q);
                onQuote?.(q);
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          if (collected.length) return collected;
        } catch (e) {
          if (e instanceof SwapError && e.code === "INVALID_SCHEMA") throw e;
          if (signal.aborted) throw new SwapError("CANCELLED");
        } finally {
          signal.removeEventListener("abort", close);
          close();
        }
      }
      throw new SwapError("PROVIDER_UNAVAILABLE");
    },
    async build(q) {
      const transaction = builds.get(q.id);
      if (!transaction) throw new SwapError("QUOTE_STALE");
      // Titan supplies no matching last-valid height. The shared decoder checks the actual
      // embedded blockhash through isBlockhashValid; never replace it or invent an expiry.
      return {
        ecosystem: "SVM",
        transaction: Buffer.from(transaction).toString("base64"),
        lastValidBlockHeight: null,
      };
    },
  };
}
