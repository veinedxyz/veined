// V1.9 Privy connect-only wallet layer: normalized session, single provider adapter, external-wallet controller
// (driven by a deterministic Privy double), store, connect-only configuration and CSP. No network, no wallet.
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANONICAL_TX_FIELDS,
  FORBIDDEN_WALLET_METHODS,
  TRUSTED_CHAINS,
  WalletProviderAdapter,
  compareCanonicalTx,
  type Eip1193Like,
  type WalletTxRequest,
} from "../../src/features/wallet/adapter";
import {
  ExternalWalletController,
  type PrivyWalletLike,
} from "../../src/features/wallet/controller";
import {
  normalizeExternalWallet,
  pickActiveWallet,
  sanitizeWalletIcon,
  sessionFingerprint,
  walletKey,
  type WalletSession,
} from "../../src/features/wallet/session";
import { EMPTY_SESSION, walletStore } from "../../src/features/wallet/store";
import {
  ONECHAIN,
  WALLET_LIST,
  privyConnectOnlyConfig,
  validPrivyAppId,
} from "../../src/features/wallet/privy/config";
import { PRIVY_CSP, contentSecurityPolicy } from "../../src/proxy";
import { submit } from "../../src/features/bridge/submission";
import { CROSS } from "../../src/core/model";
import { privyStyleInventory } from "../helpers/privy-style-inventory";

const A = "0x3333333333333333333333333333333333333333";
const B = "0x4444444444444444444444444444444444444444";
const PILOT = "0xb6Ded1B18464aED61DB794dFC5cb031B45a7cA2c";
const OLD_PILOT = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";

