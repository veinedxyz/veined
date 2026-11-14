"use client";
import { QuoteEconomicsNotice } from "./quote-economics";
import { routingEconomics, sameReviewedAsset } from "../quotes/adapters";
// Guardian on VEINED's own surfaces: the Bridge route review (side column and review dialog) and the Portfolio sweep.
// Code-split from the shell; both read only state the surface already holds plus the public asset registry
// (evidence levels). The Bridge verdict is reported to the shell, which gates the route review on it.
import { useEffect, useState } from "react";
import { registryList } from "../assets/client";
import type { AssetLevel, RiskFlag } from "../assets/model";
import type { Holding } from "../portfolio/model";
import type { Asset, Network } from "../routing/model";
import type { AssetFacts, Level } from "../guardian/model";
import { review } from "../guardian/verdict";
import type { MultichainRouteState } from "./multichain-bridge";
import { GuardianPanel } from "./guardian-panel";
import { publishGuardianFacts } from "./guardian-context";
import { useI18n } from "../i18n/provider";
import { formatTokenAmount } from "../i18n/amounts";

const key = (chain: string, address: string) =>
  `${chain}:${/^0x[0-9a-f]{40}$/i.test(address) ? address.toLowerCase() : address}`;
type Evidence = ReadonlyMap<
  string,
  { level: AssetLevel; risk: RiskFlag[]; coingeckoId?: string }
