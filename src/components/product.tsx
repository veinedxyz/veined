"use client";
import { G5_STATUS } from "../g5/status";
import { useI18n } from "../i18n/provider";
import { errorMessage, stateMessage, type MessageKey } from "../i18n/messages";
import { LanguageSelector } from "./language-selector";
import { normalizeAmountInput, formatTokenAmount } from "../i18n/amounts";

import Link from "next/link";
import dynamic from "next/dynamic";
import type { Network, Catalog } from "../routing/model";
import { oneNetwork, initialBsc } from "../routing/custom";
import { ChainLogo, chainThemeClass } from "./multichain-identity";
import type {
  Holding,
  PortfolioResult,
  PortfolioIdentity,
} from "../portfolio/model";
// V1.9: from the dependency-free module, so the first-load bundle does not pull the portfolio model.
import { detectedValue } from "../portfolio/value";
import { formatUsd } from "../i18n/amounts";
import { Icon } from "./icons";
import { AbyssField, abyssScene } from "./abyss";
import { brand } from "../content/brand";
import { BrandLogo, BrandMark } from "./brand-logo";
import { AppNav, type NavGlyphName } from "./app-nav";
import type { ViewKit } from "./product-views";
// The initial, disconnected view has no browser-only work. Prerender it so the
// heading, address form and artwork arrive with HTML, while retaining the route's
// separate client chunk. Scans and wallet effects still start only on the client.
const Portfolio = dynamic(() => import("./portfolio"));
const AppOverview = dynamic(() => import("./app-overview"));
// V1.10: Help and the non-Bridge views are code-split (server-rendered, but not part of the Bridge first-load bundle).
const HelpView = dynamic(() => import("./help-view"));
const ActivityView = dynamic(() =>
  import("./product-views").then((m) => m.ActivityView),
);
const ActivityDetailView = dynamic(() =>
  import("./product-views").then((m) => m.ActivityDetailView),
);
const ActivityNotFound = dynamic(() =>
  import("./product-views").then((m) => m.ActivityNotFound),
);
const NetworksView = dynamic(() =>
  import("./product-views").then((m) => m.NetworksView),
);
const AboutView = dynamic(() =>
  import("./product-views").then((m) => m.AboutView),
);
const SettingsView = dynamic(() =>
  import("./product-views").then((m) => m.SettingsView),
);
const Swap = dynamic(() => import("./swap"), { ssr: false });
const NetworkSelector = dynamic(() => import("./network-selector"), {
  ssr: false,
});
const MultichainBridge = dynamic(() => import("./multichain-bridge"), {
  ssr: false,
});
const MultichainCatalog = dynamic(() => import("./multichain-catalog"), {
  ssr: false,
});
const RoutingActivity = dynamic(() => import("./routing-activity"), {
  ssr: false,
});
// G12 H06 VEINED Scan: client-only (it reads this browser's own previews).
const ScanView = dynamic(() => import("./scan-view"), { ssr: false });
// V1.22 weekly points: client-only, so no points data can ever be embedded in server-rendered HTML.
const PointsView = dynamic(() => import("./points-view"), { ssr: false });
// VEINED Guardian: the console and the Bridge side review are code-split (never in the first-load shell).
const GuardianView = dynamic(() => import("./guardian-view"), { ssr: false });
// G12: the reviewed NEAR Intents route inside Bridge (and Swap), loaded only when chosen.
const NearRoute = dynamic(() => import("./near-route"), { ssr: false });
// The Guardian assistant button: a small client-only chunk; its conversation code loads only when it is opened.
const GuardianDock = dynamic(() => import("./guardian-dock"), { ssr: false });
const GuardianBridge = dynamic(
  () => import("./guardian-surfaces").then((m) => m.GuardianBridge),
  { ssr: false },
);
// G7 controlled pilot (owner-approved, LOCAL ONLY): OTHERBRIDGE_G7_LOCAL_PILOT_BUNDLE is a build-time constant that is
// "1" only in the separate local-g7-pilot artifact served by `pnpm g7:product-pilot` (next.config.ts), so these
// imports are constant-folded out of every public build. The panel renders only when the server-side gate passes
// `pilot`; the send capability itself lives in the launcher's one-shot session.
const G7LocalPilotBridge =
  process.env.OTHERBRIDGE_G7_LOCAL_PILOT_BUNDLE === "1"
    ? dynamic(
        () => import("../../scripts/g7-pilot/product/local-pilot-bridge"),
        { ssr: false },
      )
    : null;
const G7LocalPilotBadge =
  process.env.OTHERBRIDGE_G7_LOCAL_PILOT_BUNDLE === "1"
    ? dynamic(
        () =>
          import("../../scripts/g7-pilot/product/local-pilot-bridge").then(
            (m) => m.LocalPilotBadge,
          ),
        { ssr: false },
      )
    : null;
// V1.9: the Privy external-wallet layer (connect-only) loads on the first "Connect wallet" click. A missing or
// invalid NEXT_PUBLIC_PRIVY_APP_ID, an outage or a failed chunk load make the wallet "unavailable"; nothing falls
// back to an injected provider.
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
// gf1 G02: the RainbowKit layer (injected EIP-6963 wallets, connect-only) replaces Privy only when the build opts in
// explicitly with NEXT_PUBLIC_VEINED_WALLET_LAYER=rainbowkit; it is never a fallback for a missing Privy App ID.
const WALLET_LAYER = walletLayerChoice(
  process.env.NEXT_PUBLIC_VEINED_WALLET_LAYER,
);
const WALLET_LAYER_READY =
  WALLET_LAYER === "rainbowkit" || validPrivyAppId(PRIVY_APP_ID);
const RainbowWalletLayer = dynamic(
  () =>
    import("../features/wallet-rainbow/load")
      .then((stage) => stage.loadRainbowWalletLayer())
      .catch(() => {
        walletStore.unavailable("WALLET_UNAVAILABLE");
        return { default: () => null };
      }),
  { ssr: false },
);
const PrivyWalletLayer = dynamic(
  () =>
    import("../features/wallet/privy/load")
      .then((stage) => stage.loadPrivyWalletLayer())
      .catch(() => {
        walletStore.unavailable("WALLET_UNAVAILABLE");
        return { default: () => null };
      }),
  { ssr: false },
);
function WalletIconView({ session }: { session: WalletSession }) {
  const icon = session.walletIcon;
  if (icon?.kind === "data")
    return (
      // eslint-disable-next-line @next/next/no-img-element -- inline data URI only; next/image would add an inline style (CSP).
      <img
        className="wallet-icon"
        src={icon.src}
        alt=""
        width={20}
        height={20}
      />
    );
  if (icon?.kind === "component")
    return (
      <span className="wallet-icon" aria-hidden="true">
        {createElement(icon.component as ComponentType)}
      </span>
    );
  return null;
}
const chainLabel = (id?: number) =>
  id === 612055 ? "ONEchain" : id === 56 ? "BSC" : id ? `#${id}` : "";
