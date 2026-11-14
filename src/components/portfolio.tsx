"use client";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useI18n } from "../i18n/provider";
import { PortfolioAtmosphere } from "./atmosphere";
import { formatTokenAmount, formatUsd, formatPercent } from "../i18n/amounts";
import {
  identitySchema,
  mergePortfolio,
  portfolioStale,
  detectedValue,
  type ChainCoverage,
  type PortfolioIdentity,
  type PortfolioResult,
  type Holding,
} from "../portfolio/model";
import { readCatalog } from "../routing/client";
import { readActiveCatalog } from "../catalog/client";
import type { Catalog, Network } from "../routing/model";
import { ChainLogo, chainThemeClass } from "./multichain-identity";
import { LogoImage } from "./logo-image";
import { isAssetLogoSrc } from "./logo-src";
import type { MessageKey } from "../i18n/messages";
import { Icon, type IconName } from "./icons";
import {
  EmptyState,
  PageHeader,
  Pill,
  Skeleton,
  shortAddress,
  useCopy,
  type Tone,
} from "./ui";
import { cssomFill } from "./virtual";
import { TideTag, TokenMark } from "./ocean-marks";
import PortfolioPositions from "./portfolio-positions";
import dynamic from "next/dynamic";
import type { DefiScan } from "../defi/model";
import { portfolioTotals } from "../defi/valuation";
import { exactUsd } from "../defi/display";
import type { PortfolioView } from "./portfolio-defi";
// A local Suspense boundary keeps loading this chunk from suspending/aborting wallet continuation.
import { perf } from "./perf";
import { readWalletRound } from "./wallet-stream";
import {
  applyWalletLine,
  emptyProgress,
  hasMeaningfulAsset,
  heldIds,
  progressiveResult,
  type WalletProgress,
} from "../portfolio/stream";
import { GuardianSweep } from "./guardian-surfaces";
import { publishGuardianFacts } from "./guardian-context";
import { coverageTiers } from "./portfolio-tiers";
import { displayNativeSymbol } from "../registry/native-gas";
const PortfolioDefi = dynamic(() => import("./portfolio-defi"), { ssr: false });
// Keep the meaningful server-rendered view visible, but do not accept input before
// React can preserve it. The server snapshot also matches the first hydration pass.
const subscribeHydration = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
// Explicit "View another address" scans continue a few rounds; the connected wallet's own scan continues until
// every planned network has an answer (bounded), progressively, without user action.
const AUTO_CONTINUE = 3;
const WALLET_CONTINUE = 15;
const AUTO_REFRESH_MS = 120_000;
// V1.14.2 progressive render coalescing: streamed network results are applied at most once per window; the plan,
// the first meaningful asset, the first page and the DeFi start render at once (never delayed).
const FLUSH_MS = 200;
// VWP G10: the identity each portfolio result was scanned for (display attribution only; the result object itself is
// unchanged and the parent keeps it as is).
const RESULT_FOR = new WeakMap<PortfolioResult, string>();
// Stable display order while a progressive scan streams: rows keep their position between milestones (plan, first
// page, complete round); new rows join below and the full value sort is applied at the next milestone.
function stableSort<T>(
  list: T[],
  key: (item: T) => string,
  compare: (a: T, b: T) => number,
  order: Map<string, number> | null,
) {
  const sorted = [...list].sort(compare);
  if (!order) return sorted;
  const rank = (item: T) => order.get(key(item)) ?? Number.MAX_SAFE_INTEGER;
  return sorted
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.i - b.i)
    .map((x) => x.item);
}
const holdingKey = (h: Holding) => `${h.chainId}:${h.address.toLowerCase()}`;
// Milestone order (null → rank by known value now); otherwise existing ranks are kept and new rows appended.
function orderOf(
  view: PortfolioResult,
  previous: { assets: Map<string, number>; chains: Map<string, number> } | null,
) {
  const rows = view.holdings
    .filter((h) => BigInt(h.balance) > 0n)
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const byChain = new Map<string, number>();
  for (const h of rows)
    if (!h.spam)
      byChain.set(h.chainId, (byChain.get(h.chainId) ?? 0) + (h.usd ?? 0));
  const assets = new Map(previous?.assets ?? []);
  for (const h of rows)
    if (!assets.has(holdingKey(h))) assets.set(holdingKey(h), assets.size);
  const chains = new Map(previous?.chains ?? []);
  for (const [id] of [...byChain].sort((a, b) => b[1] - a[1]))
    if (!chains.has(id)) chains.set(id, chains.size);
  return { assets, chains };
}
// V1.11 coverage classes shown to users (truthful; an unchecked network is never "zero").
type CoverageClass =
  | "FULL_INDEXED"
  | "CURATED_BALANCE_SCAN"
  | "ON_DEMAND"
  | "NATIVE_ONLY"
  | "CATALOG_ONLY"
  | "FAILED"
  | "PENDING";
export function coverageClass(c: ChainCoverage): CoverageClass {
  if (c.state === "PENDING") return "PENDING";
  if (c.state === "FAILED") return "FAILED";
  if (c.state === "CATALOG_ONLY" || c.tier === "CATALOG_ONLY")
    return "CATALOG_ONLY";
  // The class names what was actually read, not the tier's ambition: an index that is still catching up
  // (INDEXING → known tokens) is not "Full index", and failed/unchecked token reads leave native only.
  if (c.tier === "FULL_INDEXED" && c.tokens === "INDEXED")
    return "FULL_INDEXED";
  if (c.tokens === "CURATED") return "CURATED_BALANCE_SCAN";
  if (c.tokens === "KNOWN_TOKENS" || c.tokens === "INDEXED") return "ON_DEMAND";
  return "NATIVE_ONLY";
}
const CLASS_TONE: Record<CoverageClass, Tone> = {
  FULL_INDEXED: "ok",
  CURATED_BALANCE_SCAN: "ok",
  ON_DEMAND: "ok",
  NATIVE_ONLY: "info",
  CATALOG_ONLY: "neutral",
  FAILED: "danger",
  PENDING: "warn",
};
// Imported exact contracts (Swap/Bridge picker, this device) for the portfolio's bounded extra discovery.
function importedContracts() {
  const out: Record<string, string[]> = {};
  try {
    for (
      let i = 0;
      i < localStorage.length && Object.keys(out).length < 5;
      i++
    ) {
      const key = localStorage.key(i) ?? "";
      const m = /^otherbridge:imported-tokens:(\d{1,18})$/.exec(key);
      if (!m) continue;
      const list = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (!Array.isArray(list)) continue;
      const addresses = list
        .map((t: { address?: unknown }) => String(t?.address ?? ""))
        .filter((a: string) => /^0x[0-9a-f]{40}$/.test(a))
        .slice(0, 25);
      if (addresses.length) out[m[1]] = addresses;
    }
  } catch {
    /* storage unavailable */
  }
  return out;
}
const ECOSYSTEMS = [
  "evm",
  "solana",
  "bitcoin",
  "sui",
  "tron",
  "stellar",
] as const;
const PLACEHOLDER: Record<(typeof ECOSYSTEMS)[number], string> = {
  evm: "0x…",
  solana: "So1…",
  bitcoin: "bc1… , 1… , 3…",
  sui: "0x…",
  tron: "T…",
  stellar: "G…",
};
const NAME: Record<(typeof ECOSYSTEMS)[number], string> = {
  evm: "EVM",
  solana: "Solana",
  bitcoin: "Bitcoin",
  sui: "Sui",
  tron: "Tron",
  stellar: "Stellar",
};
// Decimal token units as a JS number for display ratios only (prices, shares); balances stay bigint elsewhere.
const units = (h: Holding) =>
  Number(
    formatTokenAmount(BigInt(h.balance), h.decimals, "en").replaceAll(",", ""),
  );