/** Deterministic EIP-1193 wallet double with a recording request log and controllable events. */
function walletDouble(opts: { account?: string; chain?: string } = {}) {
  let account = opts.account ?? A;
  let chain = opts.chain ?? "0x956d7";
  const listeners: Record<string, ((v: unknown) => void)[]> = {};
  const calls: { method: string; params: unknown }[] = [];
  const provider: Eip1193Like & {
    calls: typeof calls;
    emit: (event: string, value: unknown) => void;
    set: (next: { account?: string; chain?: string }) => void;
    listenerCount: () => number;
    sendResult: unknown;
  } = {
    calls,
    sendResult: `0x${"ab".repeat(32)}`,
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === "eth_accounts") return account ? [account] : [];
      if (method === "eth_chainId") return chain;
      if (method === "eth_sendTransaction") return provider.sendResult;
      if (
        method === "wallet_switchEthereumChain" ||
        method === "wallet_addEthereumChain" ||
        method === "wallet_watchAsset"
      )
        return null;
      throw Object.assign(new Error(`unexpected ${method}`), { code: 4200 });
    },
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
    },
    removeListener(event, fn) {
      listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
    },
    emit(event, value) {
      (listeners[event] ?? []).slice().forEach((fn) => fn(value));
    },
    set(next) {
      if (next.account !== undefined) account = next.account;
      if (next.chain !== undefined) chain = next.chain;
    },
    listenerCount: () =>
      Object.values(listeners).reduce((n, l) => n + l.length, 0),
  };
  return provider;
}
/** Deterministic Privy ConnectedWallet double (what useConnectWallet's onSuccess hands over). */
function privyWallet(
  provider: Eip1193Like,
  overrides: Partial<PrivyWalletLike> = {},
): PrivyWalletLike & { disconnect: ReturnType<typeof vi.fn> } {
  return {
    type: "ethereum",
    address: A,
    chainId: "eip155:612055",
    walletClientType: "metamask",
    connectorType: "injected",
    imported: false,
    meta: {
      name: "MetaMask",
      id: "io.metamask",
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
    },
    getEthereumProvider: async () => provider,
    disconnect: vi.fn(),
    ...overrides,
  } as PrivyWalletLike & { disconnect: ReturnType<typeof vi.fn> };
}
function sink() {
  let session: WalletSession = { ...EMPTY_SESSION };
  const history: WalletSession[] = [];
  return {
    get: () => session,
    set(next: WalletSession) {
      if (session.provider && session.provider !== next.provider)
        session.provider.revoke();
      session = next;
      history.push(next);
    },
    history,
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
async function until(fn: () => boolean) {
  for (let i = 0; i < 200 && !fn(); i++) await settle();
  expect(fn()).toBe(true);
}
const canonical = (): WalletTxRequest => ({
  from: PILOT.toLowerCase(),
  to: "0xb81d6e000000000000000000000000000000c0de",
  value: "0x47e5e7bd30c18000",
  data: `0x5fd262de${"00".repeat(256)}`,
  gas: "0x2513e",
  maxFeePerGas: "0x12a05f200",
  maxPriorityFeePerGas: "0xb2d05e00",
  chainId: "0x956d7",
});

afterEach(() => {
  walletStore.set({ ...EMPTY_SESSION });
});

describe("V1.9 normalized wallet session", () => {
  it("normalizes a Privy external EVM wallet (isEmbedded false, explicit key, caip2 chain)", () => {
    const n = normalizeExternalWallet(privyWallet(walletDouble()));
    expect(n).toMatchObject({
      address: A,
      chainId: 612055,
      walletClientType: "metamask",
      connectorType: "injected",
      walletName: "MetaMask",
      walletId: "io.metamask",
      key: walletKey("injected", "metamask", A),
    });
    expect(n.walletIcon?.kind).toBe("data");
  });
  it.each([
    [{ walletClientType: "privy" }, "EMBEDDED_WALLET_REFUSED"],
    [{ walletClientType: "privy-v2" }, "EMBEDDED_WALLET_REFUSED"],
    [{ connectorType: "embedded" }, "EMBEDDED_WALLET_REFUSED"],
    [{ connectorType: "embedded_imported" }, "EMBEDDED_WALLET_REFUSED"],
    [{ imported: true }, "EMBEDDED_WALLET_REFUSED"],
    [{ walletClientType: "coinbase_smart_wallet" }, "SMART_WALLET_REFUSED"],
    [{ walletClientType: "base_account" }, "SMART_WALLET_REFUSED"],
  ])("refuses embedded / smart accounts %j", (override, code) => {
    expect(() =>
      normalizeExternalWallet(privyWallet(walletDouble(), override)),
    ).toThrow(code);
  });
  it("EVM boundary: a Phantom Solana identity never becomes an EVM signer", () => {
    expect(() =>
      normalizeExternalWallet(
        privyWallet(walletDouble(), {
          type: "solana",
          walletClientType: "phantom",
          address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
          chainId: "solana:mainnet",
        }),
      ),
    ).toThrow("WALLET_NOT_EVM");
    expect(() =>
      normalizeExternalWallet(
        privyWallet(walletDouble(), {
          walletClientType: "phantom",
          address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
        }),
      ),
    ).toThrow("WALLET_NOT_EVM");
  });
  it.each([
    ["0x123", "WALLET_NOT_EVM"],
    [`0x${"g".repeat(40)}`, "WALLET_NOT_EVM"],
    [` ${A}`, "WALLET_NOT_EVM"],
    [42, "WALLET_NOT_EVM"],
  ])("refuses a malformed address %s", (address, code) => {
    expect(() =>
      normalizeExternalWallet(
        privyWallet(walletDouble(), { address: address as string }),
      ),
    ).toThrow(code);
  });
  it.each(["eip155:0", "eip155:-1", "solana:mainnet", "0x", "", "eip155:1e3"])(
    "refuses an invalid chain %s",
    (chainId) => {
      expect(() =>
        normalizeExternalWallet(privyWallet(walletDouble(), { chainId })),
      ).toThrow("WALLET_CHAIN_INVALID");
    },
  );
  it("wallet icons: inline data or a bundled component only — never a remote URL", () => {
    expect(sanitizeWalletIcon("data:image/png;base64,AAAA")).toEqual({
      kind: "data",
      src: "data:image/png;base64,AAAA",
    });
    const component = () => null;
    expect(sanitizeWalletIcon(component)).toEqual({
      kind: "component",
      component,
    });
    for (const bad of [
      "https://evil.example/logo.png",
      "http://127.0.0.1/x.svg",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "//cdn.example/logo.svg",
      "data:image/svg+xml,\u0000",
      "x".repeat(10),
      42,
      null,
    ])
      expect(sanitizeWalletIcon(bad)).toBeNull();
  });
  it("wallet names are bounded labels; anything else falls back to the client type", () => {
    const n = normalizeExternalWallet(
      privyWallet(walletDouble(), {
        meta: { name: "<img src=x onerror=alert(1)>", id: "x" },
      }),
    );
    expect(n.walletName).toBe("metamask");
  });
  it("active wallet = explicit key only; linked-wallet order is never a signer choice", () => {
    const w1 = privyWallet(walletDouble(), { address: A });
    const w2 = privyWallet(walletDouble(), {
      address: B,
      walletClientType: "rabby_wallet",
    });
    expect(pickActiveWallet([w1, w2], null)).toBeUndefined();
    expect(
      pickActiveWallet([w1, w2], walletKey("injected", "rabby_wallet", B)),
    ).toBe(w2);
    expect(
      pickActiveWallet([w2, w1], walletKey("injected", "metamask", A)),
    ).toBe(w1);
    expect(
      pickActiveWallet([w1], walletKey("injected", "rabby_wallet", B)),
    ).toBeUndefined();
  });
  it("the session fingerprint changes with account, chain, connector and epoch", () => {
    const base = {
      ...EMPTY_SESSION,
      status: "connected" as const,
      address: A,
      chainId: 1,
      connectorType: "injected",
      walletClientType: "metamask",
      epoch: 3,
    };
    const f = sessionFingerprint(base);
    for (const patch of [
      { address: B },
      { chainId: 56 },
      { connectorType: "wallet_connect_v2" },
      { walletClientType: "rabby_wallet" },
      { epoch: 4 },
      { status: "disconnected" as const },
    ])
      expect(sessionFingerprint({ ...base, ...patch })).not.toBe(f);
  });
});

describe("V1.9 single provider adapter", () => {
  const adapter = (p = walletDouble({ account: PILOT, chain: "0x956d7" })) =>
    ({
      p,
      a: new WalletProviderAdapter(p, {
        address: PILOT,
        chainId: 612055,
        epoch: 1,
      }),
    }) as const;
  it("exposes no generic request method (no path to signing or raw broadcast)", () => {
    const { a } = adapter();
    expect("request" in a).toBe(false);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(a)).sort()).toEqual(
      [
        "addChain",
        "address",
        "constructor",
        "epoch",
        "identity",
        "on",
        "read",
        "revoke",
        "revoked",
        "sendCanonicalTransaction",
        "sendManualTransaction",
        "switchChain",
        "switchManualBase",
        "watchCanonicalCross",
      ].sort(),
    );
    for (const m of [
      "personal_sign",
      "eth_sign",
      "eth_signTypedData_v4",
      "eth_sendRawTransaction",
    ])
      expect(FORBIDDEN_WALLET_METHODS).toContain(m);
  });
  it("read() allows only eth_accounts and eth_chainId", async () => {
    const { a, p } = adapter();
    await expect(a.read("eth_accounts")).resolves.toEqual([PILOT]);
    await expect(a.read("eth_chainId")).resolves.toBe("0x956d7");
    for (const m of [...FORBIDDEN_WALLET_METHODS, "eth_sendTransaction"])
      expect(() => a.read(m as "eth_accounts")).toThrow(
        "WALLET_METHOD_FORBIDDEN",
      );
    expect(p.calls.map((c) => c.method)).toEqual([
      "eth_accounts",
      "eth_chainId",
    ]);
  });
  it("chain switch only to the trusted registry; add-chain parameters come only from it", async () => {
    const { a, p } = adapter();
    await a.switchChain(612055);
    await a.switchChain(56);
    await expect(a.switchChain(1)).rejects.toThrow("WALLET_CHAIN_NOT_TRUSTED");
    await a.addChain(612055);
    await expect(a.addChain(56)).rejects.toThrow("WALLET_CHAIN_NOT_TRUSTED");
    expect(p.calls).toEqual([
      {
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x956d7" }],
      },
      { method: "wallet_switchEthereumChain", params: [{ chainId: "0x38" }] },
      {
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x956d7",
            chainName: "ONEchain Mainnet",
            nativeCurrency: { name: "ONE", symbol: "ONE", decimals: 18 },
            rpcUrls: ["https://mainnet.crosstoken.io:22001"],
            blockExplorerUrls: ["https://explorer.onechain.nexus/612055"],
          },
        ],
      },
    ]);
    expect(Object.isFrozen(TRUSTED_CHAINS)).toBe(true);
    expect(TRUSTED_CHAINS[612055].add?.rpcUrls).toEqual(
      ONECHAIN.rpcUrls.default.http,
    );
  });
  it("watch asset is the canonical CROSS only", async () => {
    const { a, p } = adapter();
    await a.watchCanonicalCross();
    expect(p.calls[0]).toEqual({
      method: "wallet_watchAsset",
      params: [
        {
          type: "ERC20",
          options: { address: CROSS, symbol: "CROSS", decimals: 18 },
        },
      ],
    });
  });
  it("sends exactly the canonical transaction (frozen) through the gate, after a live identity read", async () => {
    const { a, p } = adapter();
    const tx = canonical();
    await expect(
      a.sendCanonicalTransaction(tx, { ...tx }, { gate: "g7-local-pilot" }),
    ).resolves.toBe(`0x${"ab".repeat(32)}`);
    const sends = p.calls.filter((c) => c.method === "eth_sendTransaction");
    expect(sends).toHaveLength(1);
    const params = sends[0].params as WalletTxRequest[];
    expect(Object.isFrozen(params)).toBe(true);
    expect(Object.isFrozen(params[0])).toBe(true);
    expect(params[0]).toEqual(tx);
    expect(Object.keys(params[0]).sort()).toEqual(
      [...CANONICAL_TX_FIELDS].sort(),
    );
    // identity read happens before the send
    const order = p.calls.map((c) => c.method);
    expect(order.indexOf("eth_accounts")).toBeLessThan(
      order.indexOf("eth_sendTransaction"),
    );
  });
  it.each(CANONICAL_TX_FIELDS.map((f) => [f]))(
    "a wallet request that differs in %s is refused before the wallet is asked",
    async (field) => {
      const { a, p } = adapter();
      const tx = canonical();
      const mutated = {
        ...tx,
        [field]:
          field === "from" || field === "to"
            ? "0x2222222222222222222222222222222222222222"
            : field === "data"
              ? `${tx.data}00`
              : "0x1",
      };
      await expect(
        a.sendCanonicalTransaction(tx, mutated, { gate: "g7-local-pilot" }),
      ).rejects.toThrow("CANONICAL_TX_MISMATCH");
      expect(p.calls).toEqual([]);
    },
  );
  it("extra, missing or case-changed fields are differences", () => {
    const tx = canonical();
    expect(
      compareCanonicalTx(tx, { ...tx, nonce: "0x1" } as WalletTxRequest),
    ).toContain("unexpected:nonce");
    const { gas: _gas, ...withoutGas } = tx;
    void _gas;
    expect(compareCanonicalTx(tx, withoutGas)).toContain("gas");
    expect(compareCanonicalTx(tx, { ...tx, from: PILOT })).toContain("from");
    expect(compareCanonicalTx({}, {})).toEqual(
      expect.arrayContaining(["missing:chainId", "missing:from", "missing:to"]),
    );
  });
  it("the transaction must be from the session account on the session chain and the live wallet", async () => {
    const p = walletDouble({ account: OLD_PILOT, chain: "0x956d7" });
    const a = new WalletProviderAdapter(p, {
      address: OLD_PILOT,
      chainId: 612055,
      epoch: 1,
    });
    const tx = canonical();
    await expect(
      a.sendCanonicalTransaction(tx, { ...tx }, { gate: "g7-local-pilot" }),
    ).rejects.toThrow("WALLET_ACCOUNT_MISMATCH");
    const { a: b, p: q } = adapter();
    q.set({ account: B });
    await expect(
      b.sendCanonicalTransaction(tx, { ...tx }, { gate: "g7-local-pilot" }),
    ).rejects.toThrow("IDENTITY_CHANGED");
    const { a: c, p: r } = adapter();
    r.set({ chain: "0x38" });
    await expect(
      c.sendCanonicalTransaction(tx, { ...tx }, { gate: "g7-local-pilot" }),
    ).rejects.toThrow("WALLET_CHAIN_MISMATCH");
    const bsc = { ...tx, chainId: "0x38" };
    const { a: d } = adapter();
    await expect(
      d.sendCanonicalTransaction(bsc, { ...bsc }, { gate: "g7-local-pilot" }),
    ).rejects.toThrow("WALLET_CHAIN_MISMATCH");
    for (const x of [q, r])
      expect(x.calls.map((c) => c.method)).not.toContain("eth_sendTransaction");
  });
  it("a revoked (stale) adapter cannot read, switch or send; no gate means no send", async () => {
    const { a, p } = adapter();
    const tx = canonical();
    await expect(
      a.sendCanonicalTransaction(
        tx,
        { ...tx },
        {
          gate: "anything" as "g7-local-pilot",
        },
      ),
    ).rejects.toThrow("EXECUTION_GATE_REQUIRED");
    a.revoke();
    expect(() => a.read("eth_accounts")).toThrow("WALLET_SESSION_STALE");
    await expect(a.switchChain(612055)).rejects.toThrow("WALLET_SESSION_STALE");
    await expect(
      a.sendCanonicalTransaction(tx, { ...tx }, { gate: "g7-local-pilot" }),
    ).rejects.toThrow("WALLET_SESSION_STALE");
    expect(p.calls).toEqual([]);
  });
  it("revocation between the identity read and the send stops the send", async () => {
    const p = walletDouble({ account: PILOT });
    const a = new WalletProviderAdapter(p, {
      address: PILOT,
      chainId: 612055,
      epoch: 1,
    });
    const original = p.request.bind(p);
    p.request = async (args) => {
      const r = await original(args);
      if (args.method === "eth_chainId") a.revoke();
      return r;
    };
    const tx = canonical();
    await expect(
      a.sendCanonicalTransaction(tx, { ...tx }, { gate: "g7-local-pilot" }),
    ).rejects.toThrow("WALLET_SESSION_STALE");
    expect(p.calls.map((c) => c.method)).not.toContain("eth_sendTransaction");
  });
  it("refusals before the wallet is asked are marked beforeWalletRequest; wallet errors are not", async () => {
    const tx = canonical();
    const { a } = adapter();
    const mismatch = await a
      .sendCanonicalTransaction(
        tx,
        { ...tx, value: "0x1" },
        { gate: "g7-local-pilot" },
      )
      .catch((e: { code?: unknown; beforeWalletRequest?: unknown }) => e);
    expect(mismatch).toMatchObject({
      code: "CANONICAL_TX_MISMATCH",
      beforeWalletRequest: true,
    });
    const { a: b, p } = adapter();
    p.set({ account: B });
    const changed = await b
      .sendCanonicalTransaction(tx, { ...tx }, { gate: "g7-local-pilot" })
      .catch((e: { code?: unknown; beforeWalletRequest?: unknown }) => e);
    expect(changed).toMatchObject({
      code: "IDENTITY_CHANGED",
      beforeWalletRequest: true,
    });
    const { a: c } = adapter();
    c.revoke();
    expect(
      await c
        .sendCanonicalTransaction(tx, { ...tx }, { gate: "g7-local-pilot" })
        .catch((e) => e),
    ).toMatchObject({
      code: "WALLET_SESSION_STALE",
      beforeWalletRequest: true,
    });
    const q = walletDouble({ account: PILOT });
    const original = q.request.bind(q);
    q.request = async (args) => {
      if (args.method === "eth_sendTransaction")
        throw Object.assign(new Error("User rejected"), { code: 4001 });
      return original(args);
    };
    const d = new WalletProviderAdapter(q, {
      address: PILOT,
      chainId: 612055,
      epoch: 1,
    });
    const rejected = (await d
      .sendCanonicalTransaction(tx, { ...tx }, { gate: "g7-local-pilot" })
      .catch((e: unknown) => e)) as {
      code?: unknown;
      beforeWalletRequest?: unknown;
    };
    expect(rejected.code).toBe(4001);
    expect(rejected.beforeWalletRequest).toBeUndefined();
  });
  it("one financial request at a time", async () => {
    const p = walletDouble({ account: PILOT });
    let release!: (v: unknown) => void;
    const original = p.request.bind(p);
    p.request = (args) =>
      args.method === "eth_sendTransaction"
        ? new Promise((r) => (release = r))
        : original(args);
    const a = new WalletProviderAdapter(p, {
      address: PILOT,
      chainId: 612055,
      epoch: 1,
    });
    const tx = canonical();
    const first = a.sendCanonicalTransaction(
      tx,
      { ...tx },
      {
        gate: "g7-local-pilot",
      },
    );
    await settle();
    await settle();
    await expect(
      a.sendCanonicalTransaction(tx, { ...tx }, { gate: "g7-local-pilot" }),
    ).rejects.toThrow("WALLET_REQUEST_PENDING");
    release("0x" + "11".repeat(32));
    await expect(first).resolves.toBe("0x" + "11".repeat(32));
  });
});

