// G7 pilot local page (browser side). The ONLY wallet write in this file is the guarded one-shot function below:
// a single send-transaction request, made after the owner's own click, with the parameters the server released
// exactly once and this page re-verified independently (own calldata decoder, own bounds, own intent digest).
// It never asks for a private key or seed phrase, never signs messages or typed data, never sends raw
// transactions, never approves or permits, and never confirms anything on the owner's behalf.

const EXPECT = Object.freeze({
  schema: "otherbridge.g7.pilot-intent.v1",
  chainId: 612055,
  chainIdHex: "0x956d7",
  account: "0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c",
  contract: "0xb81d6e000000000000000000000000000000c0de",
  nativeSentinel: "0x0000000000000000000000000000000000000001",
  cross: "0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510",
  selector: "0x5fd262de",
  signature:
    "bridgeToken(uint256,address,address,uint256,uint256,uint256,bytes)",
  principal: 5000000000000000000n,
  maxNetworkFee: 180000000000000000n,
  maxServiceFee: 0n,
  maxWalletDebit: 5180759310000000000n,
  quoteMaxAgeAtWalletMs: 20000,
  phrase: "G7 5 ONE",
  buttonLabel: "Request wallet confirmation for ONE transaction",
  mockRdns: "invalid.otherbridge.g7-mock",
});
const TX_KEYS =
  "chainId,data,from,gas,maxFeePerGas,maxPriorityFeePerGas,to,value";
// Wallet methods this page may use besides the single guarded send below. Anything else is refused locally.
const WALLET_READS = new Set(["eth_accounts", "eth_chainId"]);
const WALLET_PROMPTS = new Set([
  "eth_requestAccounts",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
]);
const ADD_ONECHAIN = {
  chainId: "0x956d7",
  chainName: "ONEchain Mainnet",
  nativeCurrency: { name: "ONE", symbol: "ONE", decimals: 18 },
  rpcUrls: ["https://mainnet.crosstoken.io:22001"],
  blockExplorerUrls: ["https://explorer.onechain.nexus/612055"],
};

const ui = {
  token: null,
  csrf: null,
  snap: null,
  clockOffset: 0,
  providers: [],
  selected: null,
  listeners: null,
  account: null,
  chainId: null,
  busy: false,
  inflight: 0,
  sendAttempted: false,
  armedLocally: false,
  lastHash: null,
  reviewDigest: null,
  localCheck: { ok: false, failures: ["not verified yet"], forDigest: null },
  needAdd: false,
};

// ------------------------------------------------------------------ small helpers (textContent only)
const $ = (id) => document.getElementById(id);
const lc = (s) => String(s ?? "").toLowerCase();
const eq = (a, b) => lc(a) === lc(b);
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
function node(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined && text !== null) e.textContent = String(text);
  if (cls) e.className = cls;
  return e;
}
function kv(dl, rows) {
  clear(dl);
  for (const [k, v, cls] of rows) {
    const dd = node("dd", undefined, cls);
    if (v instanceof Node) dd.append(v);
    else dd.textContent = v === null || v === undefined ? "—" : String(v);
    dl.append(node("dt", k), dd);
  }
}
function units(wei, decimals = 18n) {
  const v = BigInt(wei);
  const base = 10n ** decimals;
  const frac = (v % base)
    .toString()
    .padStart(Number(decimals), "0")
    .replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}