>;
function useEvidence(chains: string[]) {
  const [evidence, setEvidence] = useState<Evidence>(new Map());
  const id = chains.join(",");
  useEffect(() => {
    let active = true;
    Promise.all(
      id
        .split(",")
        .map(async (chain) =>
          (await registryList(chain)).map(
            (a) =>
              [
                key(chain, a.address),
                { level: a.level, risk: a.risk, coingeckoId: a.coingeckoId },
              ] as const,
          ),
        ),
    )
      .then((rows) => {
        if (active) setEvidence(new Map(rows.flat()));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id]);
  return evidence;
}
function facts(a: Asset, network: Network, evidence: Evidence): AssetFacts {
  const native =
    key(network.id, a.address) === key(network.id, network.nativeAsset.address);
  const e = evidence.get(key(network.id, a.address));
  return {
    chainId: network.id,
    address: a.address,
    symbol: a.symbol,
    native,
    level: native ? "CANONICAL" : e?.level,
    risk: native ? [] : (e?.risk ?? []),
  };
}

// VEINED's own markers on every read-only route (writes disabled; balance, allowance and signature count not
// verified) and the warnings Guardian reviews with its own rules (destination signature, price impact) are not notes
// from the route source.
const OWN_ROUTE_MARKERS: ReadonlySet<string> = new Set([
  "WRITE_DISABLED",
  "BALANCE_AND_ALLOWANCE_UNVERIFIED",
  "SIGNATURE_COUNT_UNVERIFIED",
  "DESTINATION_SIGNATURE_REQUIRED",
  "HIGH_PRICE_IMPACT",
]);
/** The Bridge verdict as the shell gates on it: bound to the exact quote it was derived from. */
export interface BridgeGuardianState {
  quoteId: string;
  level: Level;
  digest: string;
}

export function GuardianBridge({
  route,
  source,
  destination,
  account,
  compact = true,
  testId = "guardian-bridge",
  onVerdict,
}: {
  route: MultichainRouteState;
  source: Network;
  destination: Network;
  account: string;
  compact?: boolean;
  testId?: string;
  onVerdict?: (state: BridgeGuardianState | null) => void;
}) {
  const evidence = useEvidence([...new Set([source.id, destination.id])]);
  const q = route.quote;
  const usd = (v: string | undefined) =>
    v && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null;
  const verdict = q
    ? review({
        kind: "bridge",
        sourceChain: source.id,
        destinationChain: destination.id,
        sender: q.input.sourceAddress,
        recipient: q.input.destinationAddress,
        pay: facts(route.from, source, evidence),
        receive: facts(route.to, destination, evidence),
        route: {
          steps: q.steps.map((s) => ({
            tool: s.tool,
            catalogBound: s.catalogBound,
            destinationSignature: s.destinationSignature,
          })),
          durationSeconds: q.duration,
          priceImpact: q.priceImpact,
          warnings: q.warnings.filter((w) => !OWN_ROUTE_MARKERS.has(w)).length,
          valid: route.valid,
          inputUsd: null,
          outputUsd: usd(q.outputUsd),
          // G13 (VBA-P1-02): the fees taken out of the amount, as the route source priced them; one unpriced line
          // makes the sum unknown (Guardian then keeps its accepted price-impact finding). A zero line costs nothing.
          costUsd: q.fees
            .filter((f) => f.included)
            .reduce<number | null>((sum, f) => {
              const v = /^0+$/.test(f.amount) ? 0 : usd(f.usd);
              return sum === null || v === null ? null : sum + v;
            }, 0),
        },
        known: [account, q.input.sourceAddress].filter(Boolean),
      })
    : null;
  const { lang } = useI18n();
  const quoteId = q?.id,
    level = verdict?.level,
    digest = verdict?.digest;
  // The side panel (the one that reports to the shell) also tells the Guardian assistant what this route shows.
  const assistantContext =
    onVerdict && q && verdict
      ? JSON.stringify({
          source: source.name,
          destination: destination.name,
          pay: route.from.symbol,
          receive: route.to.symbol,
          quote: {
            receive: `${formatTokenAmount(BigInt(q.expected), route.to.decimals, lang, 6)} ${route.to.symbol}`,
            seconds: Number.isFinite(q.duration) ? Math.ceil(q.duration) : null,
            valid: route.valid,
          },
          verdict,
        })
      : "";
  useEffect(() => {
    if (onVerdict)
      publishGuardianFacts(
        "bridge",
        assistantContext ? JSON.parse(assistantContext) : undefined,
      );
  }, [onVerdict, assistantContext]);
  useEffect(
    () => () => {
      if (onVerdict) publishGuardianFacts("bridge", undefined);
    },
    [onVerdict],
  );
  useEffect(() => {
    onVerdict?.(quoteId && level && digest ? { quoteId, level, digest } : null);
  }, [onVerdict, quoteId, level, digest]);
  // Unmounted (no quote, another pair): the shell must not keep gating on a verdict for a quote that is gone.
  useEffect(() => () => onVerdict?.(null), [onVerdict]);
  if (!verdict || !q) return null;
  // G12 H03: what the quote's own numbers imply (estimate above the amount sent, costs out of proportion). "Same asset"
  // needs registry evidence on both sides and the same identity (sameReviewedAsset): never a symbol alone. While the
  // registry evidence is loading or unavailable the answer is "not the same", so no surplus is claimed.
  const side = (asset: Asset, network: Network) => {
    const f = facts(asset, network, evidence);
    return {
      chainId: network.id,
      symbol: asset.symbol,
      decimals: asset.decimals,
      native: f.native,
      level: f.level,
      risk: f.risk,
      coingeckoId: evidence.get(key(network.id, asset.address))?.coingeckoId,
    };
  };
  const sameAsset = sameReviewedAsset(
    side(route.from, source),
    side(route.to, destination),
  );
  return (
    <>
      <GuardianPanel verdict={verdict} compact={compact} testId={testId} />
      <QuoteEconomicsNotice
        economics={routingEconomics(q, route.from, route.to, sameAsset)}
        testId={onVerdict ? "quote-economics" : "quote-economics-review"}
      />
    </>
  );
}

export function GuardianSweep({ holdings }: { holdings: readonly Holding[] }) {
  if (!holdings.length) return null;
  const verdict = review({
    kind: "portfolio",
    holdings: holdings.map((h) => ({
      chainId: h.chainId,
      address: h.address,
      symbol: h.symbol,
      spam: h.spam,
      suspicious: h.suspicious,
      metadataVerified: h.metadataVerified,
      routable: h.routable,
      usd: h.usd,
    })),
  });
  return (
    <GuardianPanel verdict={verdict} compact testId="guardian-portfolio" />
  );
}