describe("V1.9 external-wallet controller (deterministic Privy double)", () => {
  it("connect: explicit selection becomes the connected session; isEmbedded false; EVM only", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    const p = walletDouble();
    await c.select(privyWallet(p));
    const session = s.get();
    expect(session).toMatchObject({
      status: "connected",
      address: A,
      chainId: 612055,
      walletClientType: "metamask",
      walletName: "MetaMask",
      connectorType: "injected",
      chainType: "ethereum",
      isEmbedded: false,
      reason: "",
    });
    expect(session.provider).toBeInstanceOf(WalletProviderAdapter);
    expect(session.provider!.epoch).toBe(session.epoch);
    expect(p.calls.map((x) => x.method).sort()).toEqual([
      "eth_accounts",
      "eth_chainId",
    ]);
    expect(c.activeKey).toBe(walletKey("injected", "metamask", A));
  });
  it("an embedded wallet handed over is refused: no provider, no address", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    const p = walletDouble();
    await c.select(
      privyWallet(p, { walletClientType: "privy", connectorType: "embedded" }),
    );
    expect(s.get()).toMatchObject({
      status: "disconnected",
      address: "",
      provider: null,
      reason: "EMBEDDED_WALLET_REFUSED",
    });
    expect(p.calls).toEqual([]);
  });
  it("a wallet whose live account differs from Privy's report is not bound", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    const p = walletDouble({ account: B });
    await c.select(privyWallet(p, { address: A }));
    expect(s.get()).toMatchObject({
      status: "disconnected",
      provider: null,
      reason: "IDENTITY_CHANGED",
    });
  });
  it("accountChanged: new epoch and adapter, old adapter revoked, new account re-read", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    const p = walletDouble();
    await c.select(privyWallet(p));
    const before = s.get();
    p.set({ account: B });
    p.emit("accountsChanged", [B]);
    await until(() => s.get().status === "connected" && s.get().address === B);
    expect(before.provider!.revoked).toBe(true);
    expect(s.get().epoch).toBeGreaterThan(before.epoch);
    expect(s.get().provider).not.toBe(before.provider);
    // nothing financial can use the wallet while re-binding
    expect(
      s.history.some((h) => h.status === "connecting" && h.provider === null),
    ).toBe(true);
  });
  it("accountChanged to a locked wallet clears the session", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    const p = walletDouble();
    await c.select(privyWallet(p));
    p.emit("accountsChanged", []);
    expect(s.get()).toMatchObject({
      status: "disconnected",
      address: "",
      provider: null,
      reason: "WALLET_LOCKED",
    });
  });
  it("accountChanged race: the session ends on the latest account only", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    const p = walletDouble();
    await c.select(privyWallet(p));
    p.set({ account: B });
    p.emit("accountsChanged", [B]);
    p.set({ account: A });
    p.emit("accountsChanged", [A]);
    await until(() => s.get().status === "connected");
    await settle();
    expect(s.get().address).toBe(A);
  });
  it("chainChanged: re-bound to the new chain with a new epoch; invalid chain clears", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    const p = walletDouble({ chain: "0x38" });
    await c.select(privyWallet(p, { chainId: "eip155:56" }));
    const before = s.get();
    expect(before.chainId).toBe(56);
    p.set({ chain: "0x956d7" });
    p.emit("chainChanged", "0x956d7");
    await until(
      () => s.get().status === "connected" && s.get().chainId === 612055,
    );
    expect(before.provider!.revoked).toBe(true);
    expect(s.get().epoch).toBeGreaterThan(before.epoch);
    p.emit("chainChanged", "not-a-chain");
    expect(s.get()).toMatchObject({
      status: "disconnected",
      reason: "INVALID_CHAIN",
    });
  });
  it("wallet disconnect event clears provider and address; listeners are removed", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    const p = walletDouble();
    await c.select(privyWallet(p));
    const adapter = s.get().provider!;
    expect(p.listenerCount()).toBe(3);
    p.emit("disconnect", { code: 4900 });
    expect(s.get()).toMatchObject({
      status: "disconnected",
      address: "",
      provider: null,
      reason: "WALLET_DISCONNECTED",
    });
    expect(adapter.revoked).toBe(true);
    expect(p.listenerCount()).toBe(0);
  });
  it("user disconnect clears the session and asks Privy to disconnect; reconnect starts a new epoch", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    const p = walletDouble();
    const w = privyWallet(p);
    await c.select(w);
    const first = s.get();
    c.disconnect();
    expect(w.disconnect).toHaveBeenCalledTimes(1);
    expect(s.get()).toMatchObject({
      status: "disconnected",
      provider: null,
      address: "",
    });
    expect(first.provider!.revoked).toBe(true);
    await c.select(w);
    expect(s.get().status).toBe("connected");
    expect(s.get().epoch).toBeGreaterThan(first.epoch);
    expect(s.get().provider).not.toBe(first.provider);
  });
  it("change wallet: a new explicit selection replaces and revokes the previous one", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    const p1 = walletDouble({ account: A });
    const p2 = walletDouble({ account: B });
    await c.select(privyWallet(p1));
    const first = s.get().provider!;
    await c.select(
      privyWallet(p2, {
        address: B,
        walletClientType: "rabby_wallet",
        meta: { name: "Rabby Wallet", id: "io.rabby" },
      }),
    );
    expect(first.revoked).toBe(true);
    expect(s.get()).toMatchObject({
      status: "connected",
      address: B,
      walletName: "Rabby Wallet",
      walletClientType: "rabby_wallet",
    });
    p1.emit("accountsChanged", [A]);
    await settle();
    expect(s.get().address).toBe(B);
  });
  it("Change wallet revokes the previous adapter before the new wallet's provider is even obtained", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    await c.select(privyWallet(walletDouble({ account: A })));
    const first = s.get().provider!;
    let release!: (p: Eip1193Like) => void;
    const pending = c.select(
      privyWallet(walletDouble({ account: B }), {
        address: B,
        walletClientType: "rabby_wallet",
        getEthereumProvider: () => new Promise((r) => (release = r)),
      }),
    );
    await settle();
    expect(first.revoked).toBe(true);
    expect(s.get()).toMatchObject({
      status: "connecting",
      provider: null,
      address: "",
    });
    release(walletDouble({ account: B }));
    await pending;
    expect(s.get()).toMatchObject({ status: "connected", address: B });
  });
  it("Privy's connected list is only used to notice that the active connector is gone", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    const p = walletDouble();
    const w = privyWallet(p);
    await c.select(w);
    c.syncConnected([
      privyWallet(walletDouble(), {
        walletClientType: "rabby_wallet",
        address: B,
      }),
      w,
    ]);
    expect(s.get().address).toBe(A);
    c.syncConnected([
      privyWallet(walletDouble(), {
        walletClientType: "rabby_wallet",
        address: B,
      }),
    ]);
    expect(s.get()).toMatchObject({
      status: "disconnected",
      reason: "WALLET_DISCONNECTED",
    });
  });
  it("WalletConnect session end (connector removed) clears a WalletConnect session", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    const p = walletDouble();
    const w = privyWallet(p, {
      connectorType: "wallet_connect_v2",
      walletClientType: "metamask",
    });
    await c.select(w);
    expect(s.get().connectorType).toBe("wallet_connect_v2");
    c.syncConnected([]);
    expect(s.get().status).toBe("disconnected");
  });
  it("a provider that cannot be obtained leaves no session", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    await c.select(
      privyWallet(walletDouble(), {
        getEthereumProvider: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(s.get()).toMatchObject({
      status: "disconnected",
      reason: "WALLET_UNAVAILABLE",
    });
  });
});