const one = (wei) => `${units(wei)} ONE`;
const gwei = (wei) => `${units(wei, 9n)} gwei`;
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  return v;
}
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ------------------------------------------------------------------ independent verification of the review
function decodeBridgeToken(data) {
  if (typeof data !== "string" || !/^0x[0-9a-f]+$/.test(data))
    throw new Error("CALLDATA_NOT_LOWERCASE_HEX");
  if (data.length !== 2 + 8 + 64 * 8)
    throw new Error("CALLDATA_LENGTH_NOT_260_BYTES");
  if (data.slice(0, 10) !== EXPECT.selector)
    throw new Error("SELECTOR_NOT_BRIDGE_TOKEN");
  const w = (i) => data.slice(10 + 64 * i, 10 + 64 * (i + 1));
  const addr = (i) => {
    if (!/^0{24}/.test(w(i))) throw new Error("DIRTY_ADDRESS_WORD");
    return "0x" + w(i).slice(24);
  };
  if (BigInt("0x" + w(6)) !== 224n) throw new Error("NON_CANONICAL_OFFSET");
  if (BigInt("0x" + w(7)) !== 0n) throw new Error("EXTRA_DATA_NOT_EMPTY");
  return {
    toChainID: BigInt("0x" + w(0)),
    fromToken: addr(1),
    to: addr(2),
    value: BigInt("0x" + w(3)),
    networkFee: BigInt("0x" + w(4)),
    exFee: BigInt("0x" + w(5)),
  };
}
async function verifyReview(review) {
  const f = [];
  try {
    const { intent, tx } = review;
    if (Object.keys(tx).sort().join(",") !== TX_KEYS) f.push("TX_KEYS");
    if (tx.chainId !== EXPECT.chainIdHex) f.push("CHAIN_NOT_612055");
    if (!eq(tx.from, EXPECT.account)) f.push("FROM_NOT_OWNER_EOA");
    if (!eq(tx.to, EXPECT.contract)) f.push("TO_NOT_PINNED_PROXY");
    const d = decodeBridgeToken(tx.data);
    if (d.toChainID !== 56n) f.push("DESTINATION_NOT_BSC_56");
    if (!eq(d.fromToken, EXPECT.nativeSentinel))
      f.push("SOURCE_TOKEN_NOT_NATIVE");
    if (!eq(d.to, EXPECT.account)) f.push("RECIPIENT_NOT_OWNER_EOA");
    if (d.value !== EXPECT.principal) f.push("PRINCIPAL_NOT_EXACTLY_5_ONE");
    if (d.networkFee > EXPECT.maxNetworkFee)
      f.push("NETWORK_FEE_ABOVE_0_18_ONE");
    if (d.exFee > EXPECT.maxServiceFee) f.push("SERVICE_FEE_ABOVE_0");
    const value = BigInt(tx.value);
    if (value !== d.value + d.networkFee + d.exFee)
      f.push("MSG_VALUE_NOT_EXACT_SUM");
    const gas = BigInt(tx.gas);
    const maxFee = BigInt(tx.maxFeePerGas);
    const prio = BigInt(tx.maxPriorityFeePerGas);
    const cap = BigInt(intent.priceCapForExposure);
    if (cap < maxFee) f.push("PRICE_CAP_BELOW_MAX_FEE");
    if (prio > maxFee) f.push("PRIORITY_FEE_ABOVE_MAX_FEE");
    const debit = value + gas * cap;
    if (debit > EXPECT.maxWalletDebit)
      f.push("MAX_WALLET_DEBIT_ABOVE_5_18075931_ONE");
    if (String(debit) !== intent.maximumWalletDebit)
      f.push("MAX_WALLET_DEBIT_MISMATCH");
    const checks = [
      [intent.schema === EXPECT.schema, "INTENT_SCHEMA"],
      [
        intent.sourceChainId === EXPECT.chainId &&
          intent.destinationChainId === 56,
        "INTENT_CHAINS",
      ],
      [
        eq(intent.from, tx.from) &&
          eq(intent.to, tx.to) &&
          eq(intent.recipient, d.to),
        "INTENT_ADDRESSES",
      ],
      [eq(intent.sourceToken, EXPECT.nativeSentinel), "INTENT_SOURCE_TOKEN"],
      [
        intent.selector === EXPECT.selector &&
          intent.function === EXPECT.signature,
        "INTENT_FUNCTION",
      ],
      [
        intent.principal === String(d.value) &&
          intent.networkFee === String(d.networkFee) &&
          intent.serviceFee === String(d.exFee),
        "INTENT_AMOUNTS",
      ],
      [
        intent.otherbridgeFee === "0" &&
          intent.extraData === "0x" &&
          intent.approval === null,
        "INTENT_NO_EXTRAS",
      ],
      [
        intent.value === String(value) && eq(intent.calldata, tx.data),
        "INTENT_VALUE_OR_CALLDATA",
      ],
      [
        intent.gasLimit === String(gas) &&
          intent.maxFeePerGas === String(maxFee) &&
          intent.maxPriorityFeePerGas === String(prio),
        "INTENT_GAS",
      ],
      [
        intent.expectedReceive.chainId === 56 &&
          eq(intent.expectedReceive.token, EXPECT.cross) &&
          intent.expectedReceive.amount === String(EXPECT.principal),
        "INTENT_EXPECTED_RECEIVE",
      ],
      [
        intent.trustModelAccepted === true &&
          eq(intent.routePins.source.proxy, EXPECT.contract),
        "INTENT_SCOPE",
      ],
    ];
    for (const [ok, name] of checks) if (!ok) f.push(name);
    const digest = await sha256Hex(JSON.stringify(canonicalize(intent)));
    if (digest !== review.intentDigest) f.push("INTENT_DIGEST_MISMATCH");
    return { ok: f.length === 0, failures: f, digest };
  } catch (e) {
    return {
      ok: false,
      failures: [...f, `VERIFY_ERROR:${e && e.message ? e.message : e}`],
      digest: null,
    };
  }
}
const exactTx = (tx) => ({
  from: tx.from,
  to: tx.to,
  value: tx.value,
  data: tx.data,
  gas: tx.gas,
  maxFeePerGas: tx.maxFeePerGas,
  maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
  chainId: tx.chainId,
});
const sameTx = (a, b) =>
  TX_KEYS.split(",").every((k) => typeof a[k] === "string" && a[k] === b[k]);

// ------------------------------------------------------------------ local server API (token + CSRF, same origin)
function readToken() {
  const m = /^#token=([A-Za-z0-9_-]{20,100})$/.exec(location.hash);
  if (m) {
    try {
      sessionStorage.setItem("g7-token", m[1]);
    } catch {
      // the token still works for this page load
    }
    history.replaceState(null, "", location.pathname);
    return m[1];
  }
  try {
    return sessionStorage.getItem("g7-token");
  } catch {
    return null;
  }
}
async function api(route, body = {}) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${ui.token}`,
  };
  if (ui.csrf) headers["x-g7-csrf"] = ui.csrf;
  ui.inflight++;
  try {
    const res = await fetch(`/api/${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      mode: "same-origin",
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (data && data.sessionId) applySnapshot(data);
    else if (data && data.state && data.state.sessionId)
      applySnapshot(data.state);
    if (!res.ok) {
      const e = new Error((data && data.error) || `HTTP_${res.status}`);
      e.code = (data && data.error) || `HTTP_${res.status}`;
      throw e;
    }
    return data;
  } finally {
    ui.inflight--;
  }
}