import { NetworkLogo } from "./network-identity";
import { flushSync } from "react-dom";
// V1.10 follow-up: the wallet and review dialog bodies are a lazy chunk, warmed on hover/focus of their openers.
const loadDialogs = () => import("./product-dialogs");
import { sceneClasses } from "../content/network-themes";
import { modalProps, openModal } from "./dialog";
import {
  RouteHealthCard,
  RouteSummaryCard,
  type RouteHealth,
  type RouteSummary,
} from "./route-panels";
import type { MultichainRouteState } from "./multichain-bridge";
import type { BridgeGuardianState } from "./guardian-surfaces";
import { guardianPage } from "./guardian-context";
import { RouteKindSwitch, useRouteKind } from "./route-kind";
import type { ChatDraft, ResolvedToken } from "../guardian/chat/model";
import type { Asset } from "../routing/model";
/** A Guardian chat draft handed to Swap or Bridge: it only fills the normal screen (never quotes, signs or sends). */
export interface GuardianPrefill {
  id: string;
  sourceId: string;
  destinationId: string;
  from: Asset;
  to: Asset;
  amount: string;
}
// Exact display units of a raw balance (no floating point), at most 18 places (the chat-draft wire bound).
const displayUnits = (raw: string, decimals: number) => {
  const padded = raw.padStart(decimals + 1, "0");
  const int = padded.slice(0, padded.length - decimals) || "0";
  const frac = padded
    .slice(padded.length - decimals)
    .slice(0, 18)
    .replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
};
import { executionGate } from "../routing/model";
// V1.11: ONEbridge registered-pair picker (lazy; loads the verified pair registry on first open).
const BridgeAssetPicker = dynamic(() => import("./bridge-asset-picker"), {
  ssr: false,
});
const LegacyRouteDetails = dynamic(() =>
  import("./route-details").then((m) => m.LegacyRouteDetails),
);
const LegacySafetyDetails = dynamic(() =>
  import("./route-details").then((m) => m.LegacySafetyDetails),
);
const MultiRouteDetails = dynamic(() =>
  import("./route-details").then((m) => m.MultiRouteDetails),
);
const MultiSafetyDetails = dynamic(() =>
  import("./route-details").then((m) => m.MultiSafetyDetails),
);
export interface BridgePairChoice {
  id: string;
  fromSymbol: string;
  toSymbol: string;
  verified: boolean;
}
const DEFAULT_PAIR: BridgePairChoice = {
  id: `onebridge:612055:0x0000000000000000000000000000000000000001:56:${CROSS.toLowerCase()}`,
  fromSymbol: "ONE",
  toSymbol: "CROSS",
  verified: true,
};
import { usePathname, useRouter } from "next/navigation";
import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from "react";
import { z } from "zod";
import type { TextKey } from "../content/messages";
import {
  BridgeError,
  CROSS,
  ROUTE,
  type Health,
  type Mode,
  type Quote,
  type TransferRecord,
} from "../core/model";
import {
  maximum,
  parseAmount,
  formatAmount as canonicalTokenAmount,
} from "../core/amounts";
import { preflight, validateQuote } from "../adapters/onebridge";
import { errorCode } from "../features/wallet/provider";
import { walletStore, EMPTY_SESSION } from "../features/wallet/store";
import { validPrivyAppId } from "../features/wallet/privy/config";
import { walletLayerChoice } from "../features/wallet-rainbow/choice";
import type { WalletSession } from "../features/wallet/session";
import {
  diagnostic,
  download,
  importHistory,
  readHistory,
  saveRecord,
  attachSourceHash,
} from "../storage/history";
import { RuntimeHistoryView } from "../features/bridge/observation";
import type { G7LocalPilotGate } from "../server/g7-local-pilot";
const balanceSchema = z.object({
  balance: z.string().regex(/^\d+$/),
  bnb: z.string().regex(/^\d+$/),
  sourceCode: z.string().regex(/^0x[0-9a-f]*$/i),
  destinationCode: z.string().regex(/^0x[0-9a-f]*$/i),
});
async function api(body: unknown) {
  const r = await fetch("/api/bridge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  const data = await r.json();
  if (!r.ok) throw new BridgeError(data.error ?? "PROVIDER_UNAVAILABLE");
  return data;
}
function quoteFromWire(raw: unknown): Quote {
  const q = z
    .object({
      id: z.string(),
      mode: z.enum(["local-test", "mainnet-readonly"]),
      account: z.string(),
      recipient: z.string(),
      route: z.string(),
      config: z.string(),
      sourceChain: z.number(),
      destinationChain: z.number(),
      token: z.string(),
      amount: z.string(),
      networkFee: z.string(),
      serviceFee: z.string(),
      gasBudget: z.string(),
      expected: z.string(),
      min: z.string(),
      max: z.string(),
      expiresAt: z.number(),
      observedAt: z.number(),
    })
    .parse(raw);
  return {
    ...q,
    amount: BigInt(q.amount),
    networkFee: BigInt(q.networkFee),
    serviceFee: BigInt(q.serviceFee),
    gasBudget: BigInt(q.gasBudget),
    expected: BigInt(q.expected),
    min: BigInt(q.min),
    max: BigInt(q.max),
  };
}
export function Product({
  children,
  pilot = null,
}: {
  children: ReactNode;
  pilot?: G7LocalPilotGate | null;
}) {
  const path = usePathname();
  const [routeKind, setRouteKind] = useRouteKind(path);
  const [sourceNetwork, setSourceNetwork] = useState<Network>(oneNetwork);
  const [destinationNetwork, setDestinationNetwork] =
    useState<Network>(initialBsc);
  const [catalog, setCatalog] = useState<Catalog>();
  const [portfolio, setPortfolio] = useState<PortfolioResult>();
  const [portfolioIdentity, setPortfolioIdentity] = useState<PortfolioIdentity>(
    {},
  );
  const [portfolioPrefill, setPortfolioPrefill] = useState<{
    network: Network;
    token: Holding;
  }>();
  // Guardian chat drafts opened in Swap or Bridge (prefill only; the user reviews and Guardian checks again there).
  const [guardianPrefill, setGuardianPrefill] = useState<GuardianPrefill>();
  // G12: a Portfolio or Guardian prefill always opens the route search it belongs to (never hidden behind "To NEAR").
  useEffect(() => {
    if (!guardianPrefill && !portfolioPrefill) return;
    const timer = setTimeout(() => setRouteKind("network"), 0);
    return () => clearTimeout(timer);
  }, [guardianPrefill, portfolioPrefill, setRouteKind]);
  const [routingWalletRevision, setRoutingWalletRevision] = useState(0);
  const networkTrigger = useRef<HTMLButtonElement | null>(null);
  const [networkPicker, setNetworkPicker] = useState<
    "source" | "destination"
  >();
  const legacyPair =
    sourceNetwork.id === "612055" && destinationNetwork.id === "56";
  const router = useRouter();
  const { lang, t: translate } = useI18n();
  const formatAmount = (value: bigint, places = 6) =>
    formatTokenAmount(value, 18, lang, places);
  const canonicalAmount = (value: string) =>
    normalizeAmountInput(value, lang, 18);
  const [theme, setTheme] = useState("dark");
  const [mode, setMode] = useState<Mode>("mainnet-readonly");
  const [configReady, setConfigReady] = useState(false);
  // One wallet session for Bridge, Swap, Portfolio, Activity and the header (V1.9).
  const session = useSyncExternalStore(
    walletStore.subscribe,
    walletStore.get,
    () => EMPTY_SESSION,
  );
  const connected = session.status === "connected" && !!session.provider;
  const account = connected ? session.address : "";
  const chain = connected ? session.chainId : undefined;
  const adapter = connected ? session.provider : null;
  const [layerRequested, setLayerRequested] = useState(false);
  const boundIdentity = useRef("");
  const rebinding = useRef(false);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<Health>();
  const [healthBusy, setHealthBusy] = useState(false);
  const [balances, setBalances] = useState<z.infer<typeof balanceSchema>>();
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote>();
  const [busy, setBusy] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [historyClaims, setHistoryClaims] = useState<TransferRecord[]>([]);
  const [historyView] = useState(() => new RuntimeHistoryView());
  const [filter, setFilter] = useState("all");
  const [copied, setCopied] = useState("");
  const [includePublic, setIncludePublic] = useState(false);
  const [now, setNow] = useState(0);
  const records = historyView.view(historyClaims, now);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const walletDialog = useRef<HTMLDialogElement>(null);
  const reviewDialog = useRef<HTMLDialogElement>(null);
  const [dialogs, setDialogs] = useState<Awaited<
    ReturnType<typeof loadDialogs>
  > | null>(null);
  // The body renders (synchronously) before showModal, so the dialog never opens empty.
  const openDialog = (dialog: { current: HTMLDialogElement | null }) => {
    const trigger = document.activeElement;
    void loadDialogs().then((module) => {
      flushSync(() => setDialogs(module));
      openModal(dialog.current, trigger);
    });
  };
  const [pair, setPair] = useState<BridgePairChoice>(DEFAULT_PAIR);
  const [pairPicker, setPairPicker] = useState(false);
  const pairTrigger = useRef<HTMLButtonElement | null>(null);
  const [multiRoute, setMultiRoute] = useState<MultichainRouteState>();
  // Guardian's verdict on the current multichain quote (reported by the side panel); the route review is gated on it.
  const [bridgeGuardian, setBridgeGuardian] =
    useState<BridgeGuardianState | null>(null);
  const warmDialogs = () => void loadDialogs();
  const generation = useRef(0);
  const localBusy = useRef(false);
  const balanceGeneration = useRef(0);
  // G12 H04 (owner playtest P3): the pair shown first is the legacy ONEchain -> BNB Smart Chain route. In read-only
  // mainnet mode its own health check pauses it (a blocked route; quotes answer 422). The paused route then says so
  // and offers a button that opens a pair whose routes can be read (Base -> Arbitrum). It is the user's action:
  // nothing changes the pair on its own, and the legacy pair stays selectable in the network picker.
  const [pairBusy, setPairBusy] = useState(false);
  async function openReadablePair() {
    setPairBusy(true);
    try {
      const { readCatalog } = await import("../routing/client");
      const current = await readCatalog(AbortSignal.timeout(15000));
      const source = current.networks.find((n) => n.id === "8453"),
        destination = current.networks.find((n) => n.id === "42161");
      if (!source || !destination) return;
      setCatalog(current);
      generation.current++;
      setBusy(false);
      setQuote(undefined);
      reviewDialog.current?.close();
      setSourceNetwork(source);
      setDestinationNetwork(destination);
    } catch {
      // The catalog could not be read: the legacy pair stays, with its own blocked state shown.
    } finally {
      setPairBusy(false);
    }
  }
  function selectNetwork(network: Network) {
    generation.current++;
    setBusy(false);
    setQuote(undefined);
    reviewDialog.current?.close();
    if (networkPicker === "source") setSourceNetwork(network);
    else setDestinationNetwork(network);
  }
  const t = (key: TextKey | MessageKey) =>
    translate(
      key.includes(".")
        ? (key as MessageKey)
        : (`product.${key}` as MessageKey),
    );
  const explain = (code: string) => errorMessage(lang, code);
  const stateName = (state: string) => stateMessage(lang, state);
  const updateHealth = useCallback(async () => {
    setHealthBusy(true);
    try {
      setHealth(await api({ action: "health" }));
    } catch (e) {
      setHealth({
        mode,
        observedAt: Date.now(),
        status: "unknown",
        reasons: [errorCode(e)],
      });
    } finally {
      setHealthBusy(false);
    }
  }, [mode]);
  useEffect(() => {
    const appearance = localStorage.getItem("otherbridge.theme");
    queueMicrotask(() => {
      setTheme(appearance === "light" ? "light" : "dark");
      setPreferencesReady(true);
    });
    const sync = () => {
      const h = readHistory();
      setHistoryClaims(h.records);
      if (h.error) setError(h.error);
    };
    queueMicrotask(sync);
    fetch("/api/bridge")
      .then((r) => r.json())
      .then((c) => {
        setMode(c.mode);
        setConfigReady(true);
      })
      .catch(() => setError("PROVIDER_UNAVAILABLE"));
    window.addEventListener("storage", sync);
    window.addEventListener("otherbridge:history", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("otherbridge:history", sync);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = lang;
    if (preferencesReady) {
      localStorage.setItem("otherbridge.theme", theme);
      // V1.10: colour transitions start only after the stored theme replaced the server-rendered default
      // (two frames: the first one paints the stored theme without animation).
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          document.documentElement.dataset.ready = "1";
        }),
      );
    }
  }, [lang, theme, preferencesReady]);
  useEffect(() => {
    if (configReady) queueMicrotask(() => void updateHealth());
  }, [configReady, updateHealth]);
  // The route review waits for Guardian's verdict: load its chunk with the multichain Bridge, not after the quote.
  useEffect(() => {
    if (path === "/bridge" && !legacyPair)
      void import("./guardian-surfaces").catch(() => {});
  }, [path, legacyPair]);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  const invalidate = useCallback(() => {
    setPortfolio(undefined);
    setPortfolioIdentity({});
    setPortfolioPrefill(undefined);
    setGuardianPrefill(undefined);
    setRoutingWalletRevision((v) => v + 1);
    generation.current++;
    setBusy(false);
    balanceGeneration.current++;
    setQuote(undefined);
    setBalances(undefined);
    reviewDialog.current?.close();
    setError("IDENTITY_CHANGED");
  }, []);
  // Any identity change of the active wallet (account, chain, reconnect, disconnect, new epoch) invalidates the
  // quote, review, balances and portfolio scan bound to the previous identity.
  useEffect(
    () =>
      walletStore.subscribe(() => {
        const next = walletStore.get();
        const identity =
          next.status === "connected" && next.provider
            ? `${next.address.toLowerCase()}|${next.chainId}|${next.epoch}`
            : "";
        const previous = boundIdentity.current;
        boundIdentity.current = identity;
        if (next.status === "unavailable") {
          if (previous) invalidate();
          rebinding.current = false;
          setError(next.reason || "WALLET_UNAVAILABLE");
          return;
        }
        if (identity === previous) return;
        if (!identity) {
          if (previous) {
            invalidate();
            rebinding.current = next.status === "connecting";
          }
          if (next.status === "disconnected") {
            rebinding.current = false;
            if (previous || next.reason) setError(next.reason);
          }
          return;
        }
        // Connected (fresh, or re-bound after an account/chain change): nothing from before may be reused.
        generation.current++;
        setBusy(false);
        setQuote(undefined);
        setRoutingWalletRevision((v) => v + 1);
        if (previous) invalidate();
        else if (!rebinding.current) {
          setError("");
          walletDialog.current?.close();
        }
        rebinding.current = false;
      }),
    [invalidate],
  );
  useEffect(() => {
    if (!account) return;
    const request = ++balanceGeneration.current;
    api({ action: "balance", account })
      .then((data) => {
        if (request === balanceGeneration.current) {
          const snapshot = balanceSchema.parse(data);
          setBalances(snapshot);
          if (snapshot.sourceCode !== "0x" || snapshot.destinationCode !== "0x")
            setError("UNSUPPORTED_ACCOUNT");
        }
      })
      .catch((e) => {
        if (request === balanceGeneration.current) setError(errorCode(e));
      });
  }, [account, chain, mode]);
  const activeRecord = path.startsWith("/activity/")
    ? records.find((r) => r.id === path.split("/")[2])
    : undefined;
  useEffect(() => {
    if (!path.startsWith("/activity/")) return;
    const id = path.split("/")[2];
    let cancelled = false;
    let running = false;
    const tick = async () => {
      if (document.hidden || running) return;
      running = true;
      try {
        const history = readHistory();
        if (history.error) throw new BridgeError(history.error);
        const claim = history.records.find((record) => record.id === id);
        if (!claim || claim.mode !== mode) return;
        const raw = await api({ action: "track", record: claim });
        if (cancelled) return;
        const latest = readHistory();
        if (latest.error) throw new BridgeError(latest.error);
        const latestClaim = latest.records.find((record) => record.id === id);
        if (!latestClaim) return;
        const updated = historyView.accept(latestClaim, raw);
        if (
          !cancelled &&
          JSON.stringify(updated) !== JSON.stringify(latestClaim)
        )
          await saveRecord(updated);
      } catch (e) {
        if (!cancelled) setError(errorCode(e));
      } finally {
        running = false;
      }
    };
    const timer = setInterval(tick, mode === "local-test" ? 1200 : 15000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, mode, historyView]);
  function openWallet() {
    if (!WALLET_LAYER_READY) {
      // VWP G09: no wallet layer is configured in this build (no valid Privy App ID and no RainbowKit opt-in). That is
      // a missing setting, not an outage, so it is named as such; nothing loads and nothing falls back.
      walletStore.unavailable("WALLET_NOT_CONFIGURED");
      return;
    }
    setError("");
    if (!layerRequested) {
      if (session.status !== "unavailable")
        walletStore.set({ ...walletStore.get(), status: "loading" });
      setLayerRequested(true);
    }
    walletStore.open();
  }
  function changeWallet() {
    walletDialog.current?.close();
    openWallet();
  }
  async function switchNetwork(add = false) {
    if (!adapter) return;
    setError("");
    try {
      // A separate user action; the session re-binds on chainChanged and every review is re-run afterwards.
      if (add) await adapter.addChain(612055);
      else await adapter.switchChain(mode === "local-test" ? 31337 : 612055);
    } catch (e) {
      if (walletStore.get().provider === adapter) setError(errorCode(e));
    }
  }
  async function getQuote() {
    setError("");
    setQuote(undefined);
    const epoch = ++generation.current;
    setBusy(true);
    try {
      const requestedAmount = parseAmount(canonicalAmount(amount));
      const q = quoteFromWire(
        await api({
          action: "quote",
          account,
          amount: canonicalAmount(amount),
        }),
      );
      validateQuote(q, account, chain ?? 0, Date.now(), requestedAmount);
      if (q.mode !== mode) throw new BridgeError("MODE_MISMATCH");
      if (epoch === generation.current) setQuote(q);
    } catch (e) {
      if (epoch === generation.current) setError(errorCode(e));
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }
  function changeAmount(value: string) {
    generation.current++;
    setAmount(value);
    setQuote(undefined);
    setBusy(false);
    setError("");
    reviewDialog.current?.close();
  }
  async function localRun() {
    if (localBusy.current || !quote || !balances) return;
    localBusy.current = true;
    setError("");
    try {
      if (mode !== "local-test" || quote.mode !== "local-test")
        throw new BridgeError("MAINNET_WRITE_DISABLED");
      validateQuote(
        quote,
        account,
        chain ?? 0,
        Date.now(),
        parseAmount(canonicalAmount(amount)),
      );
      preflight(
        quote,
        {
          mode: "local-test",
          source: "0x1111111111111111111111111111111111111111",
          destination: "0x2222222222222222222222222222222222222222",
          verified: true,
          nativeSentinel: "0x0000000000000000000000000000000000000001",
          sourceChain: 31337,
          destinationChain: 31338,
          config: "1",
        },
        {
          account,
          chain: chain ?? 0,
          balance: BigInt(balances.balance),
          sourceCode: balances.sourceCode,
          destinationCode: balances.destinationCode,
          healthFresh: true,
          reserveKnown: true,
          paused: false,
          simulation: true,
        },
      );
      const record: TransferRecord = {
        schema: 1,
        id: crypto.randomUUID(),
        mode: "local-test",
        route: ROUTE.id,
        config: "1",
        sourceChain: 31337,
        destinationChain: 31338,
        account,
        recipient: account,
        sourceAsset: "native:ONE",
        token: CROSS,
        amount: quote.amount.toString(),
        expected: quote.expected.toString(),
        sourceHash: `0x${"a".repeat(64)}`,
        state: "SOURCE_SUBMITTED",
        index: "7",
        updatedAt: Date.now(),
      };
      await saveRecord(record);
      reviewDialog.current?.close();
      setQuote(undefined);
      router.push(`/activity/${record.id}`);
    } catch (e) {
      setError(errorCode(e));
    } finally {
      localBusy.current = false;
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setError("PROVIDER_UNAVAILABLE");
    }
  }
  async function importFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 150000) throw new BridgeError("IMPORT_TOO_LARGE");
      await importHistory(await file.text());
    } catch (err) {
      setError(err instanceof BridgeError ? err.code : "INVALID_REQUEST");
    }
    e.target.value = "";
  }
  async function recover(
    event: FormEvent<HTMLFormElement>,
    activeRecord: TransferRecord,
  ) {
    event.preventDefault();
    if (recoveryBusy) return;
    const candidate = String(
      new FormData(event.currentTarget).get("sourceHash") ?? "",
    );
    setRecoveryBusy(true);
    setError("");
    try {
      const claim = await attachSourceHash(activeRecord.id, candidate);
      const raw = await api({
        action: "track",
        record: claim,
      });
      const current = readHistory();
      if (current.error) throw new BridgeError(current.error);
      const latest = current.records.find((record) => record.id === claim.id);
      if (!latest) throw new BridgeError("INVALID_REQUEST");
      const observed = historyView.accept(latest, raw);
      await saveRecord(observed);
      setNow(Date.now());
    } catch (e) {
      setError(e instanceof BridgeError ? e.code : "INVALID_REQUEST");
    } finally {
      setRecoveryBusy(false);
    }
  }
  async function watchCross(wallet: NonNullable<typeof adapter>) {
    try {
      if ((await wallet.identity()).chainId !== 56)
        throw new BridgeError("IDENTITY_CHANGED");
      await wallet.watchCanonicalCross();
    } catch (e) {
      if (walletStore.get().provider === wallet) setError(errorCode(e));
    }
  }
  const row = (label: string, value: ReactNode, className?: string) => (
    <div className={className ? `data-row ${className}` : "data-row"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
  const address = (value: string) => (
    <div className="address">
      <code dir="ltr">{value}</code>
      <button className="small copy-button" onClick={() => void copy(value)}>
        <Icon name={copied === value ? "check" : "copy"} size={14} />
        {copied === value ? t("copied") : t("copy")}
      </button>
    </div>
  );
  const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
  const quoteValid = (() => {
    if (!quote || quote.mode !== mode) return false;
    try {
      validateQuote(
        quote,
        account,
        chain ?? 0,
        now,
        parseAmount(canonicalAmount(amount)),
      );
      return true;
    } catch {
      return false;
    }
  })();
  const quoteSeconds = quote
    ? Math.max(0, Math.ceil((quote.expiresAt - now) / 1000))
    : 0;
  const rightChain = chain === (mode === "local-test" ? 31337 : 612055);
  const modeBadge = (
    <span className={`badge ${mode === "local-test" ? "test" : "live"}`}>
      <span className="dot" />
      {mode === "local-test" ? t("local") : t("readonly")}
    </span>
  );
  const routeVerified = G5_STATUS === "PASS" && mode === "mainnet-readonly";
  const views = [
    "/app",
    "/bridge",
    "/swap",
    "/portfolio",
    "/points",
    "/guardian",
    "/activity",
    "/scan",
    "/networks",
    "/help",
    "/about",
    "/settings",
  ];
  if (!views.includes(path) && !path.startsWith("/activity/")) return children;
  const stateTone = (state: string) =>
    state === "COMPLETED"
      ? "ok"
      : [
            "SOURCE_REVERTED",
            "FAILED",
            "REORG_DETECTED",
            "UNVERIFIED_COMPLETION",
            "MANUAL_ACTION_REQUIRED",
            "SUBMISSION_UNKNOWN",
          ].includes(state)
        ? "danger"
        : "warn";
  const kit: ViewKit = {
    t,
    lang,
    row,
    address,
    short,
    formatAmount,
    explain,
    stateName,
    stateTone,
  };
  // V1.11 simplified side panels (route summary + one route-health state).
  const healthFresh = !!health && now - health.observedAt < 60_000;
  const multiQuote = multiRoute?.quote;
  const routeSummary: RouteSummary = legacyPair
    ? {
        source: sourceNetwork,
        destination: destinationNetwork,
        fromSymbol: pair.fromSymbol,
        toSymbol: pair.toSymbol,
        receive:
          quote && quoteValid
            ? `${formatAmount(quote.expected)} ${pair.toSymbol}`
            : null,
        fee:
          quote && quoteValid
            ? `${formatAmount(quote.networkFee + quote.serviceFee)} ONE`
            : null,
        time: null,
        details: () => (
          <LegacyRouteDetails
            t={translate as never}
            quote={quote}
            pair={pair}
          />
        ),
      }
    : {
        source: sourceNetwork,
        destination: destinationNetwork,
        fromSymbol: multiRoute?.from.symbol ?? sourceNetwork.nativeAsset.symbol,
        toSymbol:
          multiRoute?.to.symbol ?? destinationNetwork.nativeAsset.symbol,
        receive:
          multiQuote && multiRoute?.valid
            ? `${formatTokenAmount(BigInt(multiQuote.expected), multiRoute.to.decimals, lang, 6)} ${multiRoute.to.symbol}`
            : null,
        fee:
          multiQuote && multiRoute?.valid
            ? multiQuote.fees.every((f) => f.usd !== undefined)
              ? formatUsd(
                  multiQuote.fees.reduce((sum, f) => sum + Number(f.usd), 0),
                  lang,
                )
              : multiQuote.fees
                  .map(
                    (f) =>
                      `${formatTokenAmount(BigInt(f.amount), f.asset.decimals, lang, 6)} ${f.asset.symbol}`,
                  )
                  .join(" + ") || "0"
            : null,
        time:
          multiQuote && multiRoute?.valid
            ? translate("ui.seconds", {
                count: new Intl.NumberFormat(lang).format(
                  Math.ceil(multiQuote.duration),
                ),
              })
            : null,
        details: () => (
          <MultiRouteDetails
            t={translate as never}
            lang={lang}
            quote={multiQuote}
            source={sourceNetwork}
            destination={destinationNetwork}
          />
        ),
      };
  const routeHealth: RouteHealth = legacyPair
    ? {
        state:
          !health || (health.status === "unknown" && !health.limits)
            ? healthBusy
              ? "refresh"
              : "unavailable"
            : !healthFresh || (quote && !quoteValid)
              ? "refresh"
              : mode === "local-test"
                ? "ready"
                : executionGate.enabled && pair.verified
                  ? "ready"
                  : "disabled",
        rows: [
          {
            icon: "shield",
            label: t("v111.routeVerification"),
            value:
              mode === "local-test"
                ? t("local")
                : routeVerified && pair.verified
                  ? t("v110.g5Verified")
                  : t("notVerified"),
            ok: mode === "local-test" ? null : routeVerified && pair.verified,
          },
          {
            icon: "layers",
            label: t("v111.liquidityReserve"),
            value: health?.limits
              ? health.limits.reserveVerified
                ? t("v110.verified")
                : t("unverified")
              : t("unknown"),
            ok: health?.limits ? health.limits.reserveVerified : null,
          },
          {
            icon: "clock",
            label: t("v111.liveData"),
            value: quote
              ? quoteValid
                ? translate("v110.validFor", {
                    count: new Intl.NumberFormat(lang).format(quoteSeconds),
                  })
                : t("v111.quoteExpired")
              : healthFresh
                ? t("v111.fresh")
                : t("v111.stale"),
            ok: quote ? quoteValid : healthFresh,
          },
        ],
        safety: () => (
          <LegacySafetyDetails
            t={translate as never}
            lang={lang}
            health={health}
            onRefresh={() => void updateHealth()}
            refreshing={healthBusy}
          />
        ),
      }
    : {
        state:
          !multiRoute || multiRoute.connection === "loading"
            ? "refresh"
            : multiRoute.connection !== "available" || multiRoute.blocked
              ? "unavailable"
              : multiQuote && !multiRoute.valid
                ? "refresh"
                : executionGate.enabled
                  ? "ready"
                  : "disabled",
        rows: [
          {
            icon: "route",
            label: t("v111.routeVerification"),
            value:
              multiRoute?.connection === "available"
                ? t("v111.routeListed")
                : multiRoute?.connection === "none"
                  ? t("ui.noConnection")
                  : t("unknown"),
            ok:
              multiRoute?.connection === "available"
                ? true
                : multiRoute?.connection === "none"
                  ? false
                  : null,
          },
          {
            icon: "layers",
            label: t("v111.liquidityReserve"),
            value: multiQuote ? t("v111.quoted") : t("v110.afterQuote"),
            ok: multiQuote ? true : null,
          },
          {
            icon: "clock",
            label: t("v111.liveData"),
            value: multiQuote
              ? multiRoute?.valid
                ? t("v111.fresh")
                : t("v111.quoteExpired")
              : t("v110.quoteMissing"),
            ok: multiQuote ? !!multiRoute?.valid : null,
          },
        ],
        safety: () => (
          <MultiSafetyDetails
            t={translate as never}
            lang={lang}
            quote={multiQuote}
            checkedAt={multiRoute?.checkedAt ?? null}
          />
        ),
      };
  const navItem = (
    href: string,
    key: TextKey | MessageKey,
    glyph: NavGlyphName,
  ) => ({
    href,
    label: t(key),
    glyph,
  });
  /** Open a Guardian chat draft in Swap or Bridge: exact tokens and amount fill the normal screen. Nothing is quoted,
   * approved, signed or sent; the networks come from the routing catalog (read only if it is not loaded yet). */
  const openGuardianDraft = async (d: ChatDraft): Promise<boolean> => {
    if (
      d.kind === "near" ||
      d.pay.decimals === null ||
      d.receive.decimals === null
    )
      return false;
    let current = catalog;
    if (!current) {
      try {
        const { readCatalog } = await import("../routing/client");
        current = await readCatalog(AbortSignal.timeout(15000));
        setCatalog(current);
      } catch {
        return false;
      }
    }
    const source = current.networks.find((n) => n.id === d.pay.chainId),
      destination = current.networks.find((n) => n.id === d.receive.chainId);
    if (!source || !destination) return false;
    const asset = (token: ResolvedToken, network: Network): Asset =>
      token.native
        ? network.nativeAsset
        : {
            chainId: network.id,
            address: token.address,
            symbol: token.symbol,
            name: token.name ?? token.symbol,
            decimals: token.decimals ?? 18,
          };
    const [int, frac] = d.amount.split(".");
    setGuardianPrefill({
      id: d.id,
      sourceId: source.id,
      destinationId: destination.id,
      from: asset(d.pay, source),
      to: asset(d.receive, destination),
      // Three decimal places read as a thousands group in some locales: one trailing zero keeps the value exact.
      amount: frac?.length === 3 ? `${int}.${frac}0` : d.amount,
    });
    if (d.kind === "bridge") {
      generation.current++;
      setBusy(false);
      setQuote(undefined);
      setSourceNetwork(source);
      setDestinationNetwork(destination);
    }
    router.push(d.kind === "swap" ? "/swap" : "/bridge");
    return true;
  };
  const guardianBalance = (
    chainId: string,
    symbol: string,
    address?: string,
  ) => {
    if (!account || !portfolio) return null;
    const h = portfolio.holdings.find(
      (x) =>
        x.chainId === chainId &&
        !x.spam &&
        (address
          ? x.address.toLowerCase() === address.toLowerCase()
          : x.native && x.symbol.toUpperCase() === symbol.toUpperCase()),
    );
    return h ? displayUnits(h.balance, h.decimals) : null;
  };
  return (
    <div className="app-shell">
      <a className="skip" href="#main">
        {t("ui.skipToContent")}
      </a>
      {/* Abyssal layer: one shared underwater world; each route frames a different part of the organism. */}
      <AbyssField
        scene={abyssScene(path)}
        tint={sceneClasses(sourceNetwork.theme, destinationNetwork.theme)}
      />
      <header className="header">
        <div className="header-inner">
          <Link href="/" className="brand" aria-label={brand.name}>
            <BrandLogo decorative />
            <BrandMark />
            <span className="version">
              {pilot && G7LocalPilotBadge ? `${brand.historicalName} G7` : "V1"}
            </span>
          </Link>
          {/* V1.22 UX: every destination stays a direct link on desktop (rail); narrow screens keep the primary
              tools in the tab bar and open the rest from "More". Guardian-first (gf1): Guardian is the protection
              layer, so it sits right after Overview and ahead of Swap and Bridge; Points stays a separate secondary
              destination, never coupled to Guardian. */}
          <AppNav
            path={path}
            label={t("ui.mainNavigation")}
            moreLabel={t("ux.more")}
            primary={[
              navItem("/app", "v119.overview", "home"),
              navItem("/guardian", "guardian.nav", "guardian"),
              navItem("/swap", "v13.swap", "swap"),
              navItem("/bridge", "bridge", "bridge"),
              navItem("/portfolio", "v13.portfolio", "portfolio"),
            ]}
            secondary={[
              navItem("/activity", "activity", "activity"),
              navItem("/scan", "g12.scan.nav", "scan"),
              navItem("/networks", "networks", "networks"),
              navItem("/help", "help", "help"),
              navItem("/points", "points.nav", "points"),
            ]}
          />
          <div className="header-actions">
            {!pilot && (
              <span className="shell-status" title={t("landing.statusNote")}>
                <Icon name="lock" size={14} />
                <span className="shell-status-text">{t("v115.closed")}</span>
              </span>
            )}
            {mode === "local-test" && (
              <span
                className="header-status tone-warn"
                title={t("v110.statusTitle")}
              >
                <span className="pill-dot" aria-hidden="true" />
                {t("v110.localShort")}
              </span>
            )}
            <LanguageSelector />
            <button
              className="icon-button theme-toggle"
              aria-label={t("theme")}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
            </button>
            {connected ? (
              <button
                className="wallet-button is-connected"
                aria-haspopup="dialog"
                onPointerEnter={warmDialogs}
                onFocus={warmDialogs}
                onClick={() => openDialog(walletDialog)}
              >
                <WalletIconView session={session} />
                <span className="wallet-name">{session.walletName}</span>
                <span className="wallet-address" dir="ltr">
                  {short(account)}
                </span>
                <span className="wallet-chain">
                  <span className="pill-dot" aria-hidden="true" />
                  {chainLabel(chain)}
                </span>
              </button>
            ) : (
              <button
                className="wallet-button"
                aria-haspopup="dialog"
                aria-busy={
                  session.status === "loading" ||
                  session.status === "connecting"
                }
                onClick={openWallet}
              >
                <Icon name="wallet" size={17} />
                <span className="wallet-label">
                  {session.status === "connecting"
                    ? t("connecting")
                    : t("connect")}
                </span>
              </button>
            )}
          </div>
        </div>
      </header>
      <main
        id="main"
        className={`main veined-app ${sceneClasses(sourceNetwork.theme, destinationNetwork.theme)}`}
        data-surface={path.split("/")[1]}
      >
        {path === "/app" && (
          <AppOverview
            account={account}
            hasPortfolio={Boolean(portfolio)}
            onConnect={openWallet}
          />
        )}
        {error && (
          <div className="notice error" role="alert">
            {explain(error)}
            <button
              className="icon-button notice-close"
              aria-label={t("close")}
              onClick={() => setError("")}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {path === "/bridge" && (
          <>
            <div className="intro">
              <h1>
                {t("title")
                  .split("\n")
                  .map((line, i) => (
                    <span key={line}>
                      {line}
                      {i === 0 && <br />}
                    </span>
                  ))}
              </h1>
              <p>
                {routeKind === "near"
                  ? translate("g12.nr.kindNearHint")
                  : legacyPair
                    ? t("subtitle")
                    : t("ui.chooseNetworksAndAssetsReadCurrent")}
              </p>
            </div>
            {account && (
              <Link href="/portfolio" className="portfolio-home">
                <span className="portfolio-home-icon" aria-hidden="true">
                  <Icon name="layers" size={18} />
                </span>
                <span className="portfolio-home-text">
                  <strong>{t("v13.portfolio")}</strong>
                  <span>
                    {portfolio
                      ? `${
                          new Set(
                            portfolio.holdings
                              .filter((h) => !h.spam && BigInt(h.balance) > 0n)
                              .map((h) => h.chainId),
                          ).size
                        } ${t("v13.chains")} · ${formatUsd(detectedValue(portfolio.holdings), lang)}`
                      : t("v13.findFunds")}
                  </span>
                </span>
                <Icon name="chevronRight" className="flip-rtl" />
              </Link>
            )}
            <RouteKindSwitch
              kind={routeKind}
              onChange={setRouteKind}
              mode="bridge"
            />
            {routeKind === "near" ? (
              <div className="bridge-grid near-route-grid">
                <NearRoute
                  account={account}
                  walletChain={chain}
                  mode="bridge"
                  onConnect={openWallet}
                />
              </div>
            ) : (
              <div className="bridge-grid">
                <section className="card bridge-card" aria-label={t("bridge")}>
                  <div className="card-top">
                    <h2>{t("bridge")}</h2>
                    {legacyPair && pilot && G7LocalPilotBadge ? (
                      <G7LocalPilotBadge />
                    ) : (
                      mode === "local-test" && modeBadge
                    )}
                  </div>
                  {!(legacyPair && pilot && G7LocalPilotBridge) && (
                    <details className="disclosure mode-disclosure">
                      <summary>{t("v111.sendingDisabled")}</summary>
                      <p className="mode-note">
                        {legacyPair
                          ? mode === "local-test"
                            ? t("localNote")
                            : t("liveNote")
                          : t("ui.readCurrentRoutingDataSigningApprovals")}
                      </p>
                    </details>
                  )}
                  <div className="route-pair">
                    <button
                      className={`network-box network-tinted network-select-trigger ${chainThemeClass(sourceNetwork)}`}
                      data-network={sourceNetwork.key}
                      aria-label={t("ui.selectSourceNetwork")}
                      aria-haspopup="dialog"
                      onClick={(event) => {
                        networkTrigger.current = event.currentTarget;
                        setNetworkPicker("source");
                      }}
                    >
                      <ChainLogo network={sourceNetwork} />
                      <div>
                        <span className="micro network-role">
                          {t("v111.from")}
                        </span>
                        <strong>{sourceNetwork.name}</strong>
                        <small>
                          {legacyPair
                            ? "ONE"
                            : sourceNetwork.nativeAsset.symbol}
                          {!sourceNetwork.mainnet && (
                            <span className="env-tag">{t("v111.testnet")}</span>
                          )}
                        </small>
                      </div>
                      <span className="network-id">
                        {legacyPair && mode === "local-test"
                          ? "31337"
                          : sourceNetwork.id}
                      </span>
                      <Icon name="chevronDown" className="selector-chevron" />
                    </button>
                    <div
                      className="direction-arrow"
                      role="img"
                      aria-label={t("direction")}
                    >
                      <Icon name="arrowDown" size={16} />
                    </div>
                    <button
                      className={`network-box network-tinted network-select-trigger ${chainThemeClass(destinationNetwork)}`}
                      data-network={destinationNetwork.key}
                      aria-label={t("ui.selectDestinationNetwork")}
                      aria-haspopup="dialog"
                      onClick={(event) => {
                        networkTrigger.current = event.currentTarget;
                        setNetworkPicker("destination");
                      }}
                    >
                      <ChainLogo network={destinationNetwork} />
                      <div>
                        <span className="micro network-role">
                          {t("v1122.to")}
                        </span>
                        <strong>{destinationNetwork.name}</strong>
                        <small>
                          {legacyPair
                            ? pair.toSymbol
                            : destinationNetwork.nativeAsset.symbol}
                          {!destinationNetwork.mainnet && (
                            <span className="env-tag">{t("v111.testnet")}</span>
                          )}
                        </small>
                      </div>
                      <span className="network-id">
                        {legacyPair && mode === "local-test"
                          ? "31338"
                          : destinationNetwork.id}
                      </span>
                      <Icon name="chevronDown" className="selector-chevron" />
                    </button>
                  </div>
                  {legacyPair && pilot && G7LocalPilotBridge ? (
                    <G7LocalPilotBridge
                      gate={pilot}
                      wallet={adapter}
                      walletId={connected ? session.walletId : ""}
                      account={account}
                      chain={chain}
                      liveBalance={
                        balances ? BigInt(balances.balance) : undefined
                      }
                      openWallet={openWallet}
                      switchToOneChain={() => void switchNetwork()}
                      addOneChain={() => void switchNetwork(true)}
                      t={(key) => t(key as TextKey)}
                    />
                  ) : legacyPair ? (
                    <>
                      {mode === "mainnet-readonly" &&
                        health?.status === "blocked" && (
                          <div
                            className="notice tone-warn paused-route"
                            data-testid="paused-route"
                          >
                            <p>{translate("g12.br.paused")}</p>
                            <button
                              type="button"
                              className="small"
                              disabled={pairBusy}
                              onClick={() => void openReadablePair()}
                            >
                              {translate("g12.br.openReadable")}
                            </button>
                          </div>
                        )}
                      <div className="amount-field">
                        <div className="amount-label">
                          <label htmlFor="amount">{t("amount")}</label>
                          <span>
                            {t("balance")}:{" "}
                            <bdi dir="ltr">
                              {balances
                                ? `${formatAmount(BigInt(balances.balance))} ONE`
                                : "—"}
                            </bdi>
                          </span>
                        </div>
                        <div className="amount-input">
                          <input
                            id="amount"
                            inputMode="decimal"
                            autoComplete="off"
                            value={amount}
                            placeholder="0.00"
                            aria-describedby="amount-hint"
                            onChange={(e) => changeAmount(e.target.value)}
                          />
                          <button
                            type="button"
                            ref={pairTrigger}
                            className="amount-token token-select"
                            aria-haspopup="dialog"
                            aria-label={`${t("v111.selectAsset")} · ${pair.fromSymbol}`}
                            onClick={() => setPairPicker(true)}
                          >
                            {pair.fromSymbol === "ONE" ? (
                              <NetworkLogo id="onechain" size="sm" />
                            ) : null}
                            {pair.fromSymbol}
                            <Icon name="chevronDown" size={14} />
                          </button>
                          <button
                            className="max-button"
                            disabled={!balances || mode !== "local-test"}
                            onClick={() => {
                              if (balances) {
                                changeAmount(
                                  canonicalTokenAmount(
                                    maximum(
                                      BigInt(balances.balance),
                                      10n ** 15n,
                                      (v) => 10n ** 16n + v / 1000n,
                                      99n * 10n ** 18n,
                                    ),
                                    18,
                                  ),
                                );
                              }
                            }}
                          >
                            {t("max")}
                          </button>
                        </div>
                        <details className="amount-help">
                          <summary>{t("v1122.amountHelp")}</summary>
                          <p id="amount-hint" className="input-hint">
                            {t("amountHint")}
                          </p>
                        </details>
                      </div>
                      {!pair.verified && (
                        <p className="notice tone-warn" role="status">
                          <strong>{t("v111.noVerifiedRoute")}</strong>{" "}
                          {translate("v111.registeredNotVerified", {
                            from: pair.fromSymbol,
                            to: pair.toSymbol,
                          })}
                        </p>
                      )}
                      {account && (
                        <div className="recipient">
                          <span className="micro">
                            {t("recipient")} · {t("same")}
                          </span>
                          <code dir="ltr" title={account}>
                            {short(account)}
                          </code>
                        </div>
                      )}
                      {account && !rightChain && (
                        <div className="notice tone-warn">
                          <p>{t("wrongChain")}</p>
                          <div className="notice-buttons">
                            <button
                              className="secondary"
                              onClick={() => void switchNetwork()}
                            >
                              {t("switch")}
                            </button>
                            {mode !== "local-test" && (
                              <button
                                className="small"
                                onClick={() => void switchNetwork(true)}
                              >
                                {t("addChain")}
                              </button>
                            )}
                          </div>
                          <p className="input-hint">{t("networkNote")}</p>
                        </div>
                      )}
                      {/* Deep refinement: delivery, fee and its breakdown read as one receipt. */}
                      <div className="bridge-receipt">
                        <div className="bridge-receive">
                          {row(
                            t("receive"),
                            quote
                              ? `${formatAmount(quote.expected)} CROSS`
                              : "—",
                          )}
                        </div>
                        <div className="bridge-fee-total">
                          {row(
                            t("v111.fee"),
                            quote
                              ? `${formatAmount(quote.networkFee + quote.serviceFee)} ONE`
                              : "—",
                          )}
                        </div>
                        <details className="fees">
                          <summary className="fees-head">
                            <span>{t("v110.feeBreakdown")}</span>
                            {quote && quoteValid ? (
                              <span className="pill tone-ok">
                                <Icon name="clock" size={13} />
                                {translate("v110.validFor", {
                                  count: new Intl.NumberFormat(lang).format(
                                    quoteSeconds,
                                  ),
                                })}
                              </span>
                            ) : (
                              !quote && (
                                <span className="fees-hint">
                                  {t("v110.afterQuote")}
                                </span>
                              )
                            )}
                          </summary>
                          {row(
                            t("fee"),
                            quote
                              ? `${formatAmount(quote.networkFee)} ONE`
                              : t("unknown"),
                          )}
                          {row(
                            t("serviceFee"),
                            quote
                              ? `${formatAmount(quote.serviceFee)} ONE`
                              : t("unknown"),
                          )}
                          {row(
                            t("gas"),
                            quote
                              ? `${formatAmount(quote.gasBudget)} ONE`
                              : t("unknown"),
                          )}
                          {row(t("ourFee"), "0 ONE", "is-zero-fee")}
                        </details>
                      </div>
                      {quote && !quoteValid && (
                        <p className="notice" role="status">
                          {explain("QUOTE_EXPIRED")}
                        </p>
                      )}
                      {!account ? (
                        <button className="primary" onClick={openWallet}>
                          {t("connect")} <Icon name="wallet" size={18} />
                        </button>
                      ) : quoteValid ? (
                        <button
                          className="primary"
                          onPointerEnter={warmDialogs}
                          onFocus={warmDialogs}
                          onClick={() => openDialog(reviewDialog)}
                        >
                          {t("review")}{" "}
                          <Icon
                            name="arrowRight"
                            size={18}
                            className="flip-rtl"
                          />
                        </button>
                      ) : (
                        <button
                          className="primary"
                          disabled={
                            busy || !rightChain || !amount || !pair.verified
                          }
                          onClick={() => void getQuote()}
                        >
                          {busy ? t("quoting") : t("quote")}{" "}
                          <Icon
                            name={busy ? "refresh" : "arrowRight"}
                            size={18}
                            className={busy ? "spin" : "flip-rtl"}
                          />
                        </button>
                      )}
                      <p className="under-button">
                        <Icon name="lock" size={13} />
                        {t("writeDisabled")}
                      </p>
                    </>
                  ) : (
                    <MultichainBridge
                      key={`${sourceNetwork.id}:${destinationNetwork.id}:${guardianPrefill?.id ?? ""}`}
                      source={sourceNetwork}
                      destination={destinationNetwork}
                      catalog={catalog}
                      onCatalog={setCatalog}
                      account={account}
                      walletRevision={routingWalletRevision}
                      walletChain={chain}
                      lang={lang}
                      portfolio={portfolio}
                      portfolioIdentity={portfolioIdentity}
                      prefillToken={
                        portfolioPrefill?.network.id === sourceNetwork.id
                          ? portfolioPrefill.token
                          : undefined
                      }
                      guardianDraft={
                        guardianPrefill?.sourceId === sourceNetwork.id &&
                        guardianPrefill.destinationId === destinationNetwork.id
                          ? guardianPrefill
                          : undefined
                      }
                      onRouteState={setMultiRoute}
                      guardian={bridgeGuardian}
                      guardianReview={
                        multiRoute?.quote ? (
                          <GuardianBridge
                            route={multiRoute}
                            source={sourceNetwork}
                            destination={destinationNetwork}
                            account={account}
                            compact={false}
                            testId="guardian-bridge-review"
                          />
                        ) : null
                      }
                    />
                  )}
                </section>
                <aside className="route-side">
                  <RouteSummaryCard
                    t={translate as never}
                    route={routeSummary}
                  />
                  <RouteHealthCard
                    t={translate as never}
                    health={routeHealth}
                  />
                  {!legacyPair && multiRoute?.quote && (
                    <GuardianBridge
                      route={multiRoute}
                      source={sourceNetwork}
                      destination={destinationNetwork}
                      account={account}
                      onVerdict={setBridgeGuardian}
                    />
                  )}
                  <details className="disclosure safety-learn">
                    <summary>{t("safetyTitle")}</summary>
                    <div className="safety">
                      <span className="shield" aria-hidden="true">
                        <Icon name="shield" size={20} />
                      </span>
                      <div>
                        <h3>{t("safetyTitle")}</h3>
                        <p>
                          {legacyPair
                            ? t("safety")
                            : t(
                                "ui.otherbridgeIsAnIndependentTransferInterface",
                              )}
                        </p>
                        <Link href="/about">
                          {t("learn")}
                          <Icon
                            name="arrowRight"
                            size={13}
                            className="flip-rtl"
                          />
                        </Link>
                      </div>
                    </div>
                  </details>
                </aside>
              </div>
            )}
          </>
        )}
        {path === "/activity" && (
          <ActivityView
            kit={kit}
            records={records}
            filter={filter}
            onFilter={setFilter}
            onExport={() => download("otherbridge-history.json", records)}
            onImport={importFile}
          />
        )}
        {path.startsWith("/activity/") &&
          (activeRecord ? (
            <ActivityDetailView
              kit={kit}
              record={activeRecord}
              recoveryBusy={recoveryBusy}
              onRecover={(event) => void recover(event, activeRecord)}
              includePublic={includePublic}
              onIncludePublic={setIncludePublic}
              onDiagnostics={() =>
                download(
                  "otherbridge-diagnostics.json",
                  diagnostic(activeRecord, includePublic),
                )
              }
              onWatch={
                activeRecord.mode === "mainnet-readonly" && adapter
                  ? () => void watchCross(adapter)
                  : undefined
              }
            />
          ) : (
            <ActivityNotFound kit={kit} />
          ))}
        {path === "/networks" && (
          <NetworksView
            kit={kit}
            mode={mode}
            health={health}
            healthBusy={healthBusy}
            onRefresh={() => void updateHealth()}
            routeVerified={routeVerified}
            modeBadge={mode === "local-test" ? modeBadge : null}
            catalog={<MultichainCatalog lang={lang} portfolio={portfolio} />}
          />
        )}
        {path === "/swap" && (
          <Swap
            key={guardianPrefill?.id ?? "swap"}
            guardianDraft={
              guardianPrefill?.sourceId === guardianPrefill?.destinationId
                ? guardianPrefill
                : undefined
            }
            account={account}
            walletRevision={routingWalletRevision}
            walletChain={chain}
            portfolio={portfolio}
            prefill={portfolioPrefill}
            portfolioIdentity={portfolioIdentity}
            onConnect={openWallet}
          />
        )}
        {path === "/portfolio" && (
          <Portfolio
            account={account}
            walletChain={chain}
            result={portfolio}
            onResult={setPortfolio}
            identity={portfolioIdentity}
            onIdentity={setPortfolioIdentity}
            onConnect={openWallet}
            onAction={(network, token, action) => {
              setSourceNetwork(network);
              setGuardianPrefill(undefined);
              setPortfolioPrefill({ network, token });
              router.push(action === "swap" ? "/swap" : "/bridge");
            }}
          />
        )}
        {path === "/points" && (
          <PointsView account={account} onConnect={openWallet} />
        )}
        {path === "/activity" && <RoutingActivity lang={lang} />}
        {path === "/scan" && <ScanView lang={lang} />}
        {path === "/help" && <HelpView />}
        {path === "/guardian" && (
          <GuardianView
            wallet={account || null}
            balanceOf={guardianBalance}
            onOpenDraft={openGuardianDraft}
            onNavigate={(to) => router.push(to)}
          />
        )}
        {path === "/about" && <AboutView kit={kit} />}
        {path === "/settings" && (
          <SettingsView kit={kit} theme={theme} onTheme={setTheme} />
        )}
      </main>
      {pairPicker && (
        <BridgeAssetPicker
          selected={pair.id}
          onSelect={(next: BridgePairChoice) => {
            generation.current++;
            setBusy(false);
            setQuote(undefined);
            setPair(next);
          }}
          onClose={() => {
            setPairPicker(false);
            pairTrigger.current?.focus();
          }}
        />
      )}
      {networkPicker && (
        <NetworkSelector
          role={networkPicker}
          selected={
            networkPicker === "source" ? sourceNetwork : destinationNetwork
          }
          lang={lang}
          catalog={catalog}
          portfolio={portfolio}
          onCatalog={setCatalog}
          onSelect={selectNetwork}
          onClose={() => {
            setNetworkPicker(undefined);
            networkTrigger.current?.focus();
          }}
        />
      )}
      <GuardianDock
        page={guardianPage(path)}
        wallet={account || null}
        balanceOf={guardianBalance}
        onOpenDraft={openGuardianDraft}
        onNavigate={(to) => router.push(to)}
      />
      <footer className="footer">
        <div className="footer-inner">
          <span className="footer-brand">{t("footer")}</span>
          <div className="footer-links">
            {/* V1.22: in the footer, not the main nav — an eighth nav item would wrap the accepted desktop
                header in eight locales; main-nav placement is an owner decision. */}
            <Link href="/points">{t("points.nav")}</Link>
            <Link href="/help">{t("help")}</Link>
            <Link href="/about">{t("about")}</Link>
            <Link href="/settings">{t("settings")}</Link>
          </div>
        </div>
      </footer>
      <dialog
        ref={walletDialog}
        className="wallet-dialog"
        aria-labelledby="wallet-title"
        {...modalProps()}
      >
        <div className="dialog-top">
          <h2 id="wallet-title">{t("wallet")}</h2>
          <button
            className="icon-button"
            aria-label={t("close")}
            onClick={() => walletDialog.current?.close()}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        {dialogs && (
          <dialogs.WalletDialogBody
            t={t}
            connected={connected}
            session={session}
            account={account}
            chainText={`${chainLabel(chain)} · ${chain}`}
            WalletIcon={WalletIconView}
            row={row}
            address={address}
            onChangeWallet={changeWallet}
            onDisconnect={() => {
              walletDialog.current?.close();
              walletStore.disconnect();
            }}
          />
        )}
      </dialog>
      {layerRequested && WALLET_LAYER === "rainbowkit" && (
        <RainbowWalletLayer language={lang} />
      )}
      {layerRequested &&
        WALLET_LAYER === "privy" &&
        validPrivyAppId(PRIVY_APP_ID) && (
          <PrivyWalletLayer
            appId={PRIVY_APP_ID}
            theme={theme === "light" ? "light" : "dark"}
            description={t("walletNote")}
          />
        )}
      <dialog
        ref={reviewDialog}
        className="review-dialog"
        aria-labelledby="review-title"
        {...modalProps()}
      >
        <div className="dialog-top">
          <h2 id="review-title">{t("reviewTitle")}</h2>
          <button
            className="icon-button"
            aria-label={t("close")}
            onClick={() => reviewDialog.current?.close()}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        {dialogs && (
          <dialogs.ReviewDialogBody
            t={t}
            lang={lang}
            quote={quote}
            mode={mode}
            quoteValid={quoteValid}
            bnb={balances ? BigInt(balances.bnb) : undefined}
            error={error}
            explain={explain}
            formatAmount={formatAmount}
            row={row}
            address={address}
            onRun={() => void localRun()}
          />
        )}
      </dialog>
    </div>
  );
}