describe("V1.9 review findings (regressions)", () => {
  it("R1: the transaction sent is the snapshot that was compared (caller mutation during the identity read has no effect)", async () => {
    const p = walletDouble({ account: PILOT });
    const a = new WalletProviderAdapter(p, {
      address: PILOT,
      chainId: 612055,
      epoch: 1,
    });
    const tx = canonical();
    const original = p.request.bind(p);
    p.request = async (args) => {
      if (args.method === "eth_accounts") {
        tx.to = "0x2222222222222222222222222222222222222222";
        tx.value = "0x1";
      }
      return original(args);
    };
    await a.sendCanonicalTransaction(
      tx,
      { ...canonical() },
      { gate: "g7-local-pilot" },
    );
    const sent = (
      p.calls.find((c) => c.method === "eth_sendTransaction")!
        .params as WalletTxRequest[]
    )[0];
    expect(sent).toEqual(canonical());
  });
  it("R1: inherited (prototype) fields and non-plain objects never take part", async () => {
    const tx = canonical();
    const { maxFeePerGas: _fee, ...rest } = tx;
    void _fee;
    const withProto = Object.assign(
      Object.create({ maxFeePerGas: "0xffffffffff" }),
      rest,
    );
    const p = walletDouble({ account: PILOT });
    const a = new WalletProviderAdapter(p, {
      address: PILOT,
      chainId: 612055,
      epoch: 1,
    });
    await expect(
      a.sendCanonicalTransaction(
        withProto,
        { ...rest },
        { gate: "g7-local-pilot" },
      ),
    ).rejects.toThrow("CANONICAL_TX_MISMATCH");
    class Tx {}
    await expect(
      a.sendCanonicalTransaction(
        Object.assign(new Tx(), tx),
        { ...tx },
        { gate: "g7-local-pilot" },
      ),
    ).rejects.toThrow("CANONICAL_TX_MISMATCH");
    expect(p.calls).toEqual([]);
  });
  it("R4: one financial request per wallet across adapter epochs; an uncertain result blocks further sends", async () => {
    const p = walletDouble({ account: PILOT });
    let release!: (v: unknown) => void;
    const original = p.request.bind(p);
    p.request = (args) =>
      args.method === "eth_sendTransaction"
        ? new Promise(
            (r, j) => (release = (v) => (v instanceof Error ? j(v) : r(v))),
          )
        : original(args);
    const first = new WalletProviderAdapter(p, {
      address: PILOT,
      chainId: 612055,
      epoch: 1,
    });
    const second = new WalletProviderAdapter(p, {
      address: PILOT,
      chainId: 612055,
      epoch: 2,
    });
    const tx = canonical();
    const pending = first.sendCanonicalTransaction(
      tx,
      { ...tx },
      { gate: "g7-local-pilot" },
    );
    await settle();
    await settle();
    first.revoke();
    await expect(
      second.sendCanonicalTransaction(
        tx,
        { ...tx },
        { gate: "g7-local-pilot" },
      ),
    ).rejects.toThrow("WALLET_REQUEST_PENDING");
    release(Object.assign(new Error("timeout"), { code: -32603 }));
    await expect(pending).rejects.toThrow("timeout");
    await expect(
      second.sendCanonicalTransaction(
        tx,
        { ...tx },
        { gate: "g7-local-pilot" },
      ),
    ).rejects.toThrow("WALLET_REQUEST_UNCERTAIN");
  });
  it("R5: the trusted chain registry is frozen at every level", () => {
    for (const entry of Object.values(TRUSTED_CHAINS)) {
      expect(Object.isFrozen(entry)).toBe(true);
      if (entry.add) {
        expect(Object.isFrozen(entry.add)).toBe(true);
        expect(Object.isFrozen(entry.add.rpcUrls)).toBe(true);
      }
    }
    expect(() => {
      (TRUSTED_CHAINS[56] as { add?: unknown }).add = {
        rpcUrls: ["https://evil.example"],
      };
    }).toThrow();
  });
  it("R2: a disposed controller never publishes again (no session resurrection after the layer unmounts)", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    const p = walletDouble();
    await c.select(privyWallet(p));
    c.dispose();
    s.set({
      ...s.get(),
      status: "disconnected",
      address: "",
      provider: null,
      epoch: s.get().epoch + 1,
    });
    const before = s.history.length;
    p.emit("chainChanged", "0x38");
    p.emit("accountsChanged", [B]);
    await settle();
    await c.select(privyWallet(walletDouble()));
    expect(s.history.length).toBe(before);
    expect(p.listenerCount()).toBe(0);
    // StrictMode-style re-activation of the same instance works again
    c.activate();
    await c.select(privyWallet(walletDouble()));
    expect(s.get().status).toBe("connected");
  });
  it("R7 (reviewed, kept): connector presence is matched by connector/client type only — Privy's list lags an account switch", async () => {
    const s = sink();
    const c = new ExternalWalletController(s);
    await c.select(privyWallet(walletDouble()));
    c.syncConnected([privyWallet(walletDouble(), { address: B })]);
    expect(s.get()).toMatchObject({ status: "connected", address: A });
    c.syncConnected([]);
    expect(s.get()).toMatchObject({
      status: "disconnected",
      reason: "WALLET_DISCONNECTED",
    });
  });
});

