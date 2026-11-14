"use client";
import { PercentButtons } from "./percent-buttons";
import {
  normalizeAmountInput,
  ambiguousAmountReadings,
  formatTokenAmount,
  formatFiat,
  formatPercent,
  formatUsd,
} from "../i18n/amounts";
import { useI18n } from "../i18n/provider";
import type { Locale } from "../i18n/config";

import {
  publicToolLabel,
  publicFeeLabel,
  publicStepKindLabel,
} from "../content/public-labels";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { parseUnits } from "viem";
import {
  readCatalog,
  readConnections,
  readQuotes,
  routingMessage,
  routingRead,
} from "../routing/client";
import { validAddress } from "../routing/addresses";
import {
  quoteBinding,
  reviewValid,
  RoutingError,
  type Asset,
  type Catalog,
  type Network,
  type QuoteInput,
  type RoutingQuote,
} from "../routing/model";
import { ChainBadge, ChainLogo } from "./multichain-identity";
import { modalProps, openModal } from "./dialog";
import { savePreview } from "../routing/history";
import {
  chainHoldings,
  portfolioStale,
  type PortfolioResult,
  type PortfolioIdentity,
  type Holding,
} from "../portfolio/model";
import { rankRoutes, type RankMode } from "../routing/ranking";
import { assetSchema } from "../routing/catalog";
import { z } from "zod";
import { Icon, type IconName } from "./icons";
import { shortAddress } from "./ui";
import { TokenMark } from "./ocean-marks";
import { cssomFill } from "./virtual";
// Static within this already lazy chunk: the picker opens on the first click without a second network round trip.
import TokenPicker from "./token-picker";
import { registryList } from "../assets/client";
import { isAssetLogoSrc } from "./logo-src";
import { publishGuardianFacts } from "./guardian-context";
import { sameCatalogContent } from "../quotes/catalog-content";
import { ExecutionReview } from "./execution-review";
const QUOTE_WINDOW = 30000;
/** V1.11: the Bridge side panels (route summary / route health) read this lifted state. */
export interface MultichainRouteState {
  from: Asset;
  to: Asset;
  quote?: RoutingQuote;
  valid: boolean;
  connection: "loading" | "available" | "none" | "unknown";
  checkedAt: number | null;
  blocked: string;
}
export default function MultichainBridge({
  source,
  destination,
  catalog,
  onCatalog,
  account,
  walletRevision,
  walletChain,
  lang,
  mode = "bridge",
  portfolio,
  portfolioIdentity,
  prefillToken,
  guardianDraft,
  cardHeader,
  onRouteState,
  guardian,
  guardianReview,
}: {
  source: Network;
  destination: Network;
  catalog?: Catalog;
  onCatalog: (c: Catalog) => void;
  account: string;
  walletRevision: number;
  walletChain?: number;
  lang: Locale;
  mode?: "bridge" | "swap";
  portfolio?: PortfolioResult;
  /** The addresses the portfolio scan was read for (G12 H04: a balance is used only for the sender it was read for). */
  portfolioIdentity?: PortfolioIdentity;
  prefillToken?: Holding;
  /** A Guardian chat draft: initial tokens and amount only. Each token stays selected only when the route list
   * supports its exact address (otherwise the native asset), exactly like a prefilled token. Quoting stays manual. */
  guardianDraft?: { from: Asset; to: Asset; amount: string };
  /** Swap only: rendered at the top of the swap card (title and network selector). */
  cardHeader?: ReactNode;
  onRouteState?: (state: MultichainRouteState) => void;
  /** Guardian's verdict on the current quote (bound to the quote id); the route review is gated on it. */
  guardian?: { quoteId: string; level: string } | null;
  /** Guardian's full review of the current quote, shown inside the route review. */
  guardianReview?: ReactNode;
}) {
  const { t } = useI18n();
  const [assetLogos, setAssetLogos] = useState<Record<string, string>>({});
  const logoKey = (chain: string, address: string) =>
    `${chain}:${/^0x[0-9a-f]{40}$/i.test(address) ? address.toLowerCase() : address}`;
  useEffect(() => {
    let active = true;
    Promise.all(
      [...new Set([source.id, destination.id])].map(async (chain) => {
        const assets = await registryList(chain);
        return assets
          .filter((a) => a.logoUrl && isAssetLogoSrc(a.logoUrl))
          .map((a) => [logoKey(chain, a.address), a.logoUrl!] as const);
      }),
    )
      .then((rows) => {
        if (active) setAssetLogos(Object.fromEntries(rows.flat()));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [source.id, destination.id]);
  // Same-ecosystem routes default the recipient to the sender ("Same wallet"); a different address is an explicit
  // choice. Cross-ecosystem bridges need an address of the destination ecosystem, so the field is always shown.
  const sameEcosystem = source.ecosystem === destination.ecosystem;
  const [sender, setSender] = useState(
      source.ecosystem === "EVM" ? account : "",
    ),
    [customRecipient, setCustomRecipient] = useState(!sameEcosystem),
    [recipientInput, setRecipientInput] = useState(""),
    [amount, setAmount] = useState(guardianDraft?.amount ?? ""),
    [sourceAssets, setSourceAssets] = useState<Asset[]>(() => {
      const first = prefillToken ?? guardianDraft?.from;
      return first &&
        first.address.toLowerCase() !== source.nativeAsset.address.toLowerCase()
        ? [first, source.nativeAsset]
        : [first ?? source.nativeAsset];
    }),
    [destinationAssets, setDestinationAssets] = useState<Asset[]>(() =>
      guardianDraft &&
      guardianDraft.to.address.toLowerCase() !==
        destination.nativeAsset.address.toLowerCase()
        ? [destination.nativeAsset, guardianDraft.to]
        : [destination.nativeAsset],
    ),
    [sourceToken, setSourceToken] = useState(
      prefillToken?.address ??
        guardianDraft?.from.address ??
        source.nativeAsset.address,
    ),
    [destinationToken, setDestinationToken] = useState(
      guardianDraft?.to.address ?? destination.nativeAsset.address,
    ),
    [picker, setPicker] = useState<"source" | "destination">(),
    [slippage, setSlippage] = useState(0.005),
    [preference, setPreference] = useState<"receive" | "time">("receive"),
    [quote, setQuote] = useState<RoutingQuote>(),
    [alternatives, setAlternatives] = useState<RoutingQuote[]>([]),
    [rankMode, setRankMode] = useState<RankMode>("value"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [connectionState, setConnectionState] =
      useState<MultichainRouteState["connection"]>("loading"),
    [now, setNow] = useState(() => Date.now()),
    [revision, setRevision] = useState(0),
    [walletBusy, setWalletBusy] = useState(false),
    [nativeWalletAddress, setNativeWalletAddress] = useState(""),
    [saved, setSaved] = useState(false);
  const recipient = customRecipient ? recipientInput : sender;
  const sequence = useRef(0),
    pending = useRef<AbortController | null>(null),
    dialog = useRef<HTMLDialogElement>(null),
    pickerTrigger = useRef<HTMLButtonElement | null>(null),
    walletLock = useRef(false),
    previousWallet = useRef({
      account,
      walletRevision,
      walletChain,
      ecosystem: source.ecosystem,
    });
  // Exact identity: EVM addresses compare case-insensitively, other ecosystems exactly.
  const same = (a: string, b: string) =>
    /^0x[0-9a-fA-F]{40}$/.test(a)
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  const from =
      sourceAssets.find((a) => same(a.address, sourceToken)) ??
      source.nativeAsset,
    to =
      destinationAssets.find((a) => same(a.address, destinationToken)) ??
      destination.nativeAsset;
  let baseAmount = "";
  try {
    baseAmount = parseUnits(
      normalizeAmountInput(amount, lang, from.decimals),
      from.decimals,
    ).toString();
  } catch {}
  const input: QuoteInput = {
    source: source.id,
    destination: destination.id,
    sourceAsset: sourceToken,
    destinationAsset: destinationToken,
    amount: baseAmount,
    sourceAddress: sender,
    destinationAddress: recipient,
    generation: catalog?.generation ?? "",
    slippage,
    preference,
    walletRevision: revision,
    mode,
    portfolioRevision: portfolio?.revision,
  };
  const binding = quoteBinding(input),
    currentBinding = useRef(binding);
  const valid = !!quote && !!catalog && reviewValid(quote, input, catalog, now);
  // Guardian is the shared security layer: a route can be reviewed or saved only after Guardian has read this exact
  // quote, and never when its verdict is BLOCK (fail closed while the verdict is still loading).
  const guardianRead = !!quote && guardian?.quoteId === quote.id;
  const guardianBlocked = guardianRead && guardian?.level === "BLOCK";
  const reviewable = valid && guardianRead && !guardianBlocked;
  const cancelPending = useCallback(() => {
    sequence.current++;
    pending.current?.abort();
  }, []);
  // Mainnet ⇄ testnet is never a silent financial route.
  const pairReason =
    source.id === destination.id && mode !== "swap"
      ? "SAME_CHAIN_DISABLED"
      : source.provider === "otherbridge-onebridge" ||
          destination.provider === "otherbridge-onebridge"
        ? "CUSTOM_ROUTE_NOT_EXECUTABLE_G5"
        : source.mainnet !== destination.mainnet
          ? "CROSS_ENVIRONMENT_ROUTE_DISABLED"
          : !source.mainnet || !destination.mainnet
            ? "TESTNET_ROUTING_DISABLED"
            : "";
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);
  useEffect(() => {
    currentBinding.current = binding;
    sequence.current++;
    pending.current?.abort();
    dialog.current?.close();
    const timer = setTimeout(() => {
      setQuote(undefined);
      setAlternatives([]);
      setSaved(false);
      setBusy(false);
    }, 0);
    return () => clearTimeout(timer);
  }, [binding]);
  // G13 (VBA-P1-03): the generation of an identical catalog just adopted, for the one automatic re-read below.
  const catalogRetry = useRef<string | null>(null);
  useEffect(() => {
    onRouteState?.({
      from,
      to,
      quote,
      valid,
      connection: connectionState,
      checkedAt: quote?.observedAt ?? null,
      blocked: pairReason,
    });
    // `from`/`to` are derived from the token ids and asset lists below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    onRouteState,
    sourceToken,
    destinationToken,
    sourceAssets,
    destinationAssets,
    quote,
    valid,
    connectionState,
    pairReason,
  ]);
  // gf1 G04: the Guardian assistant reads the route this form shows before any quote (network names and symbols).
  const routeContext =
    mode === "bridge"
      ? JSON.stringify({
          source: source.name,
          destination: destination.name,
          pay: from.symbol,
          receive: to.symbol,
          // The form refuses this pair (same chain, testnet or mixed environments): no quote can come.
          unavailable: !!pairReason,
        })
      : "";
  useEffect(() => {
    publishGuardianFacts(
      "bridgeRoute",
      routeContext ? JSON.parse(routeContext) : undefined,
    );
  }, [routeContext]);
  useEffect(() => () => publishGuardianFacts("bridgeRoute", undefined), []);
  useEffect(() => {
    const previous = previousWallet.current;
    previousWallet.current = {
      account,
      walletRevision,
      walletChain,
      ecosystem: source.ecosystem,
    };
    if (
      previous.account === account &&
      previous.walletRevision === walletRevision &&
      previous.walletChain === walletChain &&
      previous.ecosystem === source.ecosystem
    )
      return;
    sequence.current++;
    pending.current?.abort();
    dialog.current?.close();
    const timer = setTimeout(() => {
      setRevision((v) => v + 1);
      if (source.ecosystem === "EVM") setSender(account);
    }, 0);
    return () => clearTimeout(timer);
  }, [account, source.ecosystem, walletRevision, walletChain, mode]);
  useEffect(() => {
    const c = new AbortController();
    if (pairReason) return () => c.abort();
    (async () => {
      const current = catalog ?? (await readCatalog(c.signal));
      if (c.signal.aborted) return;
      if (!catalog) onCatalog(current);
      if (current.stale) {
        setConnectionState("unknown");
        return;
      }
      const connections =
        mode === "swap"
          ? [
              {
                sourceAssets: z
                  .array(assetSchema)
                  .parse(
                    await routingRead(
                      { action: "assets", chain: source.id },
                      c.signal,
                    ),
                  ),
                destinationAssets: [] as Asset[],
              },
            ]
          : await readConnections(source, destination, c.signal);
      if (mode === "swap")
        connections[0].destinationAssets = connections[0].sourceAssets;
      if (c.signal.aborted) return;
      // EVM addresses are case-insensitive: a held lowercase address and a checksummed catalog
      // address are the same token and must appear once.
      const unique = (a: Asset[]) => [
        ...new Map(
          a.map((x) => [
            /^0x[0-9a-fA-F]{40}$/.test(x.address)
              ? x.address.toLowerCase()
              : x.address,
            x,
          ]),
        ).values(),
      ];
      const routeSource = unique(connections.flatMap((x) => x.sourceAssets));
      const routed = new Set(
        routeSource.map((a) =>
          /^0x/.test(a.address) ? a.address.toLowerCase() : a.address,
        ),
      );
      const nextSource = unique([
        source.nativeAsset,
        // A prefilled/held token is selectable only when the route list supports it (exact address).
        ...(prefillToken && routed.has(prefillToken.address.toLowerCase())
          ? [prefillToken]
          : []),
        ...(guardianDraft &&
        routed.has(guardianDraft.from.address.toLowerCase())
          ? [guardianDraft.from]
          : []),
        ...chainHoldings(portfolio, source.id).filter(
          (h) =>
            !h.suspicious &&
            h.metadataVerified !== false &&
            routed.has(h.address.toLowerCase()),
        ),
        ...routeSource,
      ]);
      const nextDestination = unique([
        destination.nativeAsset,
        ...connections.flatMap((x) => x.destinationAssets),
      ]);
      setSourceAssets(nextSource);
      setDestinationAssets(nextDestination);
      // A selection that is not in the route list (e.g. an unsupported prefill) falls back to the native asset,
      // so the quote input never pairs one token's address with another token's decimals.
      setSourceToken((current) =>
        nextSource.some((a) => same(a.address, current))
          ? nextSource.find((a) => same(a.address, current))!.address
          : source.nativeAsset.address,
      );
      setDestinationToken((current) =>
        nextDestination.some((a) => same(a.address, current))
          ? nextDestination.find((a) => same(a.address, current))!.address
          : destination.nativeAsset.address,
      );
      setConnectionState(connections.length ? "available" : "none");
    })().catch((e) => {
      if (!c.signal.aborted) {
        setConnectionState("unknown");
        setError(e instanceof RoutingError ? e.code : "PROVIDER_UNAVAILABLE");
      }
    });
    return () => {
      c.abort();
      cancelPending();
    };
  }, [
    source,
    destination,
    catalog,
    onCatalog,
    pairReason,
    cancelPending,
    mode,
    portfolio,
    prefillToken,
    guardianDraft,
  ]);
  useEffect(() => {
    if (!valid) dialog.current?.close();
  }, [valid]);
  useEffect(() => {
    if (!nativeWalletAddress) return;
    let cancelled = false,
      checking = false;
    const interval = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const { readNativeIdentity, boundedWalletRead } =
          await import("../routing/wallet-read");
        const current = await boundedWalletRead(readNativeIdentity(source));
        if (!cancelled && current !== nativeWalletAddress) {
          cancelPending();
          setSender("");
          setNativeWalletAddress("");
          setRevision((v) => v + 1);
        }
      } catch {
        if (!cancelled) {
          cancelPending();
          setSender("");
          setNativeWalletAddress("");
          setRevision((v) => v + 1);
        }
      } finally {
        checking = false;
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [source, nativeWalletAddress, cancelPending]);
  // G13 (VBA-P1-03): the route source refills its network catalog every five minutes and names each refill with a
  // new generation even when nothing in it changed, so a page left open was refused with CATALOG_CHANGED on every
  // later read. On that refusal the current catalog is read once (read-only): identical networks and tools -> it is
  // adopted and the route is read again exactly once; different content -> it is adopted and the accepted message
  // asks the user to check the selection and read again. Nothing is signed, sent or retried beyond that one read.
  async function requestQuote(auto = false) {
    if (!catalog || catalog.stale || pairReason) return;
    if (
      !validAddress(source.ecosystem, sender, source.key) ||
      !validAddress(destination.ecosystem, recipient, destination.key)
    ) {
      setError("INVALID_ADDRESS");
      return;
    }
    const attempt = ++sequence.current,
      requested = binding,
      c = new AbortController();
    pending.current?.abort();
    pending.current = c;
    setBusy(true);
    setError("");
    setQuote(undefined);
    try {
      const quotes = await readQuotes(input, c.signal);
      if (
        sequence.current === attempt &&
        currentBinding.current === requested &&
        !c.signal.aborted
      ) {
        if (!quotes.length) throw new RoutingError("NO_EXECUTABLE_ROUTE");
        const ranked = rankRoutes(
          quotes,
          rankMode,
          quotes[0]?.observedAt ?? now,
        );
        if (!ranked.length) throw new RoutingError("NO_EXECUTABLE_ROUTE");
        setAlternatives(ranked);
        setQuote(ranked[0]);
        setNow(ranked[0].observedAt);
      }
    } catch (e) {
      const code = e instanceof RoutingError ? e.code : "PROVIDER_UNAVAILABLE";
      if (
        code === "CATALOG_CHANGED" &&
        !auto &&
        sequence.current === attempt &&
        !c.signal.aborted
      ) {
        try {
          const fresh = await readCatalog(c.signal);
          if (
            sequence.current === attempt &&
            !c.signal.aborted &&
            !fresh.stale &&
            fresh.generation !== catalog.generation
          ) {
            if (sameCatalogContent(catalog, fresh))
              catalogRetry.current = fresh.generation;
            else setError("CATALOG_CHANGED");
            onCatalog(fresh);
            return;
          }
        } catch {}
      }
      if (sequence.current === attempt && !c.signal.aborted) setError(code);
    } finally {
      if (sequence.current === attempt) setBusy(false);
    }
  }
  // G13 (VBA-P1-03): the one automatic re-read after an identical catalog was adopted. It runs after the binding
  // effect above (declared earlier), so its timer fires after that effect has cleared the previous quote;
  // requestQuote(true) never starts another recovery.
  useEffect(() => {
    if (!catalogRetry.current || catalogRetry.current !== catalog?.generation)
      return;
    catalogRetry.current = null;
    const timer = setTimeout(() => void requestQuote(true), 0);
    return () => clearTimeout(timer);
    // Runs only when the adopted catalog arrives; requestQuote is this render's (it reads the new generation).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog?.generation]);
  async function nativeConnect() {
    if (walletLock.current) return;
    walletLock.current = true;
    setWalletBusy(true);
    const attemptedSource = source.id,
      revisionAt = sequence.current;
    try {
      const { boundedNativeConnect } = await import("../routing/wallet-read");
      const address = await boundedNativeConnect(source);
      if (attemptedSource === source.id && revisionAt === sequence.current) {
        setSender(address);
        setNativeWalletAddress(address);
        setRevision((v) => v + 1);
        setError("");
      }
    } catch (e) {
      setError(
        e instanceof RoutingError ? e.code : "WALLET_ECOSYSTEM_UNSUPPORTED",
      );
    } finally {
      walletLock.current = false;
      setWalletBusy(false);
    }
  }
  const sumUSD = quote?.fees.every((f) => f.usd !== undefined)
    ? quote.fees.reduce((s, f) => s + Number(f.usd), 0)
    : undefined;
  const amountOf = (value: string, decimals: number) =>
    formatTokenAmount(BigInt(value), decimals, lang, 6);
  // Held balances come from the user's own portfolio scan only (read-only, never a wallet request).
  const heldOf = (asset: Asset, network: Network) =>
    chainHoldings(portfolio, network.id).find(
      (h) => h.address.toLowerCase() === asset.address.toLowerCase(),
    );
  const sourceHeld = heldOf(from, source);
  // G12 H04: the network fee of the route that was read, when it is paid in the source network's native coin and every
  // such line carries an exact amount; otherwise unknown (never estimated here).
  // Every line the route does NOT take out of the amount and charges in the source network's native coin (network
  // gas and any protocol fee alike) has to stay in the wallet; one unreadable line makes the whole reserve unknown.
  const sourceNetworkFee = (() => {
    const lines = (quote?.fees ?? []).filter(
      (f) =>
        !f.included &&
        String(f.asset.chainId) === source.id &&
        same(f.asset.address, source.nativeAsset.address),
    );
    if (
      !lines.some((f) => f.kind === "gas") ||
      lines.some((f) => !/^\d{1,78}$/.test(f.amount))
    )
      return null;
    return lines.reduce((n, f) => n + BigInt(f.amount), 0n);
  })();
  // The scan's own row for this exact asset, a read zero included (chainHoldings hides zeros), and only when its
  // decimals are the ones the amount field parses with.
  const scannedRow = portfolio?.holdings.find(
    (h) =>
      h.chainId === source.id &&
      !h.spam &&
      h.address.toLowerCase() === from.address.toLowerCase(),
  );
  const scannedFor =
    source.ecosystem === "EVM"
      ? portfolioIdentity?.evm
      : source.ecosystem === "SVM"
        ? portfolioIdentity?.solana
        : undefined;
  const scanMatchesSender =
    !!scannedFor &&
    !!sender &&
    (source.ecosystem === "EVM"
      ? scannedFor.toLowerCase() === sender.toLowerCase()
      : scannedFor === sender);
  const sourceUnitUsd =
    sourceHeld && sourceHeld.usd !== null && BigInt(sourceHeld.balance) > 0n
      ? sourceHeld.usd /
        Number(
          formatTokenAmount(
            BigInt(sourceHeld.balance),
            sourceHeld.decimals,
            "en",
          ).replaceAll(",", ""),
        )
      : undefined;
  const typedNumber = baseAmount
    ? Number(
        formatTokenAmount(BigInt(baseAmount), from.decimals, "en").replaceAll(
          ",",
          "",
        ),
      )
    : 0;
  const senderValid =
    !!sender && validAddress(source.ecosystem, sender, source.key);
  const recipientValid =
    !!recipient &&
    validAddress(destination.ecosystem, recipient, destination.key);
  const sameToken =
    mode === "swap" &&
    sourceToken.toLowerCase() === destinationToken.toLowerCase();
  const quoteDisabled =
    busy ||
    !!pairReason ||
    !catalog ||
    catalog.stale ||
    !baseAmount ||
    baseAmount === "0" ||
    !sender ||
    !recipient ||
    sameToken;
  // G13 (VBA-P1-01): an amount refused only because it can be read two ways says so, with both unambiguous spellings.
  const amountReadings = baseAmount
    ? null
    : ambiguousAmountReadings(amount, lang, from.decimals);
  const blocker = !catalog
    ? t("ui.loading")
    : pairReason || catalog.stale
      ? ""
      : amountReadings
        ? t("g13.amount.ambiguous", {
            amount: amount.trim(),
            ...amountReadings,
          })
        : !baseAmount || baseAmount === "0"
          ? t("v110.needAmount")
          : !sender || !recipient
            ? t("v110.needAddresses")
            : sameToken
              ? t("v110.needDifferentTokens")
              : "";
  const quoteSeconds = quote
    ? Math.max(0, Math.ceil((quote.expiresAt - now) / 1000))
    : 0;
  const quoteAge = quote
    ? Math.max(0, Math.floor((now - quote.observedAt) / 1000))
    : 0;
  const walletOnSource =
    !!account &&
    source.ecosystem === "EVM" &&
    String(walletChain) === source.id;
  const walletIsSender =
    !!account &&
    source.ecosystem === "EVM" &&
    sender.toLowerCase() === account.toLowerCase();
  const heldChips =
    mode === "swap"
      ? chainHoldings(portfolio, source.id)
          .filter(
            (h) =>
              !h.suspicious &&
              h.metadataVerified !== false &&
              (h.native || h.routable !== false) &&
              sourceAssets.some(
                (a) => a.address.toLowerCase() === h.address.toLowerCase(),
              ),
          )
          .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
          .slice(0, 4)
      : [];
  // One mark system: the network's logo for its native asset, the reviewed logo, or the generated medallion.
  const tokenMark = (asset: Asset, network: Network, size?: "sm" | "md") => (
    <TokenMark
      symbol={asset.symbol}
      seed={asset.address}
      size={size === "md" ? "md" : "sm"}
      logo={
        asset.address.toLowerCase() ===
        network.nativeAsset.address.toLowerCase()
          ? network.theme.logo
          : (assetLogos[logoKey(network.id, asset.address)] ?? null)
      }
    />
  );
  const tokenButton = (role: "source" | "destination") => {
    const asset = role === "source" ? from : to,
      network = role === "source" ? source : destination;
    return (
      <button
        type="button"
        className="token-button"
        aria-haspopup="dialog"
        aria-labelledby={`${role}-token-label ${role}-token-symbol`}
        disabled={!!pairReason}
        onClick={(event) => {
          pickerTrigger.current = event.currentTarget;
          setPicker(role);
        }}
      >
        <span id={`${role}-token-label`} className="sr-only">
          {role === "source" ? t("ui.sourceToken") : t("ui.destinationToken")}
        </span>
        {tokenMark(asset, network)}
        <span id={`${role}-token-symbol`} className="token-button-symbol">
          {asset.symbol}
        </span>
        <Icon name="chevronDown" size={16} />
      </button>
    );
  };
  const rankLabel = (by: RankMode) =>
    t(
      by === "value"
        ? "v13.bestValue"
        : by === "cost"
          ? "v13.cheapest"
          : "v13.fastest",
    );
  const rankIcon: Record<RankMode, IconName> = {
    value: "spark",
    cost: "gas",
    time: "clock",
  };
  // The full financial review (dialog): every fee, step, approval, address and limit.
  function routeReview() {
    if (!quote) return null;
    return (
      <>
        {quote.warnings.includes("SYNTHETIC_TEST_ONLY") && (
          <p className="notice">{t("ui.syntheticUITestQuoteNotLive")}</p>
        )}
        <div className="route-identity">
          <ChainBadge network={source} />
          <Icon name="arrowRight" size={14} className="route-arrow" />
          <ChainBadge network={destination} />
        </div>
        <div className="review-amounts">
          <div>
            <span className="micro">{t("ui.sourceAsset")}</span>
            <strong>
              <bdi dir="ltr">
                {amountOf(quote.input.amount, from.decimals)} {from.symbol}
              </bdi>
            </strong>
          </div>
          <Icon name="arrowRight" size={16} className="flip-rtl" />
          <div>
            <span className="micro">{t("ui.destinationAsset")}</span>
            <strong>
              <bdi dir="ltr">
                {amountOf(quote.expected, to.decimals)} {to.symbol}
              </bdi>
            </strong>
          </div>
        </div>
        <dl className="quote-summary">
          <div>
            <dt>{t("v110.minimumReceived")}</dt>
            <dd>
              {amountOf(quote.minimum, to.decimals)} {to.symbol}
            </dd>
          </div>
          <div>
            <dt>{t("ui.totalEstimatedCost")}</dt>
            <dd>
              {sumUSD === undefined
                ? t("ui.usdTotalUnknown")
                : formatFiat(sumUSD, lang)}
            </dd>
          </div>
        </dl>
        <p className="compact-review-recipient">
          <span>{t("v111.recipient")}</span>
          <code dir="ltr" title={recipient}>
            {customRecipient ? recipient : shortAddress(recipient)}
          </code>
        </p>
        {quote.warnings.includes("HIGH_PRICE_IMPACT") && (
          <p className="notice tone-danger">{t("ui.highPriceImpact")}</p>
        )}
        <details className="disclosure review-full-details">
          <summary>
            {t("v111.routeDetails")} · {t("v110.feeBreakdown")}
          </summary>
          <div className="disclosure-body">
            <dl className="routing-summary">
              <div>
                <dt>{t("v13.platformFee")}</dt>
                <dd>
                  {formatPercent(0, lang)} ·{" "}
                  {formatTokenAmount(0n, from.decimals, lang)} {from.symbol}
                </dd>
              </div>
              <div>
                <dt>{t("ui.slippage")}</dt>
                <dd>{formatPercent(input.slippage, lang)}</dd>
              </div>
              <div>
                <dt>{t("v13.observed")}</dt>
                <dd>
                  {new Intl.DateTimeFormat(lang, {
                    timeStyle: "medium",
                  }).format(quote.observedAt)}
                </dd>
              </div>
              <div>
                <dt>{t("v13.expires")}</dt>
                <dd>
                  {new Intl.DateTimeFormat(lang, {
                    timeStyle: "medium",
                  }).format(quote.expiresAt)}
                </dd>
              </div>
              <div>
                <dt>{t("v13.destinationGas")}</dt>
                <dd>{t("ui.unknown")}</dd>
              </div>
              <div>
                <dt>{t("ui.expectedMinimum")}</dt>
                <dd>
                  <bdi dir="ltr" className="expected-amounts">
                    {formatTokenAmount(
                      BigInt(quote.expected),
                      to.decimals,
                      lang,
                    )}{" "}
                    /{" "}
                    {formatTokenAmount(
                      BigInt(quote.minimum),
                      to.decimals,
                      lang,
                    )}{" "}
                    {to.symbol}
                  </bdi>
                </dd>
              </div>
              <div>
                <dt>{t("ui.estimatedTime")}</dt>
                <dd>
                  {t("ui.seconds", {
                    count: new Intl.NumberFormat(lang).format(
                      Math.ceil(quote.duration),
                    ),
                  })}
                </dd>
              </div>
              <div>
                <dt>{t("ui.priceImpactIncludingCosts")}</dt>
                <dd>
                  {quote.priceImpact === null
                    ? t("ui.unknown")
                    : formatPercent(quote.priceImpact, lang)}
                </dd>
              </div>
              <div>
                <dt>{t("ui.totalEstimatedCost")}</dt>
                <dd>
                  {sumUSD === undefined
                    ? t("ui.usdTotalUnknown")
                    : formatFiat(sumUSD, lang)}
                </dd>
              </div>
              <div>
                <dt>{t("ui.estimatedApprovals")}</dt>
                <dd>{quote.requirements.approvals}</dd>
              </div>
              <div>
                <dt>{t("ui.signaturesChainSwitches")}</dt>
                <dd>{t("ui.exactCountUnverified")}</dd>
              </div>
              <div>
                <dt>{t("ui.destinationSignature")}</dt>
                <dd>
                  {quote.requirements.destinationSignature
                    ? t("ui.required")
                    : t("ui.notReported")}
                </dd>
              </div>
            </dl>
            <p className="micro review-label">
              {t("ui.sourceAndDestinationAddresses")}
            </p>
            <div className="review-addresses">
              <code className="native-address">{sender}</code>
              <code className="native-address">{recipient}</code>
            </div>
            {customRecipient && sameEcosystem && (
              <p className="notice tone-warn">{t("v111.recipientDiffers")}</p>
            )}
            <ol className="routing-steps">
              {quote.steps.map((s) => (
                <li key={s.id}>
                  <strong>{publicToolLabel(s.toolName, lang)}</strong>
                  <span>
                    {s.sourceAsset.symbol} → {s.destinationAsset.symbol} ·{" "}
                    {publicStepKindLabel(s.type, lang)}
                  </span>
                  {s.approvalAddress && (
                    <small>
                      {t("ui.approvalContract")}:{" "}
                      <code>{s.approvalAddress}</code>
                      <span>
                        {t("v13.approvalAmount")}:{" "}
                        <bdi dir="ltr">
                          {formatTokenAmount(
                            BigInt(s.amount),
                            s.sourceAsset.decimals,
                            lang,
                          )}{" "}
                          {s.sourceAsset.symbol}
                        </bdi>
                      </span>
                    </small>
                  )}
                </li>
              ))}
            </ol>
            <ul className="routing-costs">
              {quote.fees.map((f, i) => (
                <li key={i}>
                  <span>
                    {publicFeeLabel(f.name, lang, f.kind)} ·{" "}
                    {t(`kinds.${f.kind}`)}{" "}
                    {f.included ? t("ui.includedInOutput") : ""}
                  </span>
                  <span>
                    {formatTokenAmount(
                      BigInt(f.amount),
                      f.asset.decimals,
                      lang,
                    )}{" "}
                    {f.asset.symbol}
                  </span>
                </li>
              ))}
            </ul>
            <p className="notice">
              {t("ui.balanceGasSufficiencyAndAllowanceAre")}
            </p>
            {quote.warnings.includes("HIGH_PRICE_IMPACT") && (
              <p className="notice tone-danger">{t("ui.highPriceImpact")}</p>
            )}
            <p className="input-hint">{t("ui.thisIsA30SecondRead")}</p>
            <p className="input-hint">{t("v13.quoteBound")}</p>
          </div>
        </details>
      </>
    );
  }
  // V1.11 primary summary: rate, you receive, route/network fee, gas, price impact, quote age. Everything else
  // (steps, protocols, minimum, execution checks) is behind "Route details".
  const gasFees = quote?.fees.filter((f) => f.kind === "gas") ?? [];
  const routeFees = quote?.fees.filter((f) => f.kind !== "gas") ?? [];
  const feeText = (fees: RoutingQuote["fees"]) =>
    fees.length
      ? fees.every((f) => f.usd !== undefined)
        ? formatFiat(
            fees.reduce((s, f) => s + Number(f.usd), 0),
            lang,
          )
        : fees
            .map(
              (f) =>
                `${formatTokenAmount(BigInt(f.amount), f.asset.decimals, lang, 6)} ${f.asset.symbol}`,
            )
            .join(" + ")
      : formatFiat(0, lang);
  const fullQuoteFacts = () =>
    quote && (
      <dl className="quote-summary">
        <div>
          <dt>{t("v110.rate")}</dt>
          <dd>
            <bdi dir="ltr">
              {typedNumber > 0
                ? `1 ${from.symbol} ≈ ${new Intl.NumberFormat(lang, {
                    maximumSignificantDigits: 6,
                  }).format(
                    Number(
                      formatTokenAmount(
                        BigInt(quote.expected),
                        to.decimals,
                        "en",
                      ).replaceAll(",", ""),
                    ) / typedNumber,
                  )} ${to.symbol}`
                : "—"}
            </bdi>
          </dd>
        </div>
        <div className="is-total">
          <dt>{t("v111.youReceive")}</dt>
          <dd>
            <bdi dir="ltr">
              {amountOf(quote.expected, to.decimals)} {to.symbol}
            </bdi>
          </dd>
        </div>
        <div className="fee-line">
          <dt>
            <Icon name="layers" size={14} />
            {t("v111.routeFee")}
          </dt>
          <dd>
            <bdi dir="ltr">{feeText(routeFees)}</bdi>
          </dd>
        </div>
        <div className="fee-line">
          <dt>
            <Icon name="gas" size={14} />
            {t("product.gas")}
          </dt>
          <dd>
            <bdi dir="ltr">{feeText(gasFees)}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t("v111.priceImpact")}</dt>
          <dd
            className={
              quote.warnings.includes("HIGH_PRICE_IMPACT") ? "amber" : undefined
            }
          >
            {quote.priceImpact === null
              ? t("ui.unknown")
              : formatPercent(quote.priceImpact, lang)}
          </dd>
        </div>
        <div>
          <dt>{t("v111.quoteAge")}</dt>
          <dd>
            {t("ui.seconds", {
              count: new Intl.NumberFormat(lang).format(quoteAge),
            })}
          </dd>
        </div>
      </dl>
    );
  const quoteFacts = () =>
    quote && (
      <dl className="quote-summary compact-quote">
        <div>
          <dt>{t("ui.totalEstimatedCost")}</dt>
          <dd>{feeText(quote.fees)}</dd>
        </div>
        <div>
          <dt>{t("v110.minimumReceived")}</dt>
          <dd>
            {amountOf(quote.minimum, to.decimals)} {to.symbol}
          </dd>
        </div>
        {quote.warnings.includes("HIGH_PRICE_IMPACT") && (
          <div>
            <dt>{t("v111.priceImpact")}</dt>
            <dd className="amber">
              {quote.priceImpact === null
                ? t("ui.unknown")
                : formatPercent(quote.priceImpact, lang)}
            </dd>
          </div>
        )}
      </dl>
    );
  const freshness = () =>
    quote && (
      <div className={`freshness ${valid ? "is-fresh" : "is-expired"}`}>
        <span className="freshness-text">
          <Icon name="clock" size={14} />
          {valid
            ? t("v110.freshFor", {
                count: new Intl.NumberFormat(lang).format(quoteSeconds),
              })
            : t("ui.quoteExpired")}
        </span>
        {valid && (
          <button
            className="small quote-refresh"
            disabled={busy || quoteDisabled}
            onClick={() => void requestQuote()}
          >
            <Icon name="refresh" size={13} />
            {t("v112.refreshQuote")}
          </button>
        )}
        <span className="freshness-bar" aria-hidden="true">
          <span
            ref={cssomFill(valid ? (quote.expiresAt - now) / QUOTE_WINDOW : 0)}
          />
        </span>
      </div>
    );
  const routeChoices = () =>
    quote && (
      <div className="route-choices">
        <div
          className="route-alternatives segmented"
          role="group"
          aria-label={t("v110.routeOptions")}
        >
          {(["value", "cost", "time"] as const).map((by) => (
            <button
              key={by}
              aria-pressed={rankMode === by}
              onClick={() => {
                dialog.current?.close();
                setSaved(false);
                setRankMode(by);
                setQuote(rankRoutes(alternatives, by, now)[0]);
              }}
            >
              {rankLabel(by)}
            </button>
          ))}
        </div>
        <p className="why-route">
          <Icon name={rankIcon[rankMode]} size={15} />
          <span>
            <strong>{t("v110.whyRoute")}</strong>{" "}
            {t(
              rankMode === "value"
                ? "v110.whyValue"
                : rankMode === "cost"
                  ? "v110.whyCost"
                  : "v110.whyTime",
            )}
          </span>
        </p>
        {alternatives.length > 1 && (
          <ul className="route-list">
            {rankRoutes(alternatives, rankMode, now).map((q, i) => (
              <li key={q.id}>
                <button
                  className={`route-option${q.id === quote.id ? " is-selected" : ""}`}
                  aria-pressed={q.id === quote.id}
                  onClick={() => {
                    dialog.current?.close();
                    setSaved(false);
                    setQuote(q);
                  }}
                >
                  <span className="route-option-main">
                    <strong>
                      {q.steps
                        .map((s) => publicToolLabel(s.toolName, lang))
                        .join(" → ")}
                    </strong>
                    <small>
                      {t("ui.seconds", {
                        count: new Intl.NumberFormat(lang).format(
                          Math.ceil(q.duration),
                        ),
                      })}
                      {i === 0 ? ` · ${rankLabel(rankMode)}` : ""}
                    </small>
                  </span>
                  <bdi dir="ltr" className="route-option-out">
                    {amountOf(q.expected, to.decimals)} {to.symbol}
                  </bdi>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="input-hint">{t("v13.rankingNote")}</p>
      </div>
    );
  const readiness = () => {
    const items: [IconName, "ok" | "todo" | "warn" | "locked", string][] = [
      account
        ? ["wallet", "ok", t("v110.walletConnected")]
        : ["wallet", "todo", t("v110.walletMissing")],
    ];
    if (account && source.ecosystem === "EVM")
      items.push(
        walletOnSource
          ? ["check", "ok", t("v110.networkMatch", { network: source.name })]
          : ["alert", "warn", t("v110.networkMismatch")],
      );
    items.push(
      senderValid && recipientValid
        ? ["check", "ok", t("v110.addressesValid")]
        : ["minus", "todo", t("v110.addressesMissing")],
      valid
        ? ["clock", "ok", t("v110.quoteFresh")]
        : ["minus", "todo", t("v110.quoteMissing")],
      ["lock", "locked", t("v110.executionClosed")],
    );
    return (
      <section className="readiness" aria-labelledby={`readiness-${mode}`}>
        <h3 id={`readiness-${mode}`}>{t("v111.executionChecks")}</h3>
        <ul>
          {items.map(([icon, state, label]) => (
            <li key={label} className={`is-${state}`}>
              <Icon name={icon} size={15} />
              <span>{label}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  };
  // "Route details" (inline disclosure): steps and protocols, minimum received, execution checks.
  const routeDetails = () =>
    quote && (
      <details className="disclosure route-details">
        <summary>{t("v111.routeDetails")}</summary>
        <div className="disclosure-body">
          {fullQuoteFacts()}
          <dl className="quote-summary">
            <div>
              <dt>{t("v110.minimumReceived")}</dt>
              <dd>
                <bdi dir="ltr">
                  {amountOf(quote.minimum, to.decimals)} {to.symbol}
                </bdi>
              </dd>
            </div>
            <div>
              <dt>{t("ui.estimatedTime")}</dt>
              <dd>
                {t("ui.seconds", {
                  count: new Intl.NumberFormat(lang).format(
                    Math.ceil(quote.duration),
                  ),
                })}
              </dd>
            </div>
            <div>
              <dt>{t("v13.platformFee")}</dt>
              <dd>{formatPercent(0, lang)}</dd>
            </div>
            <div>
              <dt>{t("ui.totalEstimatedCost")}</dt>
              <dd>
                {sumUSD === undefined
                  ? t("ui.usdTotalUnknown")
                  : formatFiat(sumUSD, lang)}
              </dd>
            </div>
          </dl>
          <ol className="route-steps">
            {quote.steps.map((s) => (
              <li key={s.id}>
                {publicToolLabel(s.toolName, lang)} · {s.sourceAsset.symbol} →{" "}
                {s.destinationAsset.symbol} ({publicStepKindLabel(s.type, lang)}
                )
              </li>
            ))}
          </ol>
          {mode === "bridge" && routeChoices()}
          {readiness()}
        </div>
      </details>
    );
  // V1.11 From / Recipient: the connected wallet is the signer. Raw address fields appear only for an explicit
  // choice (another recipient), a cross-ecosystem destination, a non-EVM source or a quote read without a wallet.
  const parties = (
    <div className="trade-parties">
      <div className="party">
        <span className="micro party-label">{t("v111.from")}</span>
        {walletIsSender ? (
          <span className="party-value">
            <Icon name="wallet" size={14} />
            <strong>{t("v111.connectedWallet")}</strong>
            <code dir="ltr" title={sender}>
              {shortAddress(sender)}
            </code>
          </span>
        ) : (
          <div className="field">
            <label htmlFor="routing-sender" className="party-hint">
              {source.ecosystem === "EVM"
                ? t("v1122.watchAddress")
                : t("ui.sourceAddress")}
              <span className="eco-tag">{source.ecosystem}</span>
            </label>
            <div className="field-control">
              <input
                id="routing-sender"
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                value={sender}
                onChange={(e) => setSender(e.target.value.trim())}
                placeholder={t("ui.forQuoteReadingOnly")}
              />
            </div>
            {sender && !senderValid && (
              <p className="field-error">
                {routingMessage("INVALID_ADDRESS", lang)}
              </p>
            )}
            {source.ecosystem !== "EVM" && (
              <div className="field-actions">
                <button
                  className="small"
                  disabled={walletBusy}
                  onClick={() => void nativeConnect()}
                >
                  {t("ui.readAddressFromBrowserWallet")}
                </button>
                {nativeWalletAddress && (
                  <button
                    className="small"
                    onClick={() => {
                      cancelPending();
                      setNativeWalletAddress("");
                      setSender("");
                      setRevision((v) => v + 1);
                    }}
                  >
                    {t("ui.forgetWalletAddress")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="party">
        <span className="micro party-label">{t("v111.recipient")}</span>
        {customRecipient ? (
          <div className="field">
            <label htmlFor="routing-recipient" className="party-hint">
              {sameEcosystem
                ? t("v111.anotherAddress")
                : t("v111.destinationAddressOn", { network: destination.name })}
              <span className="eco-tag">{destination.ecosystem}</span>
            </label>
            <div className="field-control">
              <input
                id="routing-recipient"
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                value={recipientInput}
                onChange={(e) => setRecipientInput(e.target.value.trim())}
              />
            </div>
            {recipientInput && !recipientValid && (
              <p className="field-error">
                {routingMessage("INVALID_ADDRESS", lang)}
              </p>
            )}
            {sameEcosystem &&
              recipientValid &&
              recipient.toLowerCase() !== sender.toLowerCase() && (
                <p className="input-hint">{t("v111.recipientDiffers")}</p>
              )}
          </div>
        ) : (
          <span className="party-value">
            <Icon name="check" size={14} />
            <strong>{t("v111.sameWallet")}</strong>
            {sender && (
              <code dir="ltr" title={sender}>
                {shortAddress(sender)}
              </code>
            )}
          </span>
        )}
        {sameEcosystem && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={customRecipient}
              onChange={(e) => {
                setCustomRecipient(e.target.checked);
                setRecipientInput("");
              }}
            />
            <span>{t("v111.sendToAnother")}</span>
          </label>
        )}
      </div>
    </div>
  );
  const form = (
    <div className="multichain-form" data-testid="multichain-form">
      {account &&
        source.ecosystem === "EVM" &&
        String(walletChain) !== source.id && (
          <p className="notice tone-warn">
            {t("ui.theConnectedWalletNetworkDoesNot")}
          </p>
        )}
      {(pairReason || catalog?.stale) && (
        <p className="notice" role="status">
          {pairReason === "CROSS_ENVIRONMENT_ROUTE_DISABLED"
            ? t("v111.crossEnvironment")
            : routingMessage(pairReason || "STALE_CATALOG", lang)}
        </p>
      )}
      <div className="trade-pair">
        <section className="trade-panel" aria-labelledby={`${mode}-pay-label`}>
          <div className="trade-panel-top">
            <label id={`${mode}-pay-label`} htmlFor="routing-amount">
              {t(mode === "swap" ? "v112.youPay" : "ui.sourceAsset")}
            </label>
            {sourceHeld && (
              <span className="trade-balance">
                <Icon name="wallet" size={13} />
                <bdi dir="ltr">
                  {formatTokenAmount(
                    BigInt(sourceHeld.balance),
                    sourceHeld.decimals,
                    lang,
                    6,
                  )}{" "}
                  {sourceHeld.symbol}
                </bdi>
              </span>
            )}
          </div>
          <div className="trade-panel-main">
            <input
              id="routing-amount"
              className="trade-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              aria-label={`${t("ui.amount")} · ${from.symbol}`}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {tokenButton("source")}
          </div>
          {/* G12 H04: a share of the READ balance; the native coin's 100% leaves the read route's network fee. */}
          <PercentButtons
            balance={
              scannedRow && scannedRow.decimals === from.decimals
                ? scannedRow.balance
                : undefined
            }
            decimals={from.decimals}
            native={same(from.address, source.nativeAsset.address)}
            networkFee={sourceNetworkFee}
            feeFromRoute
            scannedFor={portfolio ? scannedFor : undefined}
            matchesSender={scanMatchesSender}
            readAt={portfolio?.observedAt}
            now={now}
            onPick={setAmount}
            testId="percent-bridge"
          />
          <div className="trade-panel-foot">
            <span>
              {sourceUnitUsd !== undefined && typedNumber > 0
                ? `≈ ${formatUsd(sourceUnitUsd * typedNumber, lang)}`
                : `${source.name} · ${from.name || from.symbol}`}
            </span>
            {from.address.toLowerCase() !==
              source.nativeAsset.address.toLowerCase() && (
              <code title={from.address}>{shortAddress(from.address)}</code>
            )}
          </div>
          {heldChips.length > 0 && (
            <div
              className="held-chips"
              role="group"
              aria-label={t("v13.yourNetworks")}
            >
              {heldChips.map((h) => (
                <button
                  key={h.address}
                  type="button"
                  aria-pressed={
                    h.address.toLowerCase() === sourceToken.toLowerCase()
                  }
                  onClick={() =>
                    setSourceToken(
                      sourceAssets.find(
                        (a) =>
                          a.address.toLowerCase() === h.address.toLowerCase(),
                      )?.address ?? h.address,
                    )
                  }
                >
                  {h.symbol}
                </button>
              ))}
            </div>
          )}
        </section>
        {mode === "swap" ? (
          <button
            type="button"
            className="trade-flip"
            aria-label={t("v110.flipTokens")}
            disabled={!!pairReason}
            onClick={() => {
              const next = destinationToken;
              setDestinationToken(sourceToken);
              setSourceToken(next);
            }}
          >
            <Icon name="swap" size={18} />
          </button>
        ) : (
          <span className="trade-flip is-static" aria-hidden="true">
            <Icon name="arrowDown" size={18} />
          </span>
        )}
        <section
          className="trade-panel is-receive"
          aria-labelledby={`${mode}-receive-label`}
        >
          <div className="trade-panel-top">
            <span id={`${mode}-receive-label`}>
              {t(mode === "swap" ? "v111.youReceive" : "ui.destinationAsset")}
            </span>
            {mode === "bridge" && (
              <span className="trade-network">
                <ChainLogo network={destination} size="sm" />
                {destination.name}
              </span>
            )}
          </div>
          <div className="trade-panel-main">
            <output
              className={`trade-amount trade-output${quote ? "" : " is-empty"}`}
              aria-live="polite"
            >
              {quote ? (
                <bdi dir="ltr">{amountOf(quote.expected, to.decimals)}</bdi>
              ) : busy ? (
                <span className="skeleton-line is-inline" />
              ) : (
                "0"
              )}
            </output>
            {tokenButton("destination")}
          </div>
          <div className="trade-panel-foot">
            <span>
              {quote
                ? `${t("v110.minimumReceived")}: ${amountOf(quote.minimum, to.decimals)} ${to.symbol}`
                : t("v110.noQuoteYet")}
            </span>
            {quote?.outputUsd !== undefined && (
              <span>≈ {formatUsd(Number(quote.outputUsd), lang)}</span>
            )}
          </div>
        </section>
      </div>
      {parties}
      <details className="disclosure trade-settings-disclosure">
        <summary>
          {t("ui.slippage")} {formatPercent(slippage, lang)} ·{" "}
          {t(
            preference === "receive"
              ? "ui.higherReceiveAmount"
              : "ui.shorterDuration",
          )}
        </summary>
        <div className="trade-status">
          <p className="trade-connection" role="status">
            <span
              className={`status-dot ${connectionState === "available" ? "ok" : connectionState === "loading" ? "idle" : "warn"}`}
            />
            {t("ui.routeConnection")}:{" "}
            {connectionState === "available"
              ? t("ui.listedAQuoteIsNotGuaranteed")
              : connectionState === "none"
                ? t("ui.noConnection")
                : connectionState === "loading"
                  ? t("ui.loading")
                  : t("ui.unknown")}
          </p>
          {portfolio && (
            <p className="input-hint" role="status">
              {t(
                portfolioStale(portfolio, now)
                  ? "v13.stale"
                  : "v13.yourNetworks",
              )}
            </p>
          )}
        </div>
        <div className="trade-settings">
          <fieldset>
            <legend>{t("ui.slippage")}</legend>
            <div className="segmented">
              {[0.005, 0.01, 0.03].map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={slippage === value}
                  onClick={() => setSlippage(value)}
                >
                  {formatPercent(value, lang)}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>{t("ui.preference")}</legend>
            <div className="segmented">
              {(
                [
                  ["receive", "ui.higherReceiveAmount"],
                  ["time", "ui.shorterDuration"],
                ] as const
              ).map(([value, key]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={preference === value}
                  onClick={() => setPreference(value)}
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </details>
      {error && (
        <p className="notice tone-danger" role="alert">
          {routingMessage(error, lang)}
        </p>
      )}
      {quote && (
        <div className="quote-preview">
          {freshness()}
          {quoteFacts()}
          {routeDetails()}
        </div>
      )}
      <div className="trade-actions">
        {(!quote || !valid) && (
          <>
            <button
              className="primary"
              disabled={quoteDisabled}
              onClick={() => void requestQuote()}
            >
              {busy
                ? t("ui.readingQuote")
                : quote
                  ? t("v112.refreshQuote")
                  : t("ui.readRoute")}
              <Icon
                name={busy ? "refresh" : quote ? "refresh" : "arrowRight"}
                size={18}
                className={busy ? "spin" : quote ? undefined : "flip-rtl"}
              />
            </button>
          </>
        )}
        {!busy && blocker && (
          <p className="trade-hint">
            <Icon name="info" size={14} />
            {blocker}
          </p>
        )}
        {quote && valid && guardianBlocked && (
          <p className="notice tone-danger guardian-block-note">
            {t("guardian.blockedRoute")}
          </p>
        )}
        {quote && valid && (
          <button
            className="primary"
            disabled={!reviewable}
            onClick={(e) => openModal(dialog.current, e.currentTarget)}
          >
            {valid ? t("ui.reviewRoute") : t("ui.quoteExpired")}
            <Icon name="arrowRight" size={18} className="flip-rtl" />
          </button>
        )}
        <p className="under-button execution-status" role="status">
          <Icon name="lock" size={13} />
          {t("ui.sendingDisabled")}
        </p>
      </div>
      <dialog
        ref={dialog}
        className="routing-review"
        aria-labelledby={`routing-review-title-${mode}`}
        {...modalProps()}
      >
        <div className="dialog-top">
          <h2 id={`routing-review-title-${mode}`}>{t("ui.routeReview")}</h2>
          <button
            className="icon-button"
            aria-label={t("ui.close")}
            onClick={() => dialog.current?.close()}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        {valid && routeReview()}
        {valid && guardianReview}
        {/* G13: the server's owner-signed execution check (read-only; sending stays closed). */}
        {valid && mode === "bridge" && quote && (
          <ExecutionReview
            key={quote.id}
            input={quote.input}
            account={account}
            walletChain={walletChain}
          />
        )}
        <div className="dialog-actions">
          <button
            className="secondary"
            disabled={!reviewable || saved}
            onClick={async () => {
              if (quote && reviewable) {
                try {
                  await savePreview(quote, source, destination);
                  setSaved(true);
                } catch {
                  setError("STORAGE_UNAVAILABLE");
                }
              }
            }}
          >
            <Icon name={saved ? "check" : "download"} size={16} />
            {saved ? t("ui.previewSaved") : t("ui.savePreviewToActivity")}
          </button>
          <button className="primary" disabled>
            {t("ui.sendingDisabled")}
            <Icon name="lock" size={16} />
          </button>
        </div>
      </dialog>
      {picker && (
        <TokenPicker
          role={picker}
          assets={picker === "source" ? sourceAssets : destinationAssets}
          selected={picker === "source" ? sourceToken : destinationToken}
          network={picker === "source" ? source : destination}
          portfolio={portfolio}
          lang={lang}
          onSelect={(address) =>
            picker === "source"
              ? setSourceToken(address)
              : setDestinationToken(address)
          }
          onClose={() => {
            setPicker(undefined);
            pickerTrigger.current?.focus();
          }}
        />
      )}
    </div>
  );
  if (mode !== "swap") return form;
  return (
    <div
      className={`bridge-grid trade-grid${mode === "swap" ? " swap-layout" : ""}${mode === "swap" && !quote ? " is-unquoted" : ""}`}
    >
      <section
        className="card bridge-card swap-card"
        aria-label={t("v13.swap")}
      >
        {cardHeader}
        {form}
      </section>
      {(mode !== "swap" || quote) && (
        <aside className="route-side trade-aside">
          <section className="card quote-card">
            {quote ? (
              <>
                <details className="disclosure">
                  <summary>{t("v110.routeOptions")}</summary>
                  <div className="route-identity">
                    <ChainBadge network={source} />
                    <span className="route-pair-tokens">
                      {tokenMark(from, source)}
                      <Icon name="arrowRight" size={13} className="flip-rtl" />
                      {tokenMark(to, destination)}
                    </span>
                  </div>
                  {routeChoices()}
                </details>
              </>
            ) : (
              <div className="quote-empty">
                <span className="empty-icon" aria-hidden="true">
                  <Icon name="route" size={20} />
                </span>
                <p>
                  <strong>{t("v110.noQuoteYet")}</strong>
                  {t("v110.quoteEmptyBody")}
                </p>
              </div>
            )}
          </section>
          <details className="disclosure safety-learn">
            <summary>{t("product.safetyTitle")}</summary>
            <div className="safety">
              <span className="shield" aria-hidden="true">
                <Icon name="shield" size={20} />
              </span>
              <div>
                <h3>{t("product.safetyTitle")}</h3>
                <p>{t("v13.securityNote")}</p>
              </div>
            </div>
          </details>
        </aside>
      )}
    </div>
  );
}
