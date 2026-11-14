// Server-side Guardian gate for the Swap review (SERVER ONLY). The Swap panel already runs Guardian in the browser;
// this runs the same deterministic rules over the facts the server holds — the bound intent, the reviewed quote and
// the registry's evidence for the exact contracts — so that no caller (VEINED's own UI or a direct API request)
// receives a route "verified for review" that Guardian blocks. Facts only the browser knows (the user's other
// addresses, the competing quotes) stay with the panel; the server never relaxes what the panel decides.
import { knownAsset, registryFor } from "../../assets/registry";
import { SOLANA_CHAIN_ID, textRisk, type RiskFlag } from "../../assets/model";
import type { SwapIntent, SwapQuote, SwapToken } from "../../swap/model";
import type { AssetFacts, SwapFacts, Verdict } from "../model";
import { review } from "../verdict";

const registryChain = (chain: string) =>
  chain === "solana" ? SOLANA_CHAIN_ID : chain;
const same = (a: string, b: string) =>
  /^0x[0-9a-f]{40}$/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Registry evidence for one exact contract; an unknown contract carrying a trusted asset's symbol is flagged. */
export function swapAssetFacts(chain: string, token: SwapToken): AssetFacts {
  const id = registryChain(chain);
  if (token.native)
    return {
      chainId: id,
      address: token.address,
      symbol: token.symbol,
      native: true,
      level: "CANONICAL",
      risk: [],
    };
  const known = knownAsset(id, token.address, false);
  const risk = new Set<RiskFlag>(known?.risk ?? textRisk(token.symbol, ""));
  if (!known || (known.level !== "CANONICAL" && known.level !== "CURATED")) {
    const twin = registryFor(id).find(
      (a) =>
        (a.level === "CANONICAL" || a.level === "CURATED") &&
        a.symbol.toUpperCase() === token.symbol.toUpperCase() &&
        !same(a.address, token.address),
    );
    if (twin) risk.add("SYMBOL_IMPERSONATION");
  }
  return {
    chainId: id,
    address: token.address,
    symbol: token.symbol,
    native: false,
    level: known?.level,
    risk: [...risk],
  };
}

export function swapGateFacts(
  intent: SwapIntent,
  quote?: SwapQuote,
): SwapFacts {
  return {
    kind: "swap",
    chainId: registryChain(intent.chain),
    ecosystem: intent.ecosystem,
    sender: intent.taker,
    recipient: intent.recipient,
    pay: swapAssetFacts(intent.chain, intent.tokenIn),
    receive: swapAssetFacts(intent.chain, intent.tokenOut),
    quote: quote && {
      provider: quote.provider,
      priceImpactBps: quote.priceImpactBps,
      slippageBps: quote.slippageBps,
      hops: quote.hops,
      splitCount: quote.splitCount,
      amountOut: quote.amountOut.toString(),
      minAmountOut: quote.minAmountOut.toString(),
      inputUsdMicros: quote.inputUsdMicros?.toString() ?? null,
      outputUsdMicros: quote.outputUsdMicros?.toString() ?? null,
      quotedAt: quote.quotedAt,
      expiresAt: quote.expiresAt,
      platformFee:
        quote.costs.find((c) => c.kind === "PLATFORM")?.amount?.toString() ??
        "0",
    },
    known: [intent.taker],
  };
}

export class GuardianBlocked extends Error {
  constructor(readonly verdict: Verdict) {
    super("GUARDIAN_BLOCKED");
  }
}
/** Throws GuardianBlocked when Guardian's verdict is BLOCK; otherwise returns the verdict. */
export function gateSwap(
  intent: SwapIntent,
  quote?: SwapQuote,
  now = Date.now(),
): Verdict {
  const verdict = review(swapGateFacts(intent, quote), now);
  if (verdict.level === "BLOCK") throw new GuardianBlocked(verdict);
  return verdict;
}