describe("V1.9 wallet session store", () => {
  it("open before the layer is ready is queued, then opens exactly once", () => {
    const open = vi.fn();
    walletStore.open();
    walletStore.open();
    const unregister = walletStore.register({ open, disconnect: vi.fn() });
    expect(open).toHaveBeenCalledTimes(1);
    walletStore.open();
    expect(open).toHaveBeenCalledTimes(2);
    unregister();
  });
  it("disconnect revokes the adapter and asks the layer to disconnect; unavailable has no provider", () => {
    const disconnect = vi.fn();
    const unregister = walletStore.register({ open: vi.fn(), disconnect });
    const adapter = new WalletProviderAdapter(walletDouble(), {
      address: A,
      chainId: 1,
      epoch: 1,
    });
    walletStore.set({
      ...EMPTY_SESSION,
      status: "connected",
      address: A,
      provider: adapter,
      epoch: 1,
    });
    walletStore.disconnect();
    expect(adapter.revoked).toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(walletStore.get()).toMatchObject({
      status: "disconnected",
      provider: null,
      address: "",
    });
    walletStore.unavailable("WALLET_UNAVAILABLE");
    expect(walletStore.get()).toMatchObject({
      status: "unavailable",
      provider: null,
      reason: "WALLET_UNAVAILABLE",
    });
    unregister();
  });
  it("sessions published by the store are frozen", () => {
    walletStore.set({ ...EMPTY_SESSION });
    expect(Object.isFrozen(walletStore.get())).toBe(true);
  });
});