// ------------------------------------------------------------------ wallet (EIP-6963 discovery, EIP-1193 calls)
function fixtureMode() {
  return !!(ui.snap && ui.snap.fixture);
}
function discoverWallets() {
  window.addEventListener("eip6963:announceProvider", (event) => {
    const d = event.detail;
    if (
      !d ||
      !d.provider ||
      typeof d.provider.request !== "function" ||
      !d.info
    )
      return;
    if (typeof d.info.uuid !== "string" || typeof d.info.name !== "string")
      return;
    if (
      ui.providers.some(
        (p) => p.provider === d.provider || p.uuid === d.info.uuid,
      )
    )
      return;
    const rdns =
      typeof d.info.rdns === "string" ? d.info.rdns.slice(0, 100) : "";
    const isMock =
      rdns === EXPECT.mockRdns && d.provider.isOtherbridgeG7Mock === true;
    // Fixture data may only ever reach the test mock; the test mock is never accepted outside fixture mode.
    if (fixtureMode() ? !isMock : rdns === EXPECT.mockRdns) return;
    ui.providers.push({
      uuid: d.info.uuid.slice(0, 100),
      name: d.info.name.slice(0, 60),
      rdns,
      provider: d.provider,
    });
    renderProviders();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  renderProviders();
  setTimeout(() => {
    const legacy = window.ethereum;
    if (
      !fixtureMode() &&
      legacy &&
      typeof legacy.request === "function" &&
      !ui.providers.some((p) => p.provider === legacy)
    )
      ui.providers.push({
        uuid: "legacy",
        name: "Injected wallet (window.ethereum)",
        rdns: "",
        provider: legacy,
      });
    renderProviders();
  }, 700);
}
function withTimeout(promise, ms, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(code);
        e.code = code;
        reject(e);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
function walletCall(method, params) {
  if (!ui.selected) return Promise.reject(new Error("NO_WALLET_SELECTED"));
  if (!WALLET_READS.has(method) && !WALLET_PROMPTS.has(method))
    return Promise.reject(new Error("WALLET_METHOD_NOT_ALLOWED"));
  const args = params === undefined ? { method } : { method, params };
  return withTimeout(
    Promise.resolve().then(() => ui.selected.provider.request(args)),
    WALLET_READS.has(method) ? 8000 : 180000,
    "WALLET_TIMEOUT",
  );
}
function selectProvider(index) {
  const p = ui.providers[index];
  if (!p || p === ui.selected) return;
  if (ui.selected && ui.listeners && ui.selected.provider.removeListener) {
    for (const [ev, fn] of Object.entries(ui.listeners))
      ui.selected.provider.removeListener(ev, fn);
  }
  ui.selected = p;
  ui.account = null;
  ui.chainId = null;
  ui.listeners = {
    accountsChanged: (accounts) => {
      ui.account =
        Array.isArray(accounts) && typeof accounts[0] === "string"
          ? lc(accounts[0])
          : null;
      resetConfirmations("Wallet account changed — confirm again.");
      render();
    },
    chainChanged: (chainId) => {
      const before = ui.chainId;
      ui.chainId = typeof chainId === "string" ? lc(chainId) : null;
      resetConfirmations("Wallet network changed — confirm again.");
      render();
      if (ui.chainId === EXPECT.chainIdHex && before !== ui.chainId)
        void refreshAfterSwitch();
    },
    disconnect: () => {
      ui.account = null;
      ui.chainId = null;
      render();
    },
  };
  if (p.provider.on)
    for (const [ev, fn] of Object.entries(ui.listeners)) p.provider.on(ev, fn);
  void readWalletIdentity().catch(() => undefined);
  render();
}
async function readWalletIdentity() {
  const [accounts, chainId] = await Promise.all([
    walletCall("eth_accounts"),
    walletCall("eth_chainId"),
  ]);
  ui.account =
    Array.isArray(accounts) && typeof accounts[0] === "string"
      ? lc(accounts[0])
      : null;
  ui.chainId = typeof chainId === "string" ? lc(chainId) : null;
  render();
  return { account: ui.account, chainId: ui.chainId };
}
async function assertWalletIdentity() {
  const w = await readWalletIdentity();
  if (w.account !== EXPECT.account)
    throw new Error("WALLET_ACCOUNT_NOT_OWNER_EOA");
  if (w.chainId !== EXPECT.chainIdHex)
    throw new Error("WALLET_CHAIN_NOT_612055");
  return w;
}
async function connectWallet() {
  if (!ui.selected || ui.busy) return;
  ui.busy = true;
  setWalletMsg("Waiting for the wallet connection prompt…");
  try {
    const accounts = await walletCall("eth_requestAccounts");
    ui.account =
      Array.isArray(accounts) && typeof accounts[0] === "string"
        ? lc(accounts[0])
        : null;
    await readWalletIdentity();
    setWalletMsg(
      ui.account === EXPECT.account
        ? "Connected."
        : "Connected account is NOT the approved EOA — STOP.",
    );
  } catch (e) {
    setWalletMsg(
      e && e.code === 4001
        ? "Connection rejected in the wallet."
        : `Wallet error: ${e && e.message ? e.message : e}`,
    );
  } finally {
    ui.busy = false;
    render();
  }
}
// Separate owner step, never in the same click as the transaction. A successful switch triggers a full refresh.
async function switchChain() {
  if (!ui.selected || ui.busy) return;
  ui.busy = true;
  setWalletMsg("Waiting for the wallet network switch prompt…");
  try {
    await walletCall("wallet_switchEthereumChain", [
      { chainId: EXPECT.chainIdHex },
    ]);
    ui.needAdd = false;
    setWalletMsg("Network switch accepted by the wallet.");
  } catch (e) {
    if (e && e.code === 4902) {
      ui.needAdd = true;
      setWalletMsg(
        "ONEchain is not configured in this wallet. Use the separate “Add ONEchain” step.",
      );
    } else
      setWalletMsg(
        e && e.code === 4001
          ? "Network switch rejected."
          : `Wallet error: ${e && e.message ? e.message : e}`,
      );
  } finally {
    ui.busy = false;
  }
  const before = ui.chainId;
  await readWalletIdentity().catch(() => undefined);
  if (ui.chainId === EXPECT.chainIdHex && before !== EXPECT.chainIdHex)
    await refreshAfterSwitch();
  render();
}
async function addChain() {
  if (!ui.selected || ui.busy) return;
  ui.busy = true;
  setWalletMsg("Waiting for the wallet add-network prompt…");
  try {
    await walletCall("wallet_addEthereumChain", [ADD_ONECHAIN]);
    ui.needAdd = false;
    setWalletMsg(
      "Network added. Switch to it with the switch step if the wallet did not.",
    );
  } catch (e) {
    setWalletMsg(
      e && e.code === 4001
        ? "Add-network rejected."
        : `Wallet error: ${e && e.message ? e.message : e}`,
    );
  } finally {
    ui.busy = false;
  }
  await readWalletIdentity().catch(() => undefined);
  render();
}
let refreshing = false;
async function refreshAfterSwitch() {
  const s = ui.snap;
  if (
    refreshing ||
    !s ||
    !["READY", "BLOCKED", "DRY_RUN_COMPLETE"].includes(s.state)
  )
    return;
  refreshing = true;
  setWalletMsg(
    "Wallet is on ONEchain 612055 — re-running the full read-only preflight…",
  );
  try {
    await api("refresh");
    resetConfirmations(
      "Preflight refreshed after the network switch — review and confirm again.",
    );
    setWalletMsg("Full preflight refreshed after the network switch.");
  } catch (e) {
    setWalletMsg(`Preflight refresh failed: ${e.code || e.message}`);
  } finally {
    refreshing = false;
    render();
  }
}

// The single wallet write. Guarded twice: in memory and in sessionStorage (a reload never re-enables it), and
// the server never releases the parameters a second time.
function requestWalletConfirmationOnce(provider, tx) {
  if (ui.sendAttempted) throw new Error("SECOND_WALLET_REQUEST_REFUSED");
  ui.sendAttempted = true;
  try {
    sessionStorage.setItem("g7-send-attempted", ui.snap.sessionId);
  } catch {
    // in-memory guard and the server-side one-shot still hold
  }
  return provider.request({ method: "eth_sendTransaction", params: [tx] });
}

// ------------------------------------------------------------------ the owner's click
function confirmationsComplete() {
  return (
    $("chk-scope").checked &&
    $("chk-trust").checked &&
    $("phrase").value === EXPECT.phrase
  );
}
function canSend() {
  const s = ui.snap;
  const review = s && s.preflight && s.preflight.review;
  return (
    !!s &&
    (s.mode === "real" || s.mode === "dry-run") &&
    s.state === "READY" &&
    !s.busy &&
    s.sendCapability === true &&
    !!review &&
    !ui.busy &&
    !ui.sendAttempted &&
    !ui.armedLocally &&
    ui.localCheck.ok &&
    ui.localCheck.forDigest === review.intentDigest &&
    !!ui.selected &&
    ui.account === EXPECT.account &&
    ui.chainId === EXPECT.chainIdHex &&
    confirmationsComplete()
  );
}
async function reportWalletResult(armId, body) {
  for (let i = 0; i < 4; i++) {
    try {
      return await api("wallet-result", { armId, ...body });
    } catch (e) {
      if (e.code && !/^HTTP_5|INTERNAL/.test(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error("WALLET_RESULT_NOT_RECORDED");
}
async function onSend() {
  if (!canSend()) return;
  ui.busy = true;
  render();
  const reviewed = ui.snap.preflight.review;
  const reviewedDigest = reviewed.intentDigest;
  const wallet = () => ({ account: ui.account, chainId: ui.chainId });
  try {
    setSendMsg("Checking the wallet account and network…");
    await assertWalletIdentity();
    const local = await verifyReview(reviewed);
    if (!local.ok || local.digest !== reviewedDigest)
      throw new Error(`LOCAL_VERIFICATION_FAILED ${local.failures.join(",")}`);
    setSendMsg("Running the fresh final mainnet preflight (read-only)…");
    const fin = await api("final", {
      intentDigest: reviewedDigest,
      confirmations: {
        scope: $("chk-scope").checked,
        trust: $("chk-trust").checked,
        phrase: $("phrase").value,
      },
      wallet: wallet(),
    });
    if (fin.outcome !== "ARMABLE") {
      const text = {
        INTENT_CHANGED:
          "The fresh final quote changed the transaction. Review the new values and confirm again.",
        QUOTE_TOO_OLD:
          "The fresh final quote was too old at decision time. Press the button again.",
        OWNER_REAPPROVAL_REQUIRED:
          "OWNER_REAPPROVAL_REQUIRED — an owner-approved bound is exceeded. STOP.",
        BLOCKED:
          "BLOCKED — a fresh preflight gate failed. See the reasons above.",
        EXPIRED: "Session expired — restart the harness.",
      }[fin.outcome];
      setSendMsg(`${text || fin.outcome} No wallet request was made.`, "bad");
      return;
    }
    const fresh = ui.snap.preflight.review;
    const freshLocal = await verifyReview(fresh);
    if (
      fresh.intentDigest !== reviewedDigest ||
      !freshLocal.ok ||
      freshLocal.digest !== reviewedDigest
    )
      throw new Error(
        `FRESH_REVIEW_NOT_IDENTICAL ${freshLocal.failures.join(",")}`,
      );
    await assertWalletIdentity();
    setSendMsg("Releasing the one-shot transaction parameters…");
    const t0 = performance.now();
    const arm = await api("arm", {
      candidateId: fin.candidateId,
      intentDigest: reviewedDigest,
      wallet: wallet(),
    });
    if (arm.dryRun) {
      $("txparams").textContent =
        `DRY RUN — the wallet request was suppressed. It would have carried:\n${JSON.stringify(arm.wouldSend, null, 2)}`;
      setSendMsg(
        "DRY RUN COMPLETE — every check passed; the wallet request was suppressed. Nothing was sent.",
        "ok",
      );
      return;
    }
    // Armed: the one-shot capability is consumed on the server. From here on there is no retry of any kind.
    ui.armedLocally = true;
    let abort = null;
    if (arm.intentDigest !== reviewedDigest) abort = "ARMED_DIGEST_DIFFERS";
    else if (!sameTx(arm.tx, fresh.tx) || !sameTx(arm.tx, reviewed.tx))
      abort = "ARMED_TX_DIFFERS_FROM_REVIEW";
    else {
      const v = await verifyReview({
        intent: arm.intent,
        intentDigest: arm.intentDigest,
        tx: arm.tx,
      });
      if (!v.ok) abort = `ARMED_TX_VERIFY:${v.failures.join(",")}`;
    }
    if (!abort)
      try {
        await assertWalletIdentity();
      } catch (e) {
        abort = e.message;
      }
    const quoteAge = Math.ceil(arm.quoteAgeMs + (performance.now() - t0));
    if (!abort && quoteAge > EXPECT.quoteMaxAgeAtWalletMs)
      abort = `QUOTE_AGE_${quoteAge}MS_ABOVE_20S`;
    if (abort) {
      await reportWalletResult(arm.armId, {
        outcome: "ABORTED_BEFORE_WALLET_REQUEST",
        errorMessage: abort,
      });
      setSendMsg(
        `Stopped before any wallet request: ${abort}. The one-shot capability is consumed; no retry.`,
        "bad",
      );
      return;
    }
    setSendMsg(
      "Waiting for YOUR confirmation in the wallet. Check every field there; reject if anything differs.",
    );
    const walletRequestAt = Date.now();
    let result, error;
    try {
      await api("wallet-attempt", { armId: arm.armId });
      result = await requestWalletConfirmationOnce(
        ui.selected.provider,
        exactTx(arm.tx),
      );
    } catch (e) {
      error = e || new Error("UNKNOWN_PROVIDER_ERROR");
    }
    const common = { quoteAgeAtWalletRequestMs: quoteAge, walletRequestAt };
    if (error) {
      const code = typeof error === "object" ? error.code : undefined;
      const message = String((error && error.message) || error).slice(0, 300);
      if (code === 4001) {
        await reportWalletResult(arm.armId, {
          outcome: "USER_REJECTED",
          errorCode: 4001,
          errorMessage: message,
          ...common,
        });
        setSendMsg(
          "USER_REJECTED — the request was rejected in the wallet. STOP: no retry.",
          "bad",
        );
      } else {
        await reportWalletResult(arm.armId, {
          outcome: "PROVIDER_ERROR",
          errorCode:
            typeof code === "number" || typeof code === "string" ? code : null,
          errorMessage: message,
          ...common,
        });
        setSendMsg(
          "MANUAL_REVIEW_REQUIRED — the wallet returned an error. Do NOT retry; the harness keeps watching the chain read-only.",
          "bad",
        );
      }
      return;
    }
    if (typeof result === "string" && /^0x[0-9a-fA-F]{64}$/.test(result)) {
      ui.lastHash = result;
      setSendMsg(
        `Transaction hash from the wallet: ${result} — recording it and starting read-only tracking…`,
        "ok",
      );
      await reportWalletResult(arm.armId, {
        outcome: "TX_HASH",
        txHash: result,
        ...common,
      });
      setSendMsg(
        `Transaction hash from the wallet: ${result} — read-only tracking started. Never resend.`,
        "ok",
      );
    } else {
      await reportWalletResult(arm.armId, {
        outcome: "PROVIDER_ERROR",
        errorMessage: `UNEXPECTED_RESULT:${String(result).slice(0, 120)}`,
        ...common,
      });
      setSendMsg(
        "MANUAL_REVIEW_REQUIRED — unexpected wallet result. Do NOT retry.",
        "bad",
      );
    }
  } catch (e) {
    const tail = ui.lastHash
      ? ` · TRANSACTION HASH ${ui.lastHash} — it was broadcast; never resend. Track read-only: pnpm g7:track --tx ${ui.lastHash}`
      : ui.armedLocally
        ? " · the one-shot capability is consumed; do not retry."
        : " — no wallet request was made.";
    setSendMsg(`${e.code || e.message}${tail}`, "bad");
  } finally {
    ui.busy = false;
    render();
  }
}

// ------------------------------------------------------------------ rendering
function setSendMsg(text, cls = "") {
  const el = $("send-msg");
  el.textContent = text;
  el.className = `msg ${cls}`;
}
function setWalletMsg(text) {
  $("wallet-msg").textContent = text;
}
function resetConfirmations(note) {
  const had =
    $("chk-scope").checked ||
    $("chk-trust").checked ||
    $("phrase").value !== "";
  $("chk-scope").checked = false;
  $("chk-trust").checked = false;
  $("phrase").value = "";
  if (had && note) setSendMsg(note);
}
function applySnapshot(s) {
  ui.snap = s;
  ui.clockOffset = s.serverNow - Date.now();
  const digest =
    s.preflight && s.preflight.review ? s.preflight.review.intentDigest : null;
  if (digest !== ui.reviewDigest) {
    const first = ui.reviewDigest === null;
    ui.reviewDigest = digest;
    ui.localCheck = { ok: false, failures: ["verifying…"], forDigest: null };
    if (!first)
      resetConfirmations(
        "The transaction values changed — review them and confirm again.",
      );
    if (digest) {
      const review = s.preflight.review;
      void verifyReview(review).then((r) => {
        if (ui.reviewDigest !== digest) return;
        ui.localCheck = {
          ok: r.ok && r.digest === digest,
          failures: r.failures,
          forDigest: digest,
        };
        render();
      });
    }
  }
  render();
}
const BANNERS = {
  PREFLIGHT_RUNNING: ["Running the fresh read-only mainnet preflight…", "", ""],
  READY: [
    "READY — waiting for the owner's manual confirmation",
    "Review every value below. The button unlocks only with both boxes ticked, the exact phrase typed, and the approved account on ONEchain 612055.",
    "ok",
  ],
  BLOCKED: [
    "BLOCKED — a fresh preflight gate failed",
    "No wallet request is possible. You may re-run the read-only preflight.",
    "bad",
  ],
  OWNER_REAPPROVAL_REQUIRED: [
    "OWNER_REAPPROVAL_REQUIRED — STOP",
    "A fresh value exceeds an owner-approved bound. No wallet request will be made in this session.",
    "bad",
  ],
  FINAL_PREFLIGHT_RUNNING: [
    "Fresh final mainnet preflight running…",
    "Read-only. Nothing has been requested from the wallet.",
    "",
  ],
  ARMABLE: ["Final preflight passed — releasing the one-shot request…", "", ""],
  ARMED: [
    "One-shot wallet request released — waiting for the wallet result",
    "Do NOT retry. If you closed the page, the harness watches the chain read-only for a transfer from your EOA.",
    "warn",
  ],
  DRY_RUN_COMPLETE: [
    "DRY RUN COMPLETE — no wallet request was made",
    "Every check passed and the request was suppressed.",
    "ok",
  ],
  SENT: [
    "Submitted by your wallet — read-only tracking",
    "Wait for the source receipt and the BSC settlement. Never resend.",
    "ok",
  ],
  G7_PASS: [
    "G7 PASS — exact on-chain evidence on ONEchain and BSC",
    "Source receipt, BridgeInitiated, BridgeFinalized and the canonical CROSS transfer all match.",
    "ok",
  ],
  USER_REJECTED: [
    "USER_REJECTED — STOP",
    "The wallet request was rejected. No retry in this approval.",
    "bad",
  ],
  MANUAL_REVIEW_REQUIRED: [
    "MANUAL_REVIEW_REQUIRED — do not retry",
    "The outcome is uncertain or anomalous. The harness keeps observing read-only.",
    "bad",
  ],
  ABORTED_BEFORE_WALLET_REQUEST: [
    "Stopped before any wallet request",
    "The one-shot capability is consumed. A new attempt needs a new explicit owner approval.",
    "bad",
  ],
  LOCKED: [
    "LOCKED — this owner approval was already used",
    "A previous run consumed the one-shot capability (lock file). This run only observes.",
    "bad",
  ],
  EXPIRED: [
    "Session expired",
    "Restart the harness for a fresh preflight.",
    "bad",
  ],
};
function renderBanner(s) {
  const [title, text, cls] = BANNERS[s.state] || [s.state, "", ""];
  $("banner").className = `banner ${cls}`;
  $("banner-title").textContent = title;
  $("banner-text").textContent = text;
  const reasons = $("banner-reasons");
  clear(reasons);
  const list =
    s.state === "OWNER_REAPPROVAL_REQUIRED"
      ? s.preflight.reapprovalReasons
      : s.state === "BLOCKED"
        ? s.preflight.blockedReasons
        : [];
  for (const r of list || []) reasons.append(node("li", r));
  $("refresh").hidden = !["BLOCKED", "DRY_RUN_COMPLETE"].includes(s.state);
  $("refresh").disabled = ui.busy || s.busy;
  const badge = $("mode-badge");
  badge.textContent = `${s.mode === "real" ? "REAL · OWNER-APPROVED" : "DRY RUN"}${s.fixture ? " · FIXTURE TEST" : ""}`;
  badge.className = `badge ${s.fixture ? "fixture" : s.mode === "real" ? "real" : "dry"}`;
  $("session-id").textContent =
    `${s.sessionId} · expires ${new Date(s.expiresAt).toLocaleTimeString()}`;
}
function quoteAgeText(review) {
  const age = (Date.now() + ui.clockOffset - review.quote.observedAt) / 1000;
  return `${age.toFixed(1)} s (this display quote) · the button takes a fresh final quote, which must be ≤ 20 s old at the wallet request`;
}
function renderReview(s) {
  const review = s.preflight && s.preflight.review;
  if (!review) {
    kv($("review"), [["Status", "No transaction (preflight not READY)"]]);
    $("calldata").textContent = "";
    $("txparams").textContent = "";
    return;
  }
  const i = review.intent;
  const t = review.tx;
  const chip = $("local-check");
  if (ui.localCheck.forDigest === review.intentDigest) {
    chip.textContent = ui.localCheck.ok
      ? "verified in this browser ✓"
      : `BROWSER CHECK FAILED: ${ui.localCheck.failures.join(", ")}`;
    chip.className = `chip ${ui.localCheck.ok ? "ok" : "bad"}`;
  } else {
    chip.textContent = "verifying…";
    chip.className = "chip";
  }
  const sum = s.preflight.summary;
  kv($("review"), [
    ["Network", `ONEchain mainnet · chainId ${i.sourceChainId} (source)`],
    ["FROM", i.from, "mono"],
    ["Contract (to)", `${i.to} — ONEbridge proxy (pinned)`, "mono"],
    [
      "Recipient",
      `${i.recipient}${eq(i.recipient, i.from) ? "  (same as FROM)" : "  ⚠ DIFFERENT FROM FROM"}`,
      "mono",
    ],
    [
      "Destination",
      `BNB Smart Chain · chainId ${i.destinationChainId} · canonical CROSS ${EXPECT.cross}`,
      "mono",
    ],
    ["Principal", `${one(i.principal)}  (${i.principal} wei)`],
    [
      "Network fee",
      `${one(i.networkFee)}  (${i.networkFee} wei) · owner bound ≤ 0.18 ONE`,
    ],
    [
      "Service fee",
      `${one(i.serviceFee)}  (${i.serviceFee} wei) · owner bound = 0`,
    ],
    ["Otherbridge fee", "0"],
    [
      "Exact msg.value",
      `${one(i.value)}  (${i.value} wei · ${t.value})`,
      "mono",
    ],
    ["Gas limit", `${i.gasLimit}  (${t.gas})`],
    [
      "Max fee",
      `maxFeePerGas ${gwei(i.maxFeePerGas)} · maxPriorityFeePerGas ${gwei(i.maxPriorityFeePerGas)} · exposure cap ${gwei(i.priceCapForExposure)}`,
    ],
    [
      "Maximum wallet debit",
      `${one(i.maximumWalletDebit)} · owner bound ≤ 5.18075931 ONE`,
    ],
    [
      "Expected receive",
      `${units(i.expectedReceive.amount)} CROSS on BSC (canonical CROSS ${EXPECT.cross})`,
    ],
    ["Function / selector", `${i.function} · ${i.selector}`, "mono"],
    ["Calldata hash", `keccak256 ${i.calldataKeccak256}`, "mono"],
    ["Intent digest", `sha256 ${review.intentDigest}`, "mono"],
    ["Quote age", quoteAgeText(review)],
    [
      "Quote blocks",
      `ONE ${review.quote.sourceBlock} (${review.quote.sourceBlockHash}) · BSC finalized ${review.quote.destinationBlock} (${review.quote.destinationBlockHash})`,
      "mono",
    ],
    ["Approvals / permits", "none (native ONE route)"],
    [
      "Source balance",
      sum && sum.balance ? `${one(sum.balance)} at the quote block` : null,
    ],
    [
      "Wallet request",
      "exactly one send-transaction request after your click — your wallet asks you to confirm",
    ],
  ]);
  $("calldata").textContent =
    `calldata (${(t.data.length - 2) / 2} bytes):\n${t.data}`;
  if (!$("txparams").textContent.startsWith("DRY RUN"))
    $("txparams").textContent =
      `wallet request params[0]:\n${JSON.stringify(exactTx(t), null, 2)}`;
}
function renderTrust(s) {
  $("trust-statement").textContent = s.constants.trustStatement;
  const review = s.preflight && s.preflight.review;
  if (!review) return kv($("trust"), []);
  const src = review.intent.trust.source;
  const dst = review.intent.trust.destination;
  const sameSets = JSON.stringify(src) === JSON.stringify(dst);
  kv($("trust"), [
    [
      "Upgrade authority",
      `${src.admins.join(", ")} — single admin EOA, instant UUPS upgrade`,
      "mono",
    ],
    ["Settlement validators", src.validators.join("\n"), "mono wrap"],
    ["Threshold", `${src.threshold}-of-${src.validators.length}`],
    ["VERIFIER_ROLE", src.verifierRole.join(", "), "mono"],
    ["Same sets on BSC", sameSets ? "yes" : "NO — see the gate table"],
    ["You accept", s.constants.trustAcceptance],
  ]);
}
function renderProviders() {
  const sel = $("provider");
  const current = ui.selected ? ui.providers.indexOf(ui.selected) : -1;
  clear(sel);
  if (!ui.providers.length) {
    const o = node(
      "option",
      fixtureMode()
        ? "waiting for the test mock wallet…"
        : "no injected wallet found",
    );
    o.value = "";
    sel.append(o);
  }
  ui.providers.forEach((p, idx) => {
    const o = node("option", `${p.name}${p.rdns ? ` (${p.rdns})` : ""}`);
    o.value = String(idx);
    sel.append(o);
  });
  if (current >= 0) sel.value = String(current);
  else if (ui.providers.length) selectProvider(0);
  render();
}
function renderWallet(s) {
  const okAccount = ui.account === EXPECT.account;
  const okChain = ui.chainId === EXPECT.chainIdHex;
  kv($("wallet"), [
    ["Required account", EXPECT.account, "mono"],
    [
      "Wallet account",
      ui.account
        ? `${ui.account}  ${okAccount ? "✓ matches" : "✗ NOT the approved EOA — STOP"}`
        : "not connected",
      `mono ${ui.account ? (okAccount ? "ok-text" : "bad-text") : ""}`,
    ],
    [
      "Wallet network",
      ui.chainId
        ? `${ui.chainId} (${Number(BigInt(ui.chainId))})  ${okChain ? "✓ ONEchain 612055" : "✗ not ONEchain — use the separate switch step"}`
        : "unknown",
      ui.chainId ? (okChain ? "ok-text" : "bad-text") : "",
    ],
  ]);
  const locked =
    ui.busy || ui.sendAttempted || ui.armedLocally || (s && s.terminal);
  $("connect").disabled = !ui.selected || locked;
  $("provider").disabled = locked;
  $("switch").hidden = !ui.account || okChain;
  $("switch").disabled = locked;
  $("add-chain").hidden = !ui.needAdd || okChain;
  $("add-chain").disabled = locked;
}
function renderTracking(s) {
  const show = !!(
    s.armed ||
    s.walletResult ||
    s.txHash ||
    s.lock ||
    s.state === "DRY_RUN_COMPLETE"
  );
  $("track-panel").hidden = !show;
  if (!show) return;
  const t = s.tracking;
  const w = s.walletResult;
  const rows = [
    ["Session state", s.state],
    [
      "Transaction hash",
      s.txHash
        ? `${s.txHash}${s.hashSource === "chain-detected" ? "  (detected on chain, not reported by the wallet)" : ""}`
        : "—",
      "mono",
    ],
    [
      "Wallet result",
      w
        ? `${w.outcome}${w.errorCode !== undefined && w.errorCode !== null ? ` (code ${w.errorCode})` : ""}${w.errorMessage ? ` · ${w.errorMessage}` : ""}`
        : "—",
    ],
    [
      "Quote age at wallet request",
      w && typeof w.quoteAgeAtWalletRequestMs === "number"
        ? `${(w.quoteAgeAtWalletRequestMs / 1000).toFixed(2)} s`
        : "—",
    ],
    ["Armed transaction digest", s.armed ? s.armed.intentDigest : "—", "mono"],
  ];
  if (t) {
    rows.push(
      [
        "Tracking status",
        `${t.status}${t.g7Pass ? " · G7 PASS conditions met" : ""}`,
      ],
      ["Reasons", t.reasons.join("; ")],
      [
        "Mined tx vs armed",
        t.txCheck.found
          ? t.txCheck.exact
            ? "byte-identical (from/to/value/input)"
            : `DIFFERS: ${t.txCheck.mismatches.join(", ")}`
          : "not mined yet",
      ],
      [
        "Source receipt",
        t.source.found
          ? `status ${t.source.status} · block ${t.source.block} · confirmations ${t.source.confirmations ?? "—"} · canonical ${t.source.canonical}`
          : "not found yet",
      ],
      [
        "BridgeInitiated",
        t.source.index
          ? `index ${t.source.index} · recipient ${t.source.recipient} · amount ${units(t.source.amount)} ONE`
          : "—",
        "mono",
      ],
      [
        "BSC event",
        t.destination.event
          ? `${t.destination.event} · tx ${t.destination.txHash} · block ${t.destination.block}`
          : t.destination.searched
            ? "not yet (settlement pending)"
            : "—",
        "mono",
      ],
      [
        "BSC finalized",
        t.destination.finalized === null
          ? "—"
          : `${t.destination.finalized} (finalized head ${t.destination.finalizedBlock})`,
      ],
      [
        "Canonical CROSS Transfer",
        t.destination.payout
          ? `${units(t.destination.payout.amount)} CROSS · ${t.destination.payout.from} → ${t.destination.payout.recipient} · log ${t.destination.payout.logIndex}`
          : "—",
        "mono",
      ],
      ["Next step", t.nextStep],
    );
  }
  if (s.trackingError)
    rows.push(["Tracking error (retrying)", s.trackingError]);
  if (s.detection)
    rows.push([
      "Chain watch (EOA nonces / transfers)",
      `nonces ${s.detection.nonces.join(", ")} · transfers ${s.detection.transfers.length}`,
    ]);
  rows.push(["Automatic resend / releasePending", "never"]);
  kv($("track"), rows);
}
function renderGates(s) {
  const pf = s.preflight;
  const body = $("gates");
  clear(body);
  if (!pf) return kv($("summary"), [["Preflight", "running…"]]);
  for (const g of pf.gates) {
    const tr = document.createElement("tr");
    tr.append(
      node("td", g.id),
      node("td", g.name),
      node("td", g.status, `st-${g.status}`),
      node("td", g.reasons.join("; ")),
    );
    body.append(tr);
  }
  const m = pf.summary;
  if (!m)
    return kv($("summary"), [
      ["Preflight", `${pf.status}${pf.error ? ` · ${pf.error}` : ""}`],
    ]);
  kv($("summary"), [
    [
      "Preflight",
      `${pf.status} · ${pf.kind} · ${pf.id} · decided ${new Date(pf.decisionAt).toLocaleTimeString()}`,
    ],
    ["G5 decision", m.g5],
    ["Runtime drift (ONE/BSC pins)", m.runtimeDrift],
    [
      "Authority drift (validators, threshold, admin, VERIFIER_ROLE)",
      m.authorityDrift,
    ],
    ["Route pair / pauses", `${m.routeRegistration} / ${m.pauses}`],
    [
      "Fees & minimum / owner scope",
      `${m.feesAndMinimum} / ${m.ownerScope} · minimum ${units(m.minimum)} ONE`,
    ],
    [
      "Reserve",
      `${m.reserve.status} · spendable ${m.reserve.spendable} CROSS · verified ${m.reserve.verified} · BSC finalized block ${m.reserve.block}`,
    ],
    [
      "Pending / in-flight",
      `${m.pending.status} · pendingAmount ${m.pending.pendingAmount} · valued active pending ${m.pending.valuedActivePendingCross} · in-flight ${m.pending.inFlightCount} (enumerated ${m.pending.inFlightEnumerated})`,
    ],
    [
      "Simulation",
      `${m.simulation.status} · eth_call ${m.simulation.ethCall.join(" | ")} · estimateGas ${m.simulation.estimateGas.join(" | ")} · negative controls ${m.simulation.negativeControls}`,
    ],
    [
      "Firewall",
      `${m.firewall.status} · positive ${m.firewall.positive} · mutations rejected ${m.firewall.mutationsRejected} · hostile replay ${m.firewall.hostileReplay} · production gate closed ${m.firewall.productionGateClosed}`,
    ],
    ["Dual RPC consensus", m.dualRpc],
    [
      "Quote freshness / no write path",
      `${m.quoteFreshness} / ${m.noWritePath}`,
    ],
  ]);
}
function renderConfirm(s) {
  $("chk-scope-label").textContent = s.constants.checks.scope;
  $("chk-trust-label").textContent = s.constants.checks.trust;
  $("phrase-hint").textContent = EXPECT.phrase;
  const btn = $("send");
  btn.textContent = EXPECT.buttonLabel;
  btn.disabled = !canSend();
  const frozen =
    ui.busy ||
    ui.sendAttempted ||
    ui.armedLocally ||
    s.terminal ||
    s.state !== "READY";
  for (const id of ["chk-scope", "chk-trust", "phrase"])
    $(id).disabled = frozen;
}
function render() {
  const s = ui.snap;
  if (!s) return;
  renderBanner(s);
  renderReview(s);
  renderTrust(s);
  renderWallet(s);
  renderConfirm(s);
  renderTracking(s);
  renderGates(s);
}

// ------------------------------------------------------------------ boot
async function boot() {
  ui.token = readToken();
  if (!ui.token) {
    $("banner-title").textContent = "Missing session token";
    $("banner-text").textContent =
      "Open the exact local URL printed by `pnpm g7:pilot` (it carries the token in the # fragment).";
    return;
  }
  try {
    const claimed = await api("claim");
    ui.csrf = claimed.csrf;
  } catch (e) {
    $("banner-title").textContent = `Session rejected: ${e.code || e.message}`;
    return;
  }
  try {
    if (sessionStorage.getItem("g7-send-attempted") === ui.snap.sessionId)
      ui.sendAttempted = true;
  } catch {
    // no storage: the server-side one-shot still holds
  }
  discoverWallets();
  $("provider").addEventListener("change", (e) => {
    const idx = Number(e.target.value);
    if (Number.isInteger(idx)) selectProvider(idx);
  });
  $("connect").addEventListener("click", () => void connectWallet());
  $("switch").addEventListener("click", () => void switchChain());
  $("add-chain").addEventListener("click", () => void addChain());
  $("refresh").addEventListener("click", async () => {
    if (ui.busy) return;
    ui.busy = true;
    render();
    try {
      await api("refresh");
    } catch (e) {
      setSendMsg(`Refresh failed: ${e.code || e.message}`, "bad");
    } finally {
      ui.busy = false;
      render();
    }
  });
  for (const id of ["chk-scope", "chk-trust"])
    $(id).addEventListener("change", render);
  $("phrase").addEventListener("input", render);
  $("send").addEventListener("click", () => void onSend());
  setInterval(() => {
    if (!ui.busy && ui.inflight === 0) void api("state").catch(() => undefined);
  }, 2500);
  setInterval(() => {
    const s = ui.snap;
    if (s && s.preflight && s.preflight.review && !ui.busy) renderReview(s);
  }, 1000);
}
void boot();