export default function Portfolio({
  account,
  walletChain,
  result,
  onResult,
  onAction,
  identity,
  onIdentity,
  onConnect,
}: {
  account: string;
  walletChain?: number;
  result?: PortfolioResult;
  onResult: (value: PortfolioResult | undefined) => void;
  onAction: (network: Network, token: Holding, mode: "bridge" | "swap") => void;
  identity: PortfolioIdentity;
  onIdentity: (value: PortfolioIdentity) => void;
  onConnect?: () => void;
}) {
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientReady,
    serverReady,
  );
  const { t, lang } = useI18n(),
    [catalog, setCatalog] = useState<Catalog>(),
    [names, setNames] = useState<Map<string, string>>(new Map()),
    [busy, setBusy] = useState(false),
    [defi, setDefi] = useState<DefiScan>(),
    [defiEpoch, setDefiEpoch] = useState(0),
    [portfolioView, setPortfolioView] = useState<PortfolioView>("overview"),
    [error, setError] = useState(""),
    [showSmall, setShowSmall] = useState(false),
    [showSpam, setShowSpam] = useState(false),
    [flaggedOnly, setFlaggedOnly] = useState(false),
    [query, setQuery] = useState(""),
    [chainFilter, setChainFilter] = useState("all"),
    // Network atlas: the ten largest networks first; the rest unfold on request.
    [atlasOpen, setAtlasOpen] = useState(false),
    [sortBy, setSortBy] = useState<"value" | "name" | "network">("value"),
    // VWP G10: the holdings table can be grouped under one header per network (DeBank-like chain grouping).
    [grouped, setGrouped] = useState(false),
    [assetView, setAssetView] = useState<"all" | "wallet" | "defi">("all"),
    [chainSort, setChainSort] = useState<"value" | "name">("value"),
    [moreOpen, setMoreOpen] = useState(
      () =>
        !!(
          identity.solana ||
          identity.bitcoin?.length ||
          identity.sui ||
          identity.tron ||
          identity.stellar
        ),
    ),
    [now, setNow] = useState(() => Date.now()),
    // V1.11: the connected wallet is scanned automatically; any other address is an explicit watch-only scan.
    [mode, setMode] = useState<"wallet" | "watch">(() =>
      account ? "wallet" : "watch",
    ),
    [scannedFor, setScannedFor] = useState(""),
    [modeAccount, setModeAccount] = useState(account),
    // V1.14.2 progressive scan state: the phase line, the DeFi start gate and the stable display order.
    [phase, setPhase] = useState<{
      kind: "priority" | "background";
      priority: number;
    } | null>(null),
    [defiGate, setDefiGate] = useState(false),
    [stableOrder, setStableOrder] = useState<{
      assets: Map<string, number>;
      chains: Map<string, number>;
    } | null>(null);
  // A connect switches to "My wallet", a disconnect to "View another address" (adjusted during render, not in an
  // effect, so the auto-scan below sees the new mode in the same pass).
  if (modeAccount !== account) {
    setModeAccount(account);
    setMode(account ? "wallet" : "watch");
  }
  const busyRef = useRef(false);
  const request = useRef<AbortController | null>(null),
    sequence = useRef(0),
    latest = useRef<PortfolioResult | undefined>(result),
    previousAccount = useRef(account);
  const { copied, copy } = useCopy();
  useEffect(() => {
    latest.current = result;
  }, [result]);
  useEffect(() => {
    const c = new AbortController();
    readCatalog(c.signal)
      .then(setCatalog)
      .catch(() => {});
    readActiveCatalog(c.signal)
      .then((a) =>
        setNames(
          new Map(
            a.chains
              .filter((x) => x.chainId)
              .map((x) => [x.chainId as string, x.name]),
          ),
        ),
      )
      .catch(() => {});
    return () => c.abort();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    request.current?.abort();
    sequence.current++;
    // A wallet account change drops any result that may have landed for the previous wallet; a disconnect stops
    // the connected scan. Nothing from one identity is ever merged into another.
    if (previousAccount.current !== account) {
      previousAccount.current = account;
      onResult(undefined);
      setDefi(undefined);
      setScannedFor("");
      setBusy(false);
      setPhase(null);
      setDefiGate(false);
      setStableOrder(null);
      busyRef.current = false;
    }
    const timer = setTimeout(
      () => account && onIdentity({ ...identity, evm: account }),
      0,
    );
    return () => clearTimeout(timer);
    // Address edits belong to explicit scan state; wallet changes alone update EVM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);
  const network = (id: string) => catalog?.networks.find((n) => n.id === id);
  /** A native asset's own mark: the coin's home network logo (ETH → Ethereum, BNB → BNB Chain); the network it is
   * held on becomes the badge when that is another network (ETH on Base: the ETH mark with a Base badge). */
  const nativeHome = (symbol: string) =>
    catalog?.networks
      .filter(
        (x) =>
          x.mainnet && x.nativeAsset.symbol === symbol && /^\d+$/.test(x.id),
      )
      .sort((a, b) => Number(a.id) - Number(b.id))[0];
  const chainName = (id: string) =>
    network(id)?.name ?? names.get(id) ?? t("v14.unknownChain", { id });
  // Progressive scan: the first page renders immediately; pending networks continue automatically
  // a bounded number of times, then by explicit user action. Pending is never shown as empty.
  const scan = async (
    continuation?: string,
    own = mode === "wallet",
    refresh = false,
  ) => {
    const target: PortfolioIdentity = own ? { evm: account } : identity;
    const p = identitySchema.safeParse(target);
    if (!p.success) {
      setError(t("routingErrors.INVALID_ADDRESS"));
      return;
    }
    const scanLabel =
      p.data.evm ??
      p.data.solana ??
      p.data.bitcoin?.[0] ??
      p.data.sui ??
      p.data.tron ??
      p.data.stellar ??
      "";
    request.current?.abort();
    const c = new AbortController(),
      attempt = ++sequence.current;
    request.current = c;
    const live = () => attempt === sequence.current && !c.signal.aborted;
    setBusy(true);
    busyRef.current = true;
    setError("");
    if (!continuation) {
      setDefi(undefined);
      setDefiEpoch((n) => n + 1);
      setDefiGate(false);
      setPhase(null);
      perf.scanStart();
    }
    // Scheduling evidence of the same identity's previous scan (the result is cleared on any account or address
    // change, so another identity's networks never leak in): order only, never shown as a current balance.
    const known = [
      ...new Set(
        (latest.current?.holdings ?? [])
          .filter((h) => !h.spam && BigInt(h.balance) > 0n)
          .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
          .map((h) => h.chainId),
      ),
    ];
    // The connected chain first (own wallet only, ≤ 5).
    const priority = own && walletChain ? [String(walletChain)] : [];
    const hints = known.length ? { recent: known.slice(0, 24) } : undefined;
    // A refresh of the same identity keeps the previous complete result (with its own observation time and stale
    // marker, as accepted) until the new first page exists, instead of flashing every network back to pending.
    const keepPrevious = !continuation && !!latest.current;
    // DeFi candidate truth: the exact held receipt-token ids of the DeFi networks when DeFi started; a different set
    // at the end of the wallet scan restarts DeFi once with the complete set.
    let defiChains: Set<string> | null = null;
    let defiHeld: string | null = null;
    const defiKey = (holdings: Holding[]) =>
      JSON.stringify(heldIds(holdings, defiChains ?? undefined));
    try {
      let cursor = continuation,
        rounds = 0,
        current = continuation ? latest.current : undefined;
      do {
        const r = await fetch("/api/portfolio", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/x-ndjson, application/json",
          },
          body: JSON.stringify({
            identity: p.data,
            consent: true,
            ...(cursor ? { continuation: cursor } : {}),
            ...(priority.length ? { priority } : {}),
            ...(Object.keys(importedContracts()).length
              ? { extraTokens: importedContracts() }
              : {}),
            ...(hints && !cursor ? { hints } : {}),
            ...(refresh && !cursor ? { fresh: true } : {}),
          }),
          signal: AbortSignal.any([c.signal, AbortSignal.timeout(25000)]),
        });
        if (!r.ok) throw Error("UNAVAILABLE");
        // Progressive round: lines are coalesced into one render per window; milestones render at once.
        const base = cursor ? current : undefined;
        let progress: WalletProgress = emptyProgress();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const flush = (milestone = false) => {
          clearTimeout(timer);
          timer = undefined;
          if (!live() || (keepPrevious && !progress.firstPage)) return;
          const view = progressiveResult(progress, base);
          if (!view) return;
          perf.flush();
          RESULT_FOR.set(view, scanLabel);
          onResult(view);
          setStableOrder((order) => orderOf(view, milestone ? null : order));
        };
        const value = await readWalletRound(r, (line) => {
          if (!live()) return;
          const meaningful = hasMeaningfulAsset(progress);
          progress = applyWalletLine(progress, line);
          if (line.type === "plan") {
            if (!line.continued) {
              defiChains = new Set(line.defiChains);
              setPhase({ kind: "priority", priority: line.firstPage.chains });
              perf.once("walletShellReadyMs");
            }
            return flush(true);
          }
          if (!meaningful && hasMeaningfulAsset(progress)) {
            perf.once("firstMeaningfulAssetMs");
            return flush();
          }
          if (line.type === "firstPage") {
            setPhase((v) => v && { ...v, kind: "background" });
            perf.once("firstPageCompleteMs");
            perf.once("walletFirstResultMs");
            return flush(true);
          }
          if (line.type === "defiReady") {
            flush();
            defiHeld = defiKey(
              [...progress.chains.values()].flatMap((l) => l.holdings),
            );
            setDefiGate(true);
            return;
          }
          timer ??= setTimeout(flush, FLUSH_MS);
        });
        clearTimeout(timer);
        if (!live()) return;
        current =
          current && cursor
            ? mergePortfolio(current, value.result)
            : value.result;
        RESULT_FOR.set(current, scanLabel);
        onResult(current);
        setStableOrder(null);
        setNow(Date.now());
        // Code paths without progressive lines (plain JSON): the complete round is the first meaningful answer.
        perf.once("walletShellReadyMs");
        perf.once("firstMeaningfulAssetMs");
        perf.once("firstPageCompleteMs");
        perf.once("walletFirstResultMs");
        setDefiGate(true);
        if (!catalog)
          readCatalog(c.signal)
            .then(setCatalog)
            .catch(() => {});
        cursor = value.result.continuation ?? undefined;
        rounds++;
        if (own) setScannedFor(account.toLowerCase());
      } while (
        cursor &&
        rounds <= (own ? WALLET_CONTINUE : AUTO_CONTINUE) &&
        !c.signal.aborted
      );
      if (live()) {
        perf.once("fullWalletCoverageMs");
        if (
          defiHeld !== null &&
          current &&
          defiKey(current.holdings) !== defiHeld
        )
          setDefiEpoch((n) => n + 1);
      }
    } catch {
      if (live()) setError(t("errors.UPSTREAM_UNAVAILABLE"));
    } finally {
      if (attempt === sequence.current) {
        setBusy(false);
        setPhase(null);
        setStableOrder(null);
        busyRef.current = false;
      }
    }
  };
  // Auto scan: once per connected account (read-only; no signature, no transaction), then a periodic refresh
  // while the page is visible. Account change/disconnect aborts it (effect above).
  const autoKey = mode === "wallet" && account ? account.toLowerCase() : "";
  const hasResult = !!result;
  useEffect(() => {
    if (!autoKey || scannedFor === autoKey || hasResult || busyRef.current)
      return;
    const timer = setTimeout(() => void scan(undefined, true), 0);
    return () => clearTimeout(timer);
    // `scan` reads the latest props. The trigger is the connected identity; `scannedFor`/`hasResult` re-arm it
    // after an account switch clears the previous wallet's result (same commit, so the old closure is stale).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKey, scannedFor, hasResult]);
  useEffect(() => {
    if (!autoKey) return;
    const timer = setInterval(() => {
      if (
        !document.hidden &&
        !request.current?.signal.aborted &&
        !busyRef.current
      )
        void scan(undefined, true);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKey]);
  // Ends the current scan's progressive state (an aborted scan never clears it itself: its sequence is stale).
  const resetProgress = () => {
    setPhase(null);
    setDefiGate(false);
    setStableOrder(null);
  };
  const setAddress = (key: (typeof ECOSYSTEMS)[number], value: string) => {
    request.current?.abort();
    sequence.current++;
    resetProgress();
    setBusy(false);
    busyRef.current = false;
    onResult(undefined);
    setDefi(undefined);
    onIdentity({
      ...identity,
      [key]: value ? (key === "bitcoin" ? value.split(",") : value) : undefined,
    });
  };
  const addressValue = (key: (typeof ECOSYSTEMS)[number]) =>
    key === "bitcoin"
      ? (identity.bitcoin?.join(",") ?? "")
      : (identity[key] ?? "");
  const otherFilled = ECOSYSTEMS.slice(1).filter((k) => addressValue(k));
  // G13 (VBA-P1-05): a native coin of a network that pays gas in ETH is named ETH (two sources agree, see
  // src/registry/native-gas.ts) where the registry took the network's governance-token symbol (MANTA, ZRC).
  const holdings =
      result?.holdings
        .filter((h) => BigInt(h.balance) > 0n)
        .map((h) => {
          const symbol = h.native
            ? displayNativeSymbol(h.chainId, h.symbol)
            : h.symbol;
          return symbol === h.symbol ? h : { ...h, symbol };
        }) ?? [],
    clean = holdings.filter((h) => !h.spam),
    chains = [
      ...new Set([
        ...clean.map((h) => h.chainId),
        ...(defi?.positions.map((p) => p.chainId) ?? []),
      ]),
    ];
  // Known value only: unpriced assets are counted, never dropped; testnet assets are listed but never valued — they
  // enter no total, share, allocation or native/token split, and show no USD amount.
  const counted = (id: string) => network(id)?.mainnet !== false;
  const usdOf = (h: Holding) => (counted(h.chainId) ? h.usd : null);
  const valued = holdings.filter((h) => counted(h.chainId));
  const unpriced = clean.filter(
    (h) => counted(h.chainId) && h.usd === null,
  ).length;
  const nativeValue = detectedValue(valued.filter((h) => h.native && !h.spam));
  const defiWallet = mode === "wallet" ? account : (identity.evm ?? "");
  const activeDefi =
    defi?.wallet === defiWallet.toLowerCase() ? defi : undefined;
  const intelligence = portfolioTotals(
    valued.filter((h) => !network(h.chainId) || network(h.chainId)?.mainnet),
    activeDefi,
  );
  // One unpriced count per screen: beside the known net (wallet + DeFi) it is the same count as the DeFi notes.
  const unpricedShown = activeDefi ? intelligence.unpricedAssets : unpriced;
  // Guardian assistant context: the counts this screen shows (no addresses, no balances).
  const assistantContext = JSON.stringify({
    scanned: !!result,
    assets: clean.length,
    unpriced: unpricedShown,
    hidden: holdings.length - clean.length,
    // gf1 G04: the coverage card's counts of networks not read yet and not readable.
    pending: result?.coverageSummary?.pending ?? 0,
    failed: result?.coverageSummary?.failed ?? 0,
  });
  useEffect(() => {
    publishGuardianFacts("portfolio", JSON.parse(assistantContext));
  }, [assistantContext]);
  useEffect(() => () => publishGuardianFacts("portfolio", undefined), []);
  // Floating ratios are presentation only. Economic amounts/net remain exact decimal strings.
  const total = activeDefi
    ? Number(intelligence.walletUsd) + Number(intelligence.defiUsd)
    : detectedValue(valued);
  const share = (value: number) => (total > 0 ? value / total : 0);
  const coverageOf = (id: string) =>
    result?.coverage.find((c) => c.chainId === id);
  const routable = (id: string) =>
    catalog?.networks.some(
      (n) => n.id === id && n.provider === "routing-core" && n.mainnet,
    ) ?? false;
  const hasGas = (id: string) =>
    holdings.some(
      (g) => g.chainId === id && g.native && BigInt(g.balance) > 0n,
    );
  const attention = holdings.filter(
    (h) =>
      !h.spam &&
      (!hasGas(h.chainId) ||
        !routable(h.chainId) ||
        (h.lastActivity !== null && now - h.lastActivity > 90 * 86400000)),
  );
  const summary = result?.coverageSummary;
  const waiting =
    result?.coverage.filter(
      (c) => c.state === "PENDING" || c.state === "INDEXING",
    ).length ?? 0;
  const historyPartial = (c?: ChainCoverage) =>
    !!c &&
    (c.tokens === "INDEXED" || c.tokens === "KNOWN_TOKENS") &&
    !c.historicalComplete;
  const chainRowList = [
    ...new Set([
      ...chains,
      ...(activeDefi?.positions.map((p) => p.chainId) ?? []),
    ]),
  ].map((id) => {
    const rows = clean.filter((h) => h.chainId === id);
    const exposure = activeDefi
      ? portfolioTotals(rows, {
          ...activeDefi,
          positions: activeDefi.positions.filter((p) => p.chainId === id),
        })
      : undefined;
    const value = counted(id)
      ? exposure
        ? Number(exposure.walletUsd) + Number(exposure.defiUsd)
        : detectedValue(rows)
      : 0;
    // G13 (VBA-P1-04): what the network's figure is made of. Rows without a price are counted, never valued: a
    // network whose rows are all unpriced has no known value (never "$0.00 0%"), and unpriced rows beside priced
    // ones are named next to the known part (the same rule as the grouped asset list). With a DeFi scan the count is
    // the network's own wallet + DeFi count, the same one the headline uses (review fix: DeFi-only networks).
    const unpriced = exposure
      ? exposure.unpricedAssets
      : rows.filter((h) => !h.spam && h.usd === null).length;
    const known = value !== 0 || rows.some((h) => !h.spam && h.usd !== null);
    return {
      id,
      rows,
      value,
      counted: counted(id),
      n: network(id),
      unpriced,
      known,
    };
  });
  const chainRows = stableSort(
    chainRowList,
    (r) => r.id,
    (a, b) =>
      chainSort === "name"
        ? chainName(a.id).localeCompare(chainName(b.id), lang)
        : Number(b.counted) - Number(a.counted) ||
          b.value - a.value ||
          chainName(a.id).localeCompare(chainName(b.id)),
    chainSort === "value" ? (stableOrder?.chains ?? null) : null,
  );
  const byValue = chainRows
    .filter((r) => r.counted)
    .sort((a, b) => b.value - a.value);
  const q = query.trim().toLocaleLowerCase();
  const filtered = holdings.filter(
    (h) =>
      (showSpam || !h.spam) &&
      (assetView === "all" ||
        (assetView === "defi" ? !!h.position : !h.position)) &&
      (showSmall || h.usd === null || h.usd >= 1) &&
      (chainFilter === "all" || h.chainId === chainFilter) &&
      (!flaggedOnly ||
        h.suspicious ||
        h.spam ||
        (!h.native && h.routable === false)) &&
      (!q ||
        `${h.symbol} ${h.name} ${h.address} ${chainName(h.chainId)}`
          .toLocaleLowerCase()
          .includes(q)),
  );
  const ordered = stableSort(
    filtered,
    holdingKey,
    (a, b) =>
      sortBy === "name"
        ? a.symbol.localeCompare(b.symbol, lang)
        : sortBy === "network"
          ? chainName(a.chainId).localeCompare(chainName(b.chainId), lang) ||
            (usdOf(b) ?? -1) - (usdOf(a) ?? -1)
          : Number(counted(b.chainId)) - Number(counted(a.chainId)) ||
            (usdOf(b) ?? -1) - (usdOf(a) ?? -1) ||
            a.symbol.localeCompare(b.symbol),
    sortBy === "value" ? (stableOrder?.assets ?? null) : null,
  );
  // VWP G10 grouping: each network's figure is the known value of the rows SHOWN under it (the accepted
  // detectedValue rule: spam and debt never add), with its unpriced rows and its priced debt named beside it, so a
  // group of unknown values never reads as $0.00. Groups follow that figure (counted networks first, unknown last).
  type GroupFacts = {
    usd: number;
    priced: number;
    unpriced: number;
    debt: number;
    counted: boolean;
  };
  const groupFacts = new Map<string, GroupFacts>();
  if (grouped)
    for (const h of ordered) {
      const g = groupFacts.get(h.chainId) ?? {
        usd: 0,
        priced: 0,
        unpriced: 0,
        debt: 0,
        counted: counted(h.chainId),
      };
      if (g.counted && !h.spam) {
        if (h.usd === null) g.unpriced++;
        else if (h.position?.role === "debt") g.debt += h.usd;
        else {
          g.usd += h.usd;
          g.priced++;
        }
      }
      groupFacts.set(h.chainId, g);
    }
  const groupRank = (id: string) => {
    const g = groupFacts.get(id);
    return !g?.counted ? -2 : g.priced ? g.usd : -1;
  };
  const visible = grouped
    ? [...ordered].sort(
        (a, b) =>
          groupRank(b.chainId) - groupRank(a.chainId) ||
          chainName(a.chainId).localeCompare(chainName(b.chainId), lang) ||
          a.chainId.localeCompare(b.chainId),
      )
    : ordered;
  // Spam and suspicious tokens are listed apart: spam is never counted; suspicious metadata keeps the read price.
  const flagged = holdings.filter((h) => h.spam || h.suspicious);
  // The account band names the identity the shown result was scanned for (recorded with the result), never the
  // current mode's identity: a result kept across navigation is not re-attributed to another address.
  const scannedAddress = (result && RESULT_FOR.get(result)) ?? "";
  const scannedOwn =
    !!account &&
    !!scannedAddress &&
    scannedAddress.toLowerCase() === account.toLowerCase();
  const hiddenCount = holdings.length - visible.length;
  const stale = !!result && portfolioStale(result, now);
  const resultTone: Tone = !result
    ? "neutral"
    : stale
      ? "warn"
      : result.state === "COMPLETE"
        ? "ok"
        : result.state === "FAILED"
          ? "danger"
          : "warn";
  const num = (value: number) => new Intl.NumberFormat(lang).format(value);
  // VWP G10: the price's observation time (date and time, in the reader's zone); an unrepresentable time is omitted.
  const priceClock = new Intl.DateTimeFormat(lang, {
    dateStyle: "short",
    timeStyle: "short",
  });
  const priceTime = (at: number | null) =>
    at !== null && Number.isFinite(new Date(at).getTime()) ? (
      <>
        {" · "}
        <bdi>{priceClock.format(at)}</bdi>
      </>
    ) : null;
  const whole = (value: number) =>
    new Intl.NumberFormat(lang, {
      style: "percent",
      maximumFractionDigits: 0,
    }).format(value);
  const scanButton = (
    <button
      className="primary scan-button"
      disabled={busy || !hydrated}
      onClick={() => void scan(undefined, mode === "wallet", !!result)}
    >
      {busy ? (
        <>
          {t("v110.scanning")}
          <Icon name="refresh" size={17} className="spin" />
        </>
      ) : result ? (
        <>
          {t("product.refresh")}
          <Icon name="refresh" size={17} />
        </>
      ) : (
        <>
          {t("v13.scan")}
          <Icon name="search" size={17} />
        </>
      )}
    </button>
  );
  const field = (key: (typeof ECOSYSTEMS)[number]) => (
    <label key={key} className="scan-field">
      <span className="scan-field-label">
        {NAME[key]}
        {key === "evm" &&
          !!account &&
          addressValue("evm").toLowerCase() === account.toLowerCase() && (
            <span className="field-tag">
              <Icon name="wallet" size={13} />
              {t("v110.fromWallet")}
            </span>
          )}
      </span>
      <input
        aria-label={`${key} ${t("ui.sourceAddress")}`}
        dir="ltr"
        autoComplete="off"
        spellCheck={false}
        disabled={!hydrated}
        placeholder={PLACEHOLDER[key]}
        value={addressValue(key)}
        onChange={(e) => setAddress(key, e.target.value)}
      />
      {key === "bitcoin" && (
        <small className="scan-field-hint">{t("v110.btcHint")}</small>
      )}
    </label>
  );
  return (
    <section className="portfolio-page">
      <PageHeader
        title={t("v13.portfolio")}
        lede={t("v13.scope")}
        meta={
          result && (
            <p role="status" className={`portfolio-state tone-${resultTone}`}>
              <span className="pill-dot" aria-hidden="true" />
              {t(
                `v13.${stale ? "stale" : result.state.toLowerCase()}` as MessageKey,
              )}{" "}
              ·{" "}
              {new Intl.DateTimeFormat(lang, {
                dateStyle: "short",
                timeStyle: "medium",
              }).format(result.observedAt)}
            </p>
          )
        }
      />
      <section className="card portfolio-connect">
        {result?.synthetic && (
          <p className="notice">{t("product.localNote")}</p>
        )}
        <div className="scan-head">
          <div>
            <h2>{t("v13.findFunds")}</h2>
            <p>{t("v13.consent")}</p>
          </div>
          <div
            className="segmented scan-modes"
            role="group"
            aria-label={t("v111.portfolioMode")}
          >
            {(
              [
                ["wallet", "v111.myWallet"],
                ["watch", "v111.viewAnother"],
              ] as const
            ).map(([value, key]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                data-scan-mode={value}
                disabled={!hydrated}
                onClick={() => {
                  if (mode === value) return;
                  request.current?.abort();
                  sequence.current++;
                  resetProgress();
                  setBusy(false);
                  busyRef.current = false;
                  onResult(undefined);
                  setScannedFor("");
                  setMode(value);
                }}
              >
                {t(key)}
              </button>
            ))}
          </div>
        </div>
        {mode === "wallet" ? (
          account ? (
            <div className="scan-primary is-wallet">
              <span className="party-value">
                <Icon name="wallet" size={15} />
                <strong>{t("v111.connectedWallet")}</strong>
                <code dir="ltr" title={account}>
                  {shortAddress(account)}
                </code>
                <small>{t("v111.autoScanNote")}</small>
              </span>
              {scanButton}
            </div>
          ) : (
            <div className="scan-primary is-wallet">
              <p>{t("v111.connectToScan")}</p>
              {onConnect && (
                <button className="secondary" onClick={onConnect}>
                  <Icon name="wallet" size={16} />
                  {t("product.connect")}
                </button>
              )}
            </div>
          )
        ) : (
          <div className="scan-primary">
            {field("evm")}
            {scanButton}
          </div>
        )}
        {mode === "watch" && (
          <details
            className="scan-more"
            open={moreOpen}
            onToggle={(e) => setMoreOpen(e.currentTarget.open)}
          >
            <summary>
              <Icon name="plus" size={15} />
              {t("v110.moreEcosystems")}
              <span className="scan-more-list">
                {ECOSYSTEMS.slice(1)
                  .map((k) => NAME[k])
                  .join(" · ")}
              </span>
              {otherFilled.length > 0 && (
                <span className="pill tone-accent">
                  {num(otherFilled.length)}
                </span>
              )}
            </summary>
            <div className="portfolio-addresses">
              {ECOSYSTEMS.slice(1).map(field)}
            </div>
          </details>
        )}
        {phase && (
          <div
            className="still-checking scan-progress"
            data-testid="scan-progress"
          >
            <p>
              <Icon name="refresh" size={14} className="spin" />
              {/* Phase changes only (plan, first page): progress counts below are not a live region. */}
              <span role="status">
                {phase.kind === "priority"
                  ? t("v1142.scanningPriority", { count: num(phase.priority) })
                  : t("v1142.scanningRemaining")}
              </span>
            </p>
            {summary && (
              <small
                className="scan-progress-counts"
                data-testid="scan-progress-counts"
              >
                {t("v1142.progressCounts", {
                  assets: num(clean.length),
                  checked: num(summary.checked),
                  planned: num(summary.planned - summary.catalogOnly),
                })}
              </small>
            )}
            <span className="progress-indeterminate" aria-hidden="true" />
          </div>
        )}
        {error && (
          <p role="alert" className="notice tone-danger">
            {error}
          </p>
        )}
      </section>
      {!result &&
        (busy ? (
          <div className="portfolio-loading" aria-hidden="true">
            <Skeleton lines={3} className="card" />
            <Skeleton lines={5} className="card" />
          </div>
        ) : (
          <section className="card portfolio-first-scan">
            <PortfolioAtmosphere />
            <EmptyState
              icon="layers"
              title={t("v110.notScanned")}
              actions={
                !account && onConnect ? (
                  <button className="secondary" onClick={onConnect}>
                    <Icon name="wallet" size={16} />
                    {t("product.connect")}
                  </button>
                ) : undefined
              }
            >
              <p>
                {account ? t("v110.notScannedBody") : t("v110.connectOrPaste")}
              </p>
            </EmptyState>
            <ul className="empty-facts">
              <li>
                <Icon name="eye" size={16} />
                {t("v110.factPublicOnly")}
              </li>
              <li>
                <Icon name="shield" size={16} />
                {t("v14.neverEmpty")}
              </li>
              <li>
                <Icon name="lock" size={16} />
                {t("v110.factNoStorage")}
              </li>
            </ul>
          </section>
        ))}
      {result && summary && (
        <div className="portfolio-layout" data-portfolio-view={portfolioView}>
          <div className="portfolio-main">
            <section
              className="card portfolio-summary"
              data-testid="portfolio-summary"
            >
              <div className="summary-main">
                {scannedAddress && (
                  <p className="summary-account">
                    <span>
                      {scannedOwn
                        ? t("v111.connectedWallet")
                        : t("vwp.pf.viewed")}
                    </span>
                    <code dir="ltr" title={scannedAddress}>
                      {shortAddress(scannedAddress)}
                    </code>
                    <button
                      className="icon-button is-tiny"
                      aria-label={`${t("product.copy")} ${shortAddress(scannedAddress)}`}
                      onClick={() => void copy(scannedAddress)}
                    >
                      <Icon
                        name={copied === scannedAddress ? "check" : "copy"}
                        size={13}
                      />
                    </button>
                  </p>
                )}
                <p className="summary-label" title={t("v113.netHelp")}>
                  {activeDefi ? t("v113.knownNet") : t("v111.totalKnownValue")}
                </p>
                <strong className="summary-value">
                  <bdi dir="ltr">
                    {activeDefi
                      ? exactUsd(intelligence.knownNetUsd)
                      : formatUsd(total, lang)}
                  </bdi>
                </strong>
                {activeDefi && intelligence.partial && (
                  <span className="pill tone-warn">{t("v113.partial")}</span>
                )}
                <p className="summary-note">
                  <Icon name="info" size={13} />
                  {activeDefi ? t("v113.netHelp") : t("v13.knownPrices")}
                  {unpricedShown > 0 && (
                    <span
                      className="pill tone-warn"
                      data-testid="unpriced-count"
                    >
                      {t("v111.unpricedAssets", { count: num(unpricedShown) })}
                    </span>
                  )}
                </p>
                <p className="input-hint">{t("v111.testnetExcluded")}</p>
                {total > 0 && (
                  <>
                    <h2 className="alloc-title">{t("vwp.pf.allocation")}</h2>
                    <div className="alloc-bar" aria-hidden="true">
                      {byValue.slice(0, 6).map((r) => (
                        <span
                          key={r.id}
                          className={`alloc-seg ${chainThemeClass(r.n)}`}
                          ref={cssomFill(share(r.value))}
                        />
                      ))}
                    </div>
                    <ul
                      className="alloc-legend chain-atlas"
                      aria-label={t("vwp.pf.allocation")}
                    >
                      {byValue
                        .filter((r) => r.value > 0)
                        .slice(0, atlasOpen ? undefined : 10)
                        .map((r) => (
                          <li key={r.id} className={chainThemeClass(r.n)}>
                            <span className="atlas-mark" aria-hidden="true">
                              {r.n ? (
                                <ChainLogo network={r.n} size="sm" />
                              ) : (
                                <TokenMark
                                  symbol={chainName(r.id)}
                                  seed={r.id}
                                  size="sm"
                                />
                              )}
                            </span>
                            <span className="legend-dot" aria-hidden="true" />
                            <span className="atlas-name">
                              {chainName(r.id)}
                            </span>
                            <span className="atlas-value">
                              <bdi dir="ltr">{formatUsd(r.value, lang)}</bdi>
                              <strong>
                                {formatPercent(share(r.value), lang)}
                              </strong>
                            </span>
                            <span
                              className="atlas-share"
                              aria-hidden="true"
                              ref={cssomFill(share(r.value))}
                            />
                            <button
                              type="button"
                              className="atlas-hit"
                              aria-label={`${t("v110.filterAssets")} · ${chainName(r.id)}`}
                              onClick={() => {
                                setChainFilter(r.id);
                                document
                                  .getElementById("portfolio-assets-title")
                                  ?.scrollIntoView({ block: "start" });
                              }}
                            />
                          </li>
                        ))}
                      {byValue.filter((r) => r.value > 0).length > 10 && (
                        <li className="atlas-more">
                          <button
                            type="button"
                            aria-expanded={atlasOpen}
                            onClick={() => setAtlasOpen((v) => !v)}
                          >
                            {atlasOpen
                              ? t("ux5.fewerNetworks")
                              : t("ux5.moreNetworks", {
                                  count: num(
                                    byValue.filter((r) => r.value > 0).length -
                                      10,
                                  ),
                                })}
                          </button>
                        </li>
                      )}
                    </ul>
                  </>
                )}
              </div>
              <dl className="summary-facts">
                <div>
                  <dt>{t("v13.assets")}</dt>
                  <dd>{num(clean.length)}</dd>
                </div>
                <div>
                  <dt>{t("v13.chains")}</dt>
                  <dd>{num(chains.length)}</dd>
                </div>
                <div>
                  <dt>{t("v110.nativeVsToken")}</dt>
                  <dd>
                    {total > 0
                      ? `${whole(share(nativeValue))} / ${whole(1 - share(nativeValue))}`
                      : "—"}
                    {total > 0 && (
                      <span className="split-bar" aria-hidden="true">
                        <span ref={cssomFill(share(nativeValue))} />
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t("v110.networksChecked")}</dt>
                  <dd>
                    {num(summary.checked)}
                    {(summary.pending > 0 || summary.failed > 0) && (
                      <small>
                        {t("v110.pendingFailed", {
                          pending: num(summary.pending),
                          failed: num(summary.failed),
                        })}
                      </small>
                    )}
                  </dd>
                </div>
              </dl>
            </section>
            {defiWallet && defiGate && (
              <PortfolioDefi
                key={`${defiWallet.toLowerCase()}:${defiEpoch}`}
                wallet={defiWallet}
                holdings={valued}
                chainName={chainName}
                onScan={setDefi}
                view={portfolioView}
                onView={setPortfolioView}
                now={now}
              />
            )}
            <section className="card portfolio-chains-card">
              <div className="card-top">
                <h2>{t("v13.breakdown")}</h2>
                <div
                  className="segmented is-compact"
                  role="group"
                  aria-label={t("v110.sortBy")}
                >
                  {(
                    [
                      ["value", "v110.sortValue"],
                      ["name", "v110.sortName"],
                    ] as const
                  ).map(([value, key]) => (
                    <button
                      key={value}
                      aria-pressed={chainSort === value}
                      onClick={() => setChainSort(value)}
                    >
                      {t(key)}
                    </button>
                  ))}
                </div>
              </div>
              {chainRows.length === 0 ? (
                <p className="muted-line">
                  {summary.checked > 0
                    ? t("v110.noBalancesBody")
                    : t("v110.nothingChecked")}
                </p>
              ) : (
                <div className="portfolio-chains">
                  {chainRows.map(
                    ({
                      id,
                      rows,
                      value,
                      n,
                      counted: isCounted,
                      unpriced: unpricedRows,
                      known,
                    }) => {
                      const unknownValue = !known && unpricedRows > 0;
                      const gas = rows.find((h) => h.native),
                        c = coverageOf(id);
                      return (
                        <article key={id} data-chain={id} className="chain-row">
                          <details>
                            <summary>
                              {n ? (
                                <ChainLogo network={n} />
                              ) : (
                                <span className="network-mark network-mark-md nt-neutral">
                                  <LogoImage
                                    src="/networks/neutral.svg"
                                    size={32}
                                  />
                                </span>
                              )}
                              <span className="chain-row-name">
                                <strong>{chainName(id)}</strong>
                                <small>
                                  {num(rows.length)} {t("v13.assets")} ·{" "}
                                  {t("v13.gas")}:{" "}
                                  {gas
                                    ? `${formatTokenAmount(BigInt(gas.balance), gas.decimals, lang, 6)} ${gas.symbol}`
                                    : t("ui.unknown")}
                                </small>
                              </span>
                              <span className="chain-row-value">
                                <strong
                                  data-value-known={
                                    isCounted
                                      ? String(!unknownValue)
                                      : undefined
                                  }
                                >
                                  {!isCounted ? (
                                    t("v111.testnet")
                                  ) : unknownValue ? (
                                    t("ui.unknown")
                                  ) : (
                                    <bdi dir="ltr">
                                      {formatUsd(value, lang)}
                                    </bdi>
                                  )}
                                </strong>
                                <small>
                                  {!isCounted
                                    ? t("v111.testnetExcluded")
                                    : unknownValue
                                      ? t("v111.unpricedAssets", {
                                          count: num(unpricedRows),
                                        })
                                      : unpricedRows > 0
                                        ? `${formatPercent(share(value), lang)} · ${t("v111.unpricedAssets", { count: num(unpricedRows) })}`
                                        : formatPercent(share(value), lang)}
                                </small>
                                <span
                                  className={`share-bar ${chainThemeClass(n)}`}
                                  aria-hidden="true"
                                >
                                  <span ref={cssomFill(share(value))} />
                                </span>
                              </span>
                              <span className="chain-row-state">
                                <Pill
                                  tone={
                                    c ? CLASS_TONE[coverageClass(c)] : "neutral"
                                  }
                                >
                                  {c
                                    ? t(
                                        `v111.class.${coverageClass(c)}` as MessageKey,
                                      )
                                    : t("ui.unknown")}
                                </Pill>
                                {historyPartial(c) && (
                                  <small className="coverage-marker">
                                    {t("v14.historyPartial")}
                                  </small>
                                )}
                              </span>
                              <Icon
                                name="chevronDown"
                                size={16}
                                className="chain-row-chevron"
                              />
                            </summary>
                            <ul className="chain-assets">
                              {rows
                                .slice()
                                .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1))
                                .map((h) => (
                                  <li key={h.address}>
                                    <TokenMark
                                      symbol={h.symbol}
                                      seed={h.address}
                                      size="sm"
                                      logo={
                                        h.native && n
                                          ? n.theme.logo
                                          : isAssetLogoSrc(h.logo)
                                            ? h.logo
                                            : null
                                      }
                                    />
                                    <bdi>{h.symbol}</bdi>
                                    <span className="chain-asset-amount">
                                      <bdi dir="ltr">
                                        {formatTokenAmount(
                                          BigInt(h.balance),
                                          h.decimals,
                                          lang,
                                          6,
                                        )}
                                      </bdi>
                                    </span>
                                    <span>
                                      {h.usd === null
                                        ? t("ui.unknown")
                                        : formatUsd(h.usd, lang)}
                                    </span>
                                  </li>
                                ))}
                            </ul>
                            <button
                              className="small"
                              onClick={() => {
                                setChainFilter(id);
                                document
                                  .getElementById("portfolio-assets-title")
                                  ?.scrollIntoView({ block: "start" });
                              }}
                            >
                              <Icon name="sliders" size={14} />
                              {t("v110.filterAssets")}
                            </button>
                          </details>
                        </article>
                      );
                    },
                  )}
                </div>
              )}
            </section>
            {!activeDefi && (
              <PortfolioPositions
                result={result}
                chainName={chainName}
                isCounted={counted}
              />
            )}
            <section className="card portfolio-assets-card">
              <div className="card-top">
                <h2 id="portfolio-assets-title">
                  {t("v13.assets")}{" "}
                  <span className="count-badge">{num(visible.length)}</span>
                </h2>
              </div>
              <div className="asset-toolbar">
                <div
                  className="segmented portfolio-asset-views"
                  role="group"
                  aria-label={t("v1122.assetView")}
                >
                  {(["all", "wallet", "defi"] as const).map((view) => (
                    <button
                      key={view}
                      aria-pressed={assetView === view}
                      onClick={() => setAssetView(view)}
                    >
                      {t(`v1122.${view}`)}
                    </button>
                  ))}
                </div>
                <div className="search-field">
                  <Icon name="search" size={16} />
                  <input
                    type="search"
                    aria-label={t("v110.searchAssets")}
                    placeholder={t("v110.searchAssets")}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <select
                  aria-label={t("v110.networkFilter")}
                  value={chainFilter}
                  onChange={(e) => setChainFilter(e.target.value)}
                >
                  <option value="all">{t("ui.allNetworks")}</option>
                  {chainRows.map((r) => (
                    <option key={r.id} value={r.id}>
                      {chainName(r.id)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t("v110.sortBy")}
                  value={sortBy}
                  onChange={(e) =>
                    setSortBy(e.target.value as "value" | "name" | "network")
                  }
                >
                  <option value="value">{t("v110.sortValue")}</option>
                  <option value="name">{t("v110.sortName")}</option>
                  <option value="network">{t("v110.sortNetwork")}</option>
                </select>
                <div className="portfolio-toggles">
                  <label>
                    <input
                      type="checkbox"
                      checked={showSmall}
                      onChange={(e) => setShowSmall(e.target.checked)}
                    />
                    {t("v13.small")}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={showSpam}
                      onChange={(e) => setShowSpam(e.target.checked)}
                    />
                    {t("v13.spam")}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={flaggedOnly}
                      onChange={(e) => setFlaggedOnly(e.target.checked)}
                    />
                    {t("v110.flaggedOnly")}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={grouped}
                      data-testid="portfolio-group"
                      onChange={(e) => setGrouped(e.target.checked)}
                    />
                    {t("vwp.pf.group")}
                  </label>
                </div>
              </div>
              {visible.length > 0 && (
                <div className="asset-head" aria-hidden="true">
                  <span>{t("v13.assets")}</span>
                  <span>{t("ui.amount")}</span>
                  <span>{t("v110.price")}</span>
                  <span>{t("v110.valueLabel")}</span>
                  <span />
                </div>
              )}
              <div className="portfolio-assets">
                {visible.map((h, index) => {
                  const groupHead =
                    grouped &&
                    (index === 0 || visible[index - 1].chainId !== h.chainId);
                  const n = network(h.chainId),
                    capable =
                      n?.mainnet &&
                      n.provider === "routing-core" &&
                      !catalog?.stale &&
                      !h.spam &&
                      // Unverified, impersonating or metadata-less tokens never prefill Bridge/Swap.
                      !h.suspicious &&
                      h.metadataVerified !== false &&
                      (h.native || h.routable !== false);
                  const amountUnits = units(h);
                  const badges: [Tone, IconName, string][] = [];
                  if (h.suspicious)
                    badges.push(["danger", "alert", t("v13.suspicious")]);
                  if (h.spam) badges.push(["danger", "alert", t("v13.spam")]);
                  if (h.discovery === "indexed")
                    badges.push(["info", "search", t("v14.indexedToken")]);
                  if (!h.native && h.routable === false)
                    badges.push(["warn", "info", t("v14.unverified")]);

                  return (
                    <Fragment key={`${h.chainId}:${h.address}`}>
                      {groupHead && (
                        <h3
                          className="asset-group-head"
                          data-group-chain={h.chainId}
                        >
                          {n ? (
                            <ChainLogo network={n} size="sm" />
                          ) : (
                            <TokenMark
                              symbol={chainName(h.chainId)}
                              seed={h.chainId}
                              size="sm"
                            />
                          )}
                          <span className="asset-group-name">
                            {chainName(h.chainId)}
                          </span>
                          {(() => {
                            const g = groupFacts.get(h.chainId);
                            return (
                              <span className="asset-group-figure">
                                <small>{t("vwp.pf.groupKnown")}</small>
                                <bdi dir="ltr" className="asset-group-total">
                                  {!g?.counted
                                    ? t("v111.testnet")
                                    : g.priced
                                      ? formatUsd(g.usd, lang)
                                      : g.unpriced
                                        ? t("ui.unknown")
                                        : "—"}
                                </bdi>
                                {!!g?.counted && g.unpriced > 0 && (
                                  <small className="asset-group-note">
                                    {t("v111.unpricedAssets", {
                                      count: num(g.unpriced),
                                    })}
                                  </small>
                                )}
                                {!!g?.counted && g.debt > 0 && (
                                  <small className="asset-group-note">
                                    {t("v113.debt")}{" "}
                                    <bdi dir="ltr">
                                      {formatUsd(g.debt, lang)}
                                    </bdi>
                                  </small>
                                )}
                              </span>
                            );
                          })()}
                        </h3>
                      )}
                      <article
                        data-token={h.address}
                        data-holding-chain={h.chainId}
                        data-discovery={h.discovery}
                        className="asset-row"
                      >
                        <div className="asset-id">
                          <span className="asset-mark">
                            <TokenMark
                              symbol={h.symbol}
                              seed={`${h.chainId}:${h.address}`}
                              logo={
                                h.native && n
                                  ? (nativeHome(h.symbol) ?? n).theme.logo
                                  : isAssetLogoSrc(h.logo)
                                    ? h.logo
                                    : null
                              }
                              network={
                                h.native &&
                                (nativeHome(h.symbol)?.id ?? n?.id) === n?.id
                                  ? null
                                  : n?.theme
                              }
                            />
                          </span>
                          <div>
                            <strong>
                              {/* G12 H01: a native balance whose network reported no symbol is named honestly. */}
                              <bdi>
                                {h.native && h.symbol === "?"
                                  ? t("g12.pf.nativeUnknown")
                                  : h.symbol}
                              </bdi>
                            </strong>
                            <small>
                              {h.name ||
                                (h.native && h.symbol === "?"
                                  ? t("g12.pf.nativeUnknown")
                                  : h.symbol)}{" "}
                              · {chainName(h.chainId)}
                            </small>
                            {h.position && (
                              <span
                                className={`pill level-badge tone-${h.position.role === "debt" ? "warn" : "info"}`}
                              >
                                {h.position.protocol} ·{" "}
                                {t(`v1122.${h.position.category}`)}
                              </span>
                            )}
                            {badges.length > 0 && (
                              <span className="asset-badges">
                                {badges.map(([tone, icon, label]) => (
                                  <Pill key={label} tone={tone} icon={icon}>
                                    {label}
                                  </Pill>
                                ))}
                              </span>
                            )}
                            {!h.native && (
                              <span className="asset-address">
                                <code title={h.address}>
                                  {shortAddress(h.address)}
                                </code>
                                <button
                                  className="icon-button is-tiny"
                                  aria-label={`${t("product.copy")} ${h.native && h.symbol === "?" ? t("g12.pf.nativeUnknown") : h.symbol}`}
                                  onClick={() => void copy(h.address)}
                                >
                                  <Icon
                                    name={
                                      copied === h.address ? "check" : "copy"
                                    }
                                    size={13}
                                  />
                                </button>
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="asset-amount">
                          <bdi dir="ltr">
                            {formatTokenAmount(
                              BigInt(h.balance),
                              h.decimals,
                              lang,
                            )}
                          </bdi>
                          <small>{h.symbol}</small>
                        </div>
                        <div className="asset-price">
                          <span className="asset-price-label">
                            {t("v110.price")}
                          </span>
                          {!counted(h.chainId) ? (
                            "—"
                          ) : h.usd !== null && h.price?.priceUsd ? (
                            // VWP G10: the unit price as read (price evidence), not a figure re-derived from value.
                            formatUsd(Number(h.price.priceUsd), lang)
                          ) : h.usd !== null && amountUnits > 0 ? (
                            formatUsd(h.usd / amountUnits, lang)
                          ) : (
                            <TideTag kind="drift" tone="mute">
                              {t("v111.unpriced")}
                            </TideTag>
                          )}
                          {counted(h.chainId) && h.usd !== null && h.price && (
                            <small
                              className="price-source"
                              title={t("v111.priceInformational")}
                            >
                              {/* Each part is its own bidi isolate (the method id and the time are Latin/digits),
                                  so a wrapped line never interleaves them in RTL. */}
                              {h.price.confidence !== "unknown" && (
                                <>
                                  <bdi>
                                    {h.price.confidence === "verified"
                                      ? t("vwp.pf.priceVerified")
                                      : t("vwp.pf.priceDerived")}
                                  </bdi>
                                  {" · "}
                                </>
                              )}
                              <bdi>
                                {t("v111.priceSource", {
                                  source: `\u2068${h.price.method}\u2069`,
                                })}
                              </bdi>
                              {priceTime(h.price.observedAt)}
                            </small>
                          )}
                        </div>
                        <div className="asset-value">
                          <strong>
                            {!counted(h.chainId) ? (
                              t("v111.testnet")
                            ) : h.usd === null ? (
                              <span className="is-unknown">
                                {t("ui.unknown")}
                              </span>
                            ) : (
                              formatUsd(h.usd, lang)
                            )}
                          </strong>
                          {counted(h.chainId) &&
                            h.usd !== null &&
                            total > 0 &&
                            h.position?.role !== "debt" &&
                            !h.spam && (
                              <small>
                                {activeDefi &&
                                intelligence.replaced.includes(
                                  h.chainId + ":" + h.address.toLowerCase(),
                                )
                                  ? t("v113.represented")
                                  : formatPercent(share(h.usd), lang)}
                              </small>
                            )}
                        </div>
                        <div
                          className="asset-actions"
                          title={t("v13.quoteRequired")}
                        >
                          {capable && n ? (
                            <>
                              <button
                                className="small"
                                onClick={() => onAction(n, h, "bridge")}
                              >
                                {t("product.bridge")}
                              </button>
                              <button
                                className="small"
                                onClick={() => onAction(n, h, "swap")}
                              >
                                {t("v13.swap")}
                              </button>
                            </>
                          ) : (
                            <TideTag kind="still" tone="mute">
                              {t("v13.noRoute")}
                            </TideTag>
                          )}
                        </div>
                      </article>
                    </Fragment>
                  );
                })}
              </div>
              {visible.length === 0 &&
                (holdings.length === 0 ? (
                  <EmptyState
                    icon="layers"
                    title={
                      summary.checked > 0
                        ? t("v110.noBalances")
                        : t("v110.nothingChecked")
                    }
                  >
                    <p>
                      {summary.checked > 0
                        ? t("v110.noBalancesBody")
                        : t("v110.nothingCheckedBody")}
                    </p>
                  </EmptyState>
                ) : (
                  <EmptyState icon="search" title={t("v110.noMatchAssets")}>
                    <button
                      className="small"
                      onClick={() => {
                        setQuery("");
                        setChainFilter("all");
                        setFlaggedOnly(false);
                        setShowSmall(true);
                      }}
                    >
                      {t("v110.clearFilters")}
                    </button>
                  </EmptyState>
                ))}
              {visible.length > 0 && hiddenCount > 0 && (
                <p className="muted-line">
                  {t("v110.hiddenAssets", { count: num(hiddenCount) })}
                </p>
              )}
              {flagged.length > 0 && (
                <details
                  className="portfolio-flagged"
                  data-testid="portfolio-flagged"
                >
                  <summary>
                    <Icon name="alert" size={15} />
                    {t("vwp.pf.flaggedTitle")}
                    <span className="count-badge">{num(flagged.length)}</span>
                  </summary>
                  <p>{t("vwp.pf.flaggedBody")}</p>
                  <ul>
                    {flagged.map((h) => (
                      <li key={`${h.chainId}:${h.address}`}>
                        <TokenMark
                          symbol={h.symbol}
                          seed={`${h.chainId}:${h.address}`}
                          size="sm"
                          logo={isAssetLogoSrc(h.logo) ? h.logo : null}
                          network={network(h.chainId)?.theme}
                        />
                        <span>
                          <strong>
                            <bdi>{h.symbol}</bdi>
                          </strong>{" "}
                          · {chainName(h.chainId)}
                          <small>
                            {h.spam ? t("vwp.pf.spamOne") : t("v13.suspicious")}
                          </small>
                        </span>
                        <code dir="ltr" title={h.address}>
                          {shortAddress(h.address)}
                        </code>
                        <bdi dir="ltr" className="flagged-amount">
                          {formatTokenAmount(
                            BigInt(h.balance),
                            h.decimals,
                            lang,
                          )}{" "}
                          {h.symbol}
                        </bdi>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          </div>
          <aside className="portfolio-aside">
            <GuardianSweep holdings={holdings} />
            <section
              className="card portfolio-coverage"
              data-testid="portfolio-coverage"
            >
              <h2>{t("v110.coverageTitle")}</h2>
              <p
                className="coverage-sentence"
                data-testid="coverage-sentence"
                aria-live={phase ? "off" : "polite"}
              >
                {summary.pending
                  ? t("v14.checkedSummary", {
                      checked: num(summary.checked),
                      pending: num(summary.pending),
                    })
                  : t("v14.checkedAll", {
                      checked: num(summary.checked),
                    })}
              </p>
              <div className="coverage-bar" aria-hidden="true">
                {(
                  [
                    ["ok", summary.checked],
                    ["warn", summary.pending],
                    ["danger", summary.failed],
                    ["neutral", summary.catalogOnly],
                  ] as const
                ).map(([tone, count]) => (
                  <span
                    key={tone}
                    className={`tone-${tone}`}
                    ref={cssomFill(
                      count /
                        Math.max(
                          1,
                          summary.checked +
                            summary.pending +
                            summary.failed +
                            summary.catalogOnly,
                        ),
                    )}
                  />
                ))}
              </div>
              <small>
                {t("v14.coverageCounts", {
                  checked: num(summary.checked),
                  pending: num(summary.pending),
                  failed: num(summary.failed),
                  catalogOnly: num(summary.catalogOnly),
                })}
              </small>
              {(() => {
                // G12 H01: the three kinds of coverage, from the scan's own per-network coverage.
                const tiers = coverageTiers(result);
                return (
                  <dl
                    className="coverage-tiers"
                    data-testid="coverage-tiers"
                    aria-label={t("g12.pf.tiers")}
                  >
                    <div data-tier="native">
                      <dt>{t("g12.pf.tierNative")}</dt>
                      <dd>
                        {t("g12.pf.tierCount", {
                          read: num(tiers.native.read),
                          notRead: num(tiers.native.notRead),
                        })}
                      </dd>
                    </div>
                    <div data-tier="reviewed">
                      <dt>{t("g12.pf.tierReviewed")}</dt>
                      <dd>
                        {t("g12.pf.tierCount", {
                          read: num(tiers.reviewed.read),
                          notRead: num(tiers.reviewed.notRead),
                        })}
                        {tiers.reviewed.partial > 0 && (
                          <span data-testid="tier-partial">
                            {t("g12.pf.tierPartial", {
                              count: num(tiers.reviewed.partial),
                            })}
                          </span>
                        )}
                        <small>{t("g12.pf.tierReviewedNote")}</small>
                      </dd>
                    </div>
                    <div data-tier="discovered">
                      <dt>{t("g12.pf.tierDiscovered")}</dt>
                      <dd>
                        {tiers.discovered.networks ||
                        tiers.discovered.defiPlanned
                          ? t("g12.pf.tierDiscoveredCount", {
                              networks: num(tiers.discovered.networks),
                              checked: num(tiers.discovered.defiChecked),
                              planned: num(tiers.discovered.defiPlanned),
                            })
                          : t("g12.pf.tierNone")}
                      </dd>
                    </div>
                  </dl>
                );
              })()}
              <p className="coverage-truth">
                <Icon name="shield" size={15} />
                <span>{t("v14.neverEmpty")}</span>
              </p>
              <p className="coverage-source">
                <Icon name="layers" size={13} />
                {t("v14.dataSource")}
              </p>
              {result.dataPlane !== "AVAILABLE" && (
                <p className="notice tone-warn" data-testid="data-plane-notice">
                  {t(
                    result.dataPlane === "DEGRADED"
                      ? "v14.degraded"
                      : "v14.unavailable",
                  )}
                </p>
              )}
              {busy && !phase && summary.pending > 0 && (
                <div className="still-checking">
                  <p role="status" data-testid="still-checking">
                    <Icon name="refresh" size={14} className="spin" />
                    {t("v14.stillChecking", {
                      count: num(summary.pending),
                    })}
                  </p>
                  <span className="progress-indeterminate" aria-hidden="true" />
                </div>
              )}
              {!busy && result.continuation && (
                <button
                  className="secondary"
                  data-testid="continue-scan"
                  onClick={() => void scan(result.continuation ?? undefined)}
                >
                  <Icon name="refresh" size={15} />
                  {t("v14.continue")}
                </button>
              )}
              {stale && !busy && (
                <p className="notice tone-warn">{t("v110.refreshNeeded")}</p>
              )}
            </section>
            <section className="card attention">
              <h2>{t("v13.attention")}</h2>
              <p>{t("v13.attentionNote")}</p>
              {waiting > 0 && (
                <p
                  className="attention-waiting"
                  data-testid="attention-indexing"
                >
                  <Icon name="clock" size={14} />
                  {t("v14.attentionIndexing", { count: num(waiting) })}
                </p>
              )}
              {attention.length ? (
                <ul className="attention-list">
                  {attention.map((h) => {
                    const reason = hasGas(h.chainId)
                      ? h.lastActivity !== null &&
                        now - h.lastActivity > 90 * 86400000
                        ? `${t("v13.observed")} · ${new Intl.DateTimeFormat(lang, { dateStyle: "short" }).format(h.lastActivity)}`
                        : routable(h.chainId)
                          ? t("v13.noRoute")
                          : t("v14.attentionCatalog")
                      : coverageOf(h.chainId)?.native === "CHECKED"
                        ? t("v13.noGas")
                        : `${t("v13.gas")}: ${t("ui.unknown")}`;
                    return (
                      <li key={`${h.chainId}:${h.address}`}>
                        <TokenMark
                          symbol={h.symbol}
                          seed={`${h.chainId}:${h.address}`}
                          size="sm"
                          logo={isAssetLogoSrc(h.logo) ? h.logo : null}
                          network={network(h.chainId)?.theme}
                        />
                        <span>
                          <strong>
                            <bdi>{h.symbol}</bdi>
                          </strong>{" "}
                          · {chainName(h.chainId)}
                          <small>{reason}</small>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : waiting === 0 ? (
                <p className="muted-line">
                  <Icon name="check" size={14} />
                  {t("v13.none")}
                </p>
              ) : null}
            </section>
            <details className="card portfolio-coverage-details">
              <summary>
                <Icon name="layers" size={16} />
                {t("v14.coverageDetails")}
                <span className="count-badge">
                  {num(result.coverage.length)}
                </span>
              </summary>
              <ul>
                {result.coverage.map((c) => (
                  <li key={c.chainId} data-coverage={c.state}>
                    <span className="coverage-name">
                      {chainName(c.chainId)}
                    </span>
                    <span
                      className={`state-pill tone-${CLASS_TONE[coverageClass(c)]}`}
                    >
                      {t(`v111.class.${coverageClass(c)}` as MessageKey)}
                    </span>
                    {c.state === "INDEXING" ? (
                      <small>{t("v14.indexing")}</small>
                    ) : null}
                    {historyPartial(c) ? (
                      <small>{t("v14.historyPartial")}</small>
                    ) : null}
                    {c.reason === "TOKEN_READ_INCOMPLETE" ||
                    c.tokens === "FAILED" ? (
                      <small>{t("v14.tokensIncomplete")}</small>
                    ) : null}
                    {c.observedBlock ? (
                      <small>
                        {t("v14.observedBlock")}{" "}
                        <bdi dir="ltr">{c.observedBlock}</bdi>
                      </small>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          </aside>
        </div>
      )}
    </section>
  );
}