describe("V1.9 Privy connect-only configuration", () => {
  const config = privyConnectOnlyConfig({ theme: "dark", chains: [] });
  it("wallet login only; no email/SMS/social/passkey; no embedded wallet creation; no wallet UIs", () => {
    expect(config.loginMethods).toEqual(["wallet"]);
    expect(config.embeddedWallets).toEqual({
      ethereum: { createOnLogin: "off" },
      solana: { createOnLogin: "off" },
      showWalletUIs: false,
    });
    expect(config.appearance.walletChainType).toBe("ethereum-only");
    expect(JSON.stringify(config)).not.toMatch(
      /email|sms|google|apple|twitter|discord|github|telegram|passkey|fund|moonpay|paymaster|smartWallet|"defaultChain"/i,
    );
  });
  it("no automatic chain switch on connect (defaultChain unset); ONEchain available to WalletConnect", () => {
    expect("defaultChain" in config).toBe(false);
    expect(config.supportedChains.map((c) => c.id)).toContain(612055);
  });
  it("Coinbase Wallet as EOA only; WalletConnect on; no session cookies; MFA never prompts", () => {
    expect(
      config.externalWallets.coinbaseWallet.config.preference.options,
    ).toBe("eoaOnly");
    expect(config.externalWallets.walletConnect.enabled).toBe(true);
    expect(config.sessions.cookieWriteBehavior).toBe("never");
    expect(config.mfa.noPromptOnMfaRequired).toBe(true);
    expect([...WALLET_LIST]).toEqual([
      "detected_ethereum_wallets",
      "metamask",
      "phantom",
      "coinbase_wallet",
      "rainbow",
      "wallet_connect",
    ]);
    expect(WALLET_LIST).not.toContain("base_account");
  });
  it("theme follows the Otherbridge theme", () => {
    expect(
      privyConnectOnlyConfig({ theme: "light", chains: [] }).appearance.theme,
    ).toBe("light");
    expect(config.appearance.theme).toBe("#151619");
  });
  it("App ID: exactly 25 lowercase alphanumerics (the SDK's own rule), nothing hard-coded", () => {
    expect(validPrivyAppId("abcdefghijklmnopqrstuvwxy")).toBe(true);
    for (const bad of [
      undefined,
      "",
      "short",
      "ABCDEFGHIJKLMNOPQRSTUVWXY",
      "abcdefghijklmnopqrstuvwx-",
      "abcdefghijklmnopqrstuvwxyz",
    ])
      expect(validPrivyAppId(bad)).toBe(false);
    for (const f of [
      "src/features/wallet/privy/config.ts",
      "src/features/wallet/privy/layer.tsx",
      "src/components/product.tsx",
    ])
      expect(readFileSync(f, "utf8")).not.toMatch(
        /appId\s*[:=]\s*["'][a-z0-9]{25}["']/,
      );
  });
});

describe("V1.9 CSP with and without Privy", () => {
  it("without an App ID the policy is byte-identical to the V1.5 policy", () => {
    expect(contentSecurityPolicy("N", false)).toBe(
      "default-src 'self'; script-src 'self' 'nonce-N' 'strict-dynamic'; style-src 'self' 'nonce-N'; style-src-attr 'none'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
    expect(contentSecurityPolicy("N", false, false)).toBe(
      contentSecurityPolicy("N", false),
    );
  });
  it("with Privy: exact origins only, no wildcard, no unsafe-*, embedded-wallet iframe still blocked", () => {
    const csp = contentSecurityPolicy("N", false, true);
    expect(csp).not.toMatch(/\*|unsafe-inline|unsafe-eval/);
    expect(csp).toContain("style-src-attr 'none'");
    expect(csp).toContain(`script-src 'self' 'nonce-N' 'strict-dynamic'`);
    for (const origin of [
      ...PRIVY_CSP.connect,
      ...PRIVY_CSP.frame,
      ...PRIVY_CSP.img,
    ])
      expect(origin).toMatch(/^(https|wss):\/\/[a-z0-9.-]+$/);
    for (const hash of PRIVY_CSP.styleHashes)
      expect(hash).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
    expect(csp).toContain(
      `style-src 'self' 'nonce-N' ${PRIVY_CSP.styleHashes.join(" ")}`,
    );
    // development keeps its own inline-style policy (a hash would disable 'unsafe-inline' for Next dev styles)
    expect(contentSecurityPolicy("N", true, true)).toContain(
      "style-src 'self' 'unsafe-inline';",
    );
    const frame = csp.split("; ").find((d) => d.startsWith("frame-src"))!;
    expect(frame).not.toContain("auth.privy.io");
    expect(csp.split("; ").find((d) => d.startsWith("script-src"))).not.toMatch(
      /https?:/,
    );
  });
});

describe("V1.9 Privy SDK static inline styles are pinned by hash", () => {
  it("the installed SDK's static <style> blocks are exactly the hashes allowed by the CSP", async () => {
    const dir = "node_modules/@privy-io/react-auth/dist/esm";
    const { hashes, dynamic, files } = await privyStyleInventory(dir);
    expect(files).toEqual(
      readdirSync(dir)
        .filter((file) => file.endsWith(".mjs"))
        .sort(),
    );
    expect([...hashes].sort()).toEqual([...PRIVY_CSP.styleHashes].sort());
    expect(dynamic).toBe(0);
  });
});

describe("V1.9 production submission boundary uses the adapter", () => {
  it("submit() reaches the wallet only through sendCanonicalTransaction (and stays disabled)", async () => {
    const source = readFileSync("src/features/bridge/submission.ts", "utf8");
    expect(source).not.toContain("eth_sendTransaction");
    expect(source).toContain("sendCanonicalTransaction(");
    expect(source).toContain('gate: "otherbridge-submission"');
    const provider = { identity: vi.fn(), sendCanonicalTransaction: vi.fn() };
    await expect(
      submit(
        provider,
        { account: A, chainId: 612055, to: A, data: "0x", value: 1n },
        {
          id: "q",
          mode: "mainnet-readonly",
          account: A,
          recipient: A,
          route: "r",
          config: "1",
          sourceChain: 612055,
          destinationChain: 56,
          token: CROSS,
          amount: 1n,
          networkFee: 0n,
          serviceFee: 0n,
          gasBudget: 0n,
          expected: 1n,
          min: 0n,
          max: 1n,
          expiresAt: Date.now() + 1000,
          observedAt: Date.now(),
        },
        {
          mode: "mainnet-readonly",
          source: A,
          destination: A,
          verified: true,
          nativeSentinel: A,
          sourceChain: 612055,
          destinationChain: 56,
          config: "1",
        },
        {
          enabled: true,
          releaseApproved: true,
          revalidate: async () => {},
          persistUnknown: () => {},
          persistHash: () => {},
          persistRejected: () => {},
        },
      ),
    ).rejects.toThrow("MAINNET_WRITE_DISABLED");
    expect(provider.sendCanonicalTransaction).not.toHaveBeenCalled();
  });
});
