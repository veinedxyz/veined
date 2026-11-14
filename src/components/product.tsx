"use client";
import Link from "next/link";
import { NetworkBadge, NetworkLogo, RouteIdentity } from "./network-identity";
import {
  networkIdentity,
  networkStyle,
  routeSceneStyle,
} from "../content/networks";
import { trapDialog } from "./dialog";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";
import {
  messages,
  errors,
  faq,
  stateLabels,
  type Language,
  type TextKey,
} from "../content/messages";
import {
  BridgeError,
  CROSS,
  ROUTE,
  type Health,
  type Mode,
  type Quote,
  type TransferRecord,
} from "../core/model";
import { formatAmount, maximum, parseAmount } from "../core/amounts";
import { preflight, validateQuote } from "../adapters/onebridge";
import {
  connect,
  discover,
  errorCode,
  parseChain,
  requestOnce,
  readWallet,
  type Wallet,
} from "../features/wallet/provider";
import {
  diagnostic,
  download,
  importHistory,
  readHistory,
  saveRecord,
  attachSourceHash,
} from "../storage/history";
import { RuntimeHistoryView } from "../features/bridge/observation";
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
export function Product({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [lang, setLang] = useState<Language>("tr");
  const [theme, setTheme] = useState("dark");
  const [mode, setMode] = useState<Mode>("mainnet-readonly");
  const [configReady, setConfigReady] = useState(false);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [wallet, setWallet] = useState<Wallet>();
  const providerIdentity = useRef(0);
  const [account, setAccount] = useState("");
  const [chain, setChain] = useState<number>();
  const [walletBusy, setWalletBusy] = useState(false);
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
  const generation = useRef(0);
  const walletGeneration = useRef(0);
  const connectionAbort = useRef<AbortController | undefined>(undefined);
  const localBusy = useRef(false);
  const balanceGeneration = useRef(0);
  const t = (key: TextKey) => messages[lang][key];
  const explain = (code: string) =>
    (errors[code] ?? errors.PROVIDER_UNAVAILABLE)[lang === "tr" ? 0 : 1];
  const stateName = (state: string) =>
    (stateLabels[state] ?? [
      state.replaceAll("_", " "),
      state.replaceAll("_", " "),
    ])[lang === "tr" ? 0 : 1];
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
    const language = localStorage.getItem("otherbridge.language");
    const appearance = localStorage.getItem("otherbridge.theme");
    queueMicrotask(() => {
      setLang(
        language === "en" || language === "tr"
          ? language
          : navigator.language.startsWith("tr")
            ? "tr"
            : "en",
      );
      setTheme(appearance === "light" ? "light" : "dark");
      setPreferencesReady(true);
    });
    const sync = () => {
      const h = readHistory();
      setHistoryClaims(h.records);
      if (h.error) setError(h.error);
    };
    queueMicrotask(sync);
    const stop = discover((w) =>
      setWallets((previous) =>
        previous.some((p) => p.id === w.id || p.provider === w.provider)
          ? previous
          : [...previous, w],
      ),
    );
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
      stop();
      window.removeEventListener("storage", sync);
      window.removeEventListener("otherbridge:history", sync);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = lang;
    if (preferencesReady) {
      localStorage.setItem("otherbridge.language", lang);
      localStorage.setItem("otherbridge.theme", theme);
    }
  }, [lang, theme, preferencesReady]);
  useEffect(() => {
    if (configReady) queueMicrotask(() => void updateHealth());
  }, [configReady, updateHealth]);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  const invalidate = useCallback(() => {
    walletGeneration.current++;
    connectionAbort.current?.abort();
    setWalletBusy(false);
    generation.current++;
    setBusy(false);
    balanceGeneration.current++;
    setQuote(undefined);
    setBalances(undefined);
    reviewDialog.current?.close();
    setError("IDENTITY_CHANGED");
  }, []);
  useEffect(() => {
    if (!wallet) return;
    const accounts = (value: unknown) => {
      providerIdentity.current++;
      invalidate();
      setAccount(
        Array.isArray(value) && /^0x[0-9a-f]{40}$/i.test(value[0])
          ? value[0]
          : "",
      );
    };
    const chains = (value: unknown) => {
      invalidate();
      try {
        setChain(parseChain(value));
      } catch {
        setChain(undefined);
      }
    };
    const disconnected = () => {
      providerIdentity.current++;
      invalidate();
      setAccount("");
      setWallet(undefined);
      setError("WALLET_DISCONNECTED");
    };
    wallet.provider.on?.("accountsChanged", accounts);
    wallet.provider.on?.("chainChanged", chains);
    wallet.provider.on?.("disconnect", disconnected);
    return () => {
      wallet.provider.removeListener?.("accountsChanged", accounts);
      wallet.provider.removeListener?.("chainChanged", chains);
      wallet.provider.removeListener?.("disconnect", disconnected);
    };
  }, [wallet, invalidate]);
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
  async function selectWallet(selected: Wallet) {
    if (walletBusy) return;
    providerIdentity.current++;
    setWalletBusy(true);
    setError("");
    const epoch = ++walletGeneration.current;
    const controller = new AbortController();
    connectionAbort.current = controller;
    try {
      const result = await connect(selected.provider, controller.signal);
      if (epoch !== walletGeneration.current || controller.signal.aborted)
        return;
      generation.current++;
      setBusy(false);
      setWallet(selected);
      setAccount(result.account);
      setChain(result.chain);
      setQuote(undefined);
      connectionAbort.current = undefined;
      walletDialog.current?.close();
    } catch (e) {
      if (epoch === walletGeneration.current) setError(errorCode(e));
    } finally {
      if (epoch === walletGeneration.current) {
        connectionAbort.current = undefined;
        setWalletBusy(false);
      }
    }
  }
  function cancelConnection() {
    if (connectionAbort.current) {
      walletGeneration.current++;
      connectionAbort.current.abort();
      connectionAbort.current = undefined;
      setWalletBusy(false);
    }
  }
  async function switchNetwork(add = false) {
    if (!wallet) return;
    setError("");
    const selected = wallet;
    const identity = providerIdentity.current;
    try {
      await requestOnce(
        wallet.provider,
        add ? "wallet_addEthereumChain" : "wallet_switchEthereumChain",
        add
          ? [
              {
                chainId: "0x956d7",
                chainName: "ONEchain Mainnet",
                nativeCurrency: { name: "ONE", symbol: "ONE", decimals: 18 },
                rpcUrls: ["https://mainnet.crosstoken.io:22001"],
                blockExplorerUrls: ["https://explorer.onechain.nexus/612055"],
              },
            ]
          : [{ chainId: mode === "local-test" ? "0x7a69" : "0x956d7" }],
      );
      if (identity !== providerIdentity.current) return;
      invalidate();
      const epoch = walletGeneration.current;
      const nextChain = parseChain(
        await readWallet(selected.provider, "eth_chainId"),
      );
      if (
        epoch !== walletGeneration.current ||
        identity !== providerIdentity.current
      )
        return;
      setChain(nextChain);
    } catch (e) {
      if (identity === providerIdentity.current) setError(errorCode(e));
    }
  }
  async function getQuote() {
    setError("");
    setQuote(undefined);
    const epoch = ++generation.current;
    setBusy(true);
    try {
      const requestedAmount = parseAmount(amount);
      const q = quoteFromWire(await api({ action: "quote", account, amount }));
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
        parseAmount(amount),
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
  const row = (label: string, value: ReactNode) => (
    <div className="data-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
  const address = (value: string) => (
    <div className="address">
      <code>{value}</code>
      <button className="small" onClick={() => void copy(value)}>
        {copied === value ? t("copied") : t("copy")}
      </button>
    </div>
  );
  const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
  const quoteValid = (() => {
    if (!quote || quote.mode !== mode) return false;
    try {
      validateQuote(quote, account, chain ?? 0, now, parseAmount(amount));
      return true;
    } catch {
      return false;
    }
  })();
  const rightChain = chain === (mode === "local-test" ? 31337 : 612055);
  const modeBadge = (
    <span className={`badge ${mode === "local-test" ? "test" : ""}`}>
      <span className="dot" />
      {mode === "local-test" ? t("local") : t("readonly")}
    </span>
  );
  const views = ["/", "/activity", "/networks", "/help", "/about", "/settings"];
  if (!views.includes(path) && !path.startsWith("/activity/")) return children;
  return (
    <>
      <a className="skip" href="#main">
        {lang === "tr" ? "İçeriğe geç" : "Skip to content"}
      </a>
      <header className="header">
        <Link href="/" className="brand" aria-label="Otherbridge">
          <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
            <path
              d="M3 23V12h6v11M23 23V12h6v11M6 14C11 3 21 3 26 14M9 19h14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
          </svg>
          Otherbridge<span className="version">V1</span>
        </Link>
        <nav aria-label={lang === "tr" ? "Ana gezinme" : "Main navigation"}>
          {(
            [
              ["/", "bridge"],
              ["/activity", "activity"],
              ["/networks", "networks"],
              ["/help", "help"],
            ] as const
          ).map(([href, key]) => (
            <Link
              key={href}
              className={
                path === href || (href !== "/" && path.startsWith(href))
                  ? "active"
                  : ""
              }
              href={href}
            >
              {t(key)}
            </Link>
          ))}
        </nav>
        <div className="header-actions">
          <button
            className="icon-button"
            aria-label={t("language")}
            onClick={() => setLang(lang === "tr" ? "en" : "tr")}
          >
            {lang.toUpperCase()}
          </button>
          <button
            className="icon-button theme-toggle"
            aria-label={t("theme")}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "☼" : "◐"}
          </button>
          <button
            className="wallet-button"
            onClick={() => walletDialog.current?.showModal()}
          >
            {account ? short(account) : t("connect")}
          </button>
        </div>
      </header>
      <main id="main" className="main" style={routeSceneStyle}>
        {error && (
          <div className="notice error" role="alert">
            {explain(error)}
            <button
              className="small"
              aria-label={t("close")}
              onClick={() => setError("")}
            >
              ×
            </button>
          </div>
        )}
        {path === "/" && (
          <>
            <div className="intro">
              <p className="eyebrow">{t("eyebrow")}</p>
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
              <p>{t("subtitle")}</p>
            </div>
            <div className="bridge-grid">
              <section className="card bridge-card" aria-label={t("bridge")}>
                <div className="card-top">
                  <h2>{t("bridge")}</h2>
                  {modeBadge}
                </div>
                <p className="mode-note">
                  {mode === "local-test" ? t("localNote") : t("liveNote")}
                </p>
                <div
                  className="network-box network-tinted"
                  style={networkStyle("onechain")}
                  data-network="onechain"
                >
                  <NetworkLogo id="onechain" />
                  <div>
                    <span className="micro network-role">{t("from")}</span>
                    <strong>ONEchain</strong>
                    <small>ONE · {t("native")}</small>
                  </div>
                  <span className="network-id">
                    {mode === "local-test" ? "31337" : "612055"}
                  </span>
                </div>
                <div className="direction-arrow" aria-label={t("direction")}>
                  ↓
                </div>
                <div
                  className="network-box network-tinted"
                  style={networkStyle("bsc")}
                  data-network="bsc"
                >
                  <NetworkLogo id="bsc" />
                  <div>
                    <span className="micro network-role">{t("to")}</span>
                    <strong>BNB Smart Chain</strong>
                    <small>CROSS · {t("erc20")}</small>
                  </div>
                  <span className="network-id">
                    {mode === "local-test" ? "31338" : "56"}
                  </span>
                </div>
                <div className="amount-label">
                  <label htmlFor="amount">{t("amount")}</label>
                  <span>
                    {t("balance")}:{" "}
                    {balances
                      ? `${formatAmount(BigInt(balances.balance))} ONE`
                      : "—"}
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
                  <span>ONE</span>
                  <button
                    disabled={!balances || mode !== "local-test"}
                    onClick={() => {
                      if (balances) {
                        changeAmount(
                          formatAmount(
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
                <p id="amount-hint" className="input-hint">
                  {t("amountHint")}
                </p>
                {account && (
                  <div className="recipient">
                    <span className="micro">
                      {t("recipient")} · {t("same")}
                    </span>
                    {address(account)}
                  </div>
                )}
                {account && !rightChain && (
                  <div className="notice">
                    <p>{t("wrongChain")}</p>
                    <button onClick={() => void switchNetwork()}>
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
                    <p className="input-hint">{t("networkNote")}</p>
                  </div>
                )}
                <div className="fees">
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
                  {row(t("ourFee"), "0 ONE")}
                  <div className="receive">
                    {row(
                      t("receive"),
                      quote ? `${formatAmount(quote.expected)} CROSS` : "—",
                    )}
                  </div>
                </div>
                {quote && !quoteValid && (
                  <p className="notice" role="status">
                    {explain("QUOTE_EXPIRED")}
                  </p>
                )}
                {!account ? (
                  <button
                    className="primary"
                    onClick={() => walletDialog.current?.showModal()}
                  >
                    {t("connect")} <span>↗</span>
                  </button>
                ) : quoteValid ? (
                  <button
                    className="primary"
                    onClick={() => reviewDialog.current?.showModal()}
                  >
                    {t("review")} <span>→</span>
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={busy || !rightChain || !amount}
                    onClick={() => void getQuote()}
                  >
                    {busy ? t("quoting") : t("quote")} <span>→</span>
                  </button>
                )}
                <p className="under-button">{t("writeDisabled")}</p>
              </section>
              <aside className="route-side">
                <section className="card">
                  <h2>{t("routeDetails")}</h2>
                  <RouteIdentity compact />
                  <div className="route-line">
                    <span>ONE</span>
                    <span>→</span>
                    <span>CROSS</span>
                  </div>
                  {row(t("provider"), "ONEbridge")}
                  {row(t("direction"), "ONEchain → BSC")}
                  <p className="micro token-label">{t("token")}</p>
                  {address(CROSS)}
                  <Link href="/networks" className="text-link">
                    {t("networks")} ↗
                  </Link>
                </section>
                <section className="card health-card">
                  <div className="card-top">
                    <h2>{t("health")}</h2>
                    <span className="status-dot" />
                  </div>
                  <strong className="amber">
                    {mode === "local-test" ? t("local") : t("notVerified")}
                  </strong>
                  {mode === "mainnet-readonly" && health?.limits && (
                    <>
                      {row(
                        t("observedMinimum"),
                        `${formatAmount(BigInt(health.limits.minimum))} ONE`,
                      )}
                      {row(
                        t("observedBound"),
                        `${formatAmount(BigInt(health.limits.maximumBound))} ONE`,
                      )}
                      {row(
                        t("reserveBound"),
                        `${formatAmount(BigInt(health.limits.conservativeReserveBound))} CROSS`,
                      )}
                      <p className="micro">{t("boundNote")}</p>
                    </>
                  )}
                  <p className="input-hint">
                    {t("updated")}:{" "}
                    {health
                      ? new Date(health.observedAt).toLocaleTimeString(lang)
                      : "—"}
                  </p>
                  <button
                    className="small"
                    disabled={healthBusy}
                    onClick={() => void updateHealth()}
                  >
                    {healthBusy ? "…" : t("refresh")} ↻
                  </button>
                </section>
                <div className="safety">
                  <span className="shield">◇</span>
                  <div>
                    <h3>{t("safetyTitle")}</h3>
                    <p>{t("safety")}</p>
                    <Link href="/about">{t("learn")} ↗</Link>
                  </div>
                </div>
              </aside>
            </div>
          </>
        )}
        {path === "/activity" && (
          <>
            <div className="page-heading">
              <p className="eyebrow">{t("activity").toLocaleUpperCase(lang)}</p>
              <h1>{t("activity")}</h1>
              <p>{t("empty")}</p>
            </div>
            <div className="toolbar">
              <label>
                {t("filter")}
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">{t("all")}</option>
                  <option value="pending">{t("pending")}</option>
                  <option value="completed">{t("completed")}</option>
                </select>
              </label>
              <button
                onClick={() => download("otherbridge-history.json", records)}
              >
                {t("historyExport")}
              </button>
              <label className="file-button">
                {t("historyImport")}
                <input
                  aria-label={t("historyImport")}
                  type="file"
                  accept="application/json"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      if (file.size > 150000)
                        throw new BridgeError("IMPORT_TOO_LARGE");
                      await importHistory(await file.text());
                    } catch (err) {
                      setError(
                        err instanceof BridgeError
                          ? err.code
                          : "INVALID_REQUEST",
                      );
                    }
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <p className="input-hint">{t("importNote")}</p>
            {records.length === 0 ? (
              <section className="card empty">
                <span className="empty-symbol">↔</span>
                <h2>{t("emptyTitle")}</h2>
                <Link className="text-link" href="/">
                  {t("bridge")} →
                </Link>
              </section>
            ) : (
              <div className="activity-list">
                {records
                  .filter(
                    (r) =>
                      filter === "all" ||
                      (filter === "completed"
                        ? r.state === "COMPLETED"
                        : r.state !== "COMPLETED"),
                  )
                  .map((r) => (
                    <Link
                      className="card activity-item"
                      key={r.id}
                      href={`/activity/${r.id}`}
                    >
                      <div className="activity-summary">
                        <strong>
                          {formatAmount(BigInt(r.amount))} ONE → CROSS
                        </strong>
                        <RouteIdentity compact />
                        <small>
                          {short(r.account)} ·{" "}
                          {new Date(r.updatedAt).toLocaleString(lang)}
                        </small>
                      </div>
                      <span className="badge">
                        {r.mode === "local-test" ? t("local") : t("readonly")}
                      </span>
                      <span
                        className={r.state === "COMPLETED" ? "teal" : "amber"}
                      >
                        {stateName(r.state)} →
                      </span>
                    </Link>
                  ))}
              </div>
            )}
          </>
        )}
        {path.startsWith("/activity/") &&
          (activeRecord ? (
            <>
              <div className="page-heading">
                <p className="eyebrow">{t("timeline")}</p>
                <h1>{stateName(activeRecord.state)}</h1>
                <p>
                  {activeRecord.mode === "local-test"
                    ? t("localNote")
                    : t("sourceSuccess")}
                </p>
              </div>
              <section className="card">
                <div className="card-top">
                  <h2>
                    {formatAmount(BigInt(activeRecord.amount))} ONE → CROSS
                  </h2>
                  <span className="badge">
                    {activeRecord.mode === "local-test"
                      ? t("local")
                      : t("readonly")}
                  </span>
                </div>
                <RouteIdentity />
                <ol className="timeline">
                  {[
                    t("sourceStep"),
                    t("settlementStep"),
                    t("destinationStep"),
                  ].map((label, i) => (
                    <li
                      key={label}
                      className={
                        activeRecord.state === "COMPLETED" ||
                        (i === 0 &&
                          [
                            "SETTLEMENT_PENDING",
                            "DESTINATION_CONFIRMING",
                          ].includes(activeRecord.state))
                          ? "done"
                          : ""
                      }
                    >
                      <span>{i + 1}</span>
                      <div>
                        <strong>{label}</strong>
                        {i === 1 ? (
                          <small>ONEbridge</small>
                        ) : (
                          <NetworkBadge
                            id={i === 0 ? "onechain" : "bsc"}
                            compact
                          />
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
                {activeRecord.mode === "mainnet-readonly" &&
                  !activeRecord.sourceHash && (
                    <form
                      className="recovery-form"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        if (recoveryBusy) return;
                        const candidate = String(
                          new FormData(event.currentTarget).get("sourceHash") ??
                            "",
                        );
                        setRecoveryBusy(true);
                        setError("");
                        try {
                          const claim = await attachSourceHash(
                            activeRecord.id,
                            candidate,
                          );
                          const raw = await api({
                            action: "track",
                            record: claim,
                          });
                          const current = readHistory();
                          if (current.error)
                            throw new BridgeError(current.error);
                          const latest = current.records.find(
                            (record) => record.id === claim.id,
                          );
                          if (!latest) throw new BridgeError("INVALID_REQUEST");
                          const observed = historyView.accept(latest, raw);
                          await saveRecord(observed);
                          setNow(Date.now());
                        } catch (e) {
                          setError(
                            e instanceof BridgeError
                              ? e.code
                              : "INVALID_REQUEST",
                          );
                        } finally {
                          setRecoveryBusy(false);
                        }
                      }}
                    >
                      <p className="notice" role="status">
                        {explain("MANUAL_ACTION_REQUIRED")}
                      </p>
                      <label>
                        {t("sourceHash")}
                        <input
                          name="sourceHash"
                          required
                          pattern="0x[0-9a-fA-F]{64}"
                          maxLength={66}
                          placeholder="0x…"
                          autoComplete="off"
                        />
                      </label>
                      <button type="submit" disabled={recoveryBusy}>
                        {t("resumeTracking")}
                      </button>
                    </form>
                  )}
                {activeRecord.error === "DESTINATION_DISCOVERY_BOUNDED" && (
                  <p className="notice" role="status">
                    {explain(activeRecord.error)}
                  </p>
                )}
                {row(
                  t("receive"),
                  `${formatAmount(BigInt(activeRecord.expected))} CROSS`,
                )}
                <p className="micro">{t("recipient")}</p>
                {address(activeRecord.recipient)}
                {(
                  [
                    [
                      "sourceHash",
                      activeRecord.sourceHash,
                      "https://explorer.onechain.nexus/612055/transactions/",
                    ],
                    [
                      "destHash",
                      activeRecord.destinationHash,
                      "https://bscscan.com/tx/",
                    ],
                  ] as const
                ).map(
                  ([key, hash, base]) =>
                    hash && (
                      <div key={key} className="hash-row">
                        <p className="micro">{t(key)}</p>
                        {address(hash)}
                        {activeRecord.mode === "mainnet-readonly" ? (
                          <a
                            className="text-link"
                            href={`${base}${hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Explorer ↗
                          </a>
                        ) : (
                          <small>{t("localExplorer")}</small>
                        )}
                      </div>
                    ),
                )}
                {activeRecord.state !== "COMPLETED" && (
                  <p className="notice">{t("waiting")}</p>
                )}
                <label className="check">
                  <input
                    type="checkbox"
                    checked={includePublic}
                    onChange={(e) => setIncludePublic(e.target.checked)}
                  />
                  {t("publicExport")}
                </label>
                <button
                  onClick={() =>
                    download(
                      "otherbridge-diagnostics.json",
                      diagnostic(activeRecord, includePublic),
                    )
                  }
                >
                  {t("export")}
                </button>
              </section>
              {activeRecord.state === "COMPLETED" && (
                <section className="card post">
                  <h2>{t("postTitle")}</h2>
                  <p>{t("post")}</p>
                  <p className="notice">{t("bnb")}</p>
                  <p className="micro">{t("token")}</p>
                  {address(CROSS)}
                  {activeRecord.mode === "mainnet-readonly" && wallet && (
                    <button
                      onClick={async () => {
                        const identity = providerIdentity.current;
                        try {
                          if (
                            parseChain(
                              await readWallet(wallet.provider, "eth_chainId"),
                            ) !== 56
                          )
                            throw new BridgeError("IDENTITY_CHANGED");
                          if (identity !== providerIdentity.current) return;
                          await requestOnce(
                            wallet.provider,
                            "wallet_watchAsset",
                            [
                              {
                                type: "ERC20",
                                options: {
                                  address: CROSS,
                                  symbol: "CROSS",
                                  decimals: 18,
                                },
                              },
                            ],
                          );
                        } catch (e) {
                          if (identity === providerIdentity.current)
                            setError(errorCode(e));
                        }
                      }}
                    >
                      {t("watch")}
                    </button>
                  )}
                  <Link className="text-link" href="/help">
                    {t("dex")} ↗
                  </Link>
                </section>
              )}
            </>
          ) : (
            <section className="card empty">
              <h1>{t("notFound")}</h1>
              <Link href="/activity">{t("activity")} →</Link>
            </section>
          ))}
        {path === "/networks" && (
          <>
            <div className="page-heading">
              <p className="eyebrow">
                V1 · {t("networks").toLocaleUpperCase(lang)}
              </p>
              <h1>{t("netTitle")}</h1>
              <p>{t("netSubtitle")}</p>
            </div>
            <div className="network-grid">
              {(
                [
                  {
                    id: "onechain",
                    chainId: mode === "local-test" ? 31337 : 612055,
                    snapshot: health?.source,
                  },
                  {
                    id: "bsc",
                    chainId: mode === "local-test" ? 31338 : 56,
                    snapshot: health?.destination,
                  },
                ] as const
              ).map(({ id, chainId, snapshot }) => (
                <section
                  className="card network-tinted network-card"
                  key={id}
                  style={networkStyle(id)}
                  data-network={id}
                >
                  <div className="network-card-heading">
                    <NetworkLogo id={id} size="lg" />
                    <div>
                      <p className="micro network-role">
                        {id === "onechain" ? t("from") : t("to")}
                      </p>
                      <h2>{networkIdentity[id].name}</h2>
                    </div>
                  </div>
                  {row(t("chainId"), String(chainId))}
                  {row(t("block"), snapshot?.block ?? "—")}
                  {row(t("health"), t("notVerified"))}
                  <p className="input-hint">
                    {t("updated")}:{" "}
                    {health
                      ? new Date(health.observedAt).toLocaleString(lang)
                      : "—"}
                  </p>
                </section>
              ))}
            </div>
            <section className="card route-status">
              <h2>{t("routeDetails")}</h2>
              {row(t("provider"), "ONEbridge")}
              {row(t("reserve"), t("unverified"))}
              {health?.token &&
                row(
                  t("token"),
                  `${health.token.name} / ${health.token.symbol} · ${health.token.decimals}`,
                )}
              {mode === "mainnet-readonly" &&
                health?.reasons.map((reason) => (
                  <p className="notice" key={reason}>
                    {explain(reason)}
                  </p>
                ))}
              <button disabled={healthBusy} onClick={() => void updateHealth()}>
                {t("refresh")}
              </button>
            </section>
          </>
        )}
        {path === "/help" && (
          <>
            <div className="page-heading">
              <p className="eyebrow">{t("help").toLocaleUpperCase(lang)}</p>
              <h1>{t("helpTitle")}</h1>
              <p>{t("helpSubtitle")}</p>
            </div>
            <section className="card faq">
              {faq.map(([q, a, eq, ea]) => (
                <details key={q}>
                  <summary>
                    {lang === "tr" ? q : eq}
                    <span>+</span>
                  </summary>
                  <p>{lang === "tr" ? a : ea}</p>
                </details>
              ))}
            </section>
            <section className="card post">
              <h2>{t("future")}</h2>
              <p>{t("futureText")}</p>
            </section>
          </>
        )}
        {path === "/about" && (
          <>
            <div className="page-heading">
              <p className="eyebrow">OTHERBRIDGE / V1</p>
              <h1>{t("aboutTitle")}</h1>
            </div>
            <section className="card prose">
              <h2>{t("about")}</h2>
              <p>{t("aboutText")}</p>
              <h2>{t("privacy")}</h2>
              <p>{t("privacyText")}</p>
              <h2>{t("future")}</h2>
              <p>{t("futureText")}</p>
            </section>
          </>
        )}
        {path === "/settings" && (
          <>
            <div className="page-heading">
              <p className="eyebrow">{t("settings").toLocaleUpperCase(lang)}</p>
              <h1>{t("settingsTitle")}</h1>
            </div>
            <section className="card preferences">
              <label>
                {t("language")}
                <select
                  value={lang}
                  onChange={(e) => setLang(e.target.value as Language)}
                >
                  <option value="tr">Türkçe</option>
                  <option value="en">English</option>
                </select>
              </label>
              <label>
                {t("theme")}
                <select
                  value={theme}
                  onChange={(e) => setTheme(e.target.value)}
                >
                  <option value="dark">{t("dark")}</option>
                  <option value="light">{t("light")}</option>
                </select>
              </label>
              <p>{t("privacyText")}</p>
            </section>
          </>
        )}
      </main>
      <footer>
        <span className="footer-mark">↔</span>
        <span>{t("footer")}</span>
        <div>
          <Link href="/about">{t("about")}</Link>
          <Link href="/settings">{t("settings")}</Link>
        </div>
      </footer>
      <dialog
        ref={walletDialog}
        aria-labelledby="wallet-title"
        onKeyDown={trapDialog}
        onCancel={cancelConnection}
        onClose={cancelConnection}
      >
        <div className="dialog-top">
          <h2 id="wallet-title">{t("choose")}</h2>
          <button
            className="icon-button"
            aria-label={t("close")}
            onClick={() => {
              cancelConnection();
              walletDialog.current?.close();
            }}
          >
            ×
          </button>
        </div>
        <p>{t("walletNote")}</p>
        {wallets.length === 0 && <p className="notice">{t("noWallet")}</p>}
        {wallets.map((w) => (
          <button
            className="wallet-option"
            key={w.id}
            disabled={walletBusy}
            onClick={() => void selectWallet(w)}
          >
            <span className="wallet-symbol">▣</span>
            {w.name}
            <span>→</span>
          </button>
        ))}
        {walletBusy && <p role="status">{t("connecting")}</p>}
        {error && (
          <p className="notice" role="alert">
            {explain(error)}
          </p>
        )}
        {account && (
          <>
            <p className="micro">{t("wallet")}</p>
            {address(account)}
            <button
              className="small"
              onClick={() => {
                invalidate();
                providerIdentity.current++;
                setWallet(undefined);
                setAccount("");
                walletDialog.current?.close();
                setError("");
              }}
            >
              {t("disconnect")}
            </button>
          </>
        )}
      </dialog>
      <dialog
        ref={reviewDialog}
        aria-labelledby="review-title"
        onKeyDown={trapDialog}
      >
        <div className="dialog-top">
          <h2 id="review-title">{t("reviewTitle")}</h2>
          <button
            className="icon-button"
            aria-label={t("close")}
            onClick={() => reviewDialog.current?.close()}
          >
            ×
          </button>
        </div>
        {quote && (
          <>
            <p className="badge">
              {t(mode === "local-test" ? "local" : "readonly")}
            </p>
            <RouteIdentity />
            {row(t("amount"), `${formatAmount(quote.amount, 18)} ONE`)}
            {row(t("fee"), `${formatAmount(quote.networkFee, 18)} ONE`)}
            {row(t("serviceFee"), `${formatAmount(quote.serviceFee, 18)} ONE`)}
            {row(
              t("debit"),
              `${formatAmount(quote.amount + quote.networkFee + quote.serviceFee, 18)} ONE`,
            )}
            {row(t("gas"), `${formatAmount(quote.gasBudget)} ONE`)}
            {row(t("receive"), `${formatAmount(quote.expected, 18)} CROSS`)}
            <p className="micro">{t("recipient")}</p>
            {address(quote.recipient)}
            <p className="input-hint">
              {t("expiry")}:{" "}
              {new Date(quote.expiresAt).toLocaleTimeString(lang)}
            </p>
            <p className="notice">{t("riskReview")}</p>
            <p className="notice">
              {t("bnb")}{" "}
              {balances ? `${formatAmount(BigInt(balances.bnb))} BNB` : "—"}
            </p>
            {error && <p role="alert">{explain(error)}</p>}
            <button
              className="primary"
              disabled={!quoteValid || mode !== "local-test"}
              onClick={() => void localRun()}
            >
              {t(mode === "local-test" ? "runLocal" : "writeDisabled")}
            </button>
          </>
        )}
      </dialog>
    </>
  );
}
