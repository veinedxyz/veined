// gf1 G02: the optional RainbowKit layer's pure boundary. SYNTHETIC_TEST_ONLY doubles; no network, no signing.
// Proves: explicit opt-in only (never a fallback), a wagmi connection becomes a session only through the accepted
// ExternalWalletController (same normalization, refusals and epochs as Privy), every wagmi transport refuses without a
// network call, and the pinned dependency set is the reviewed one (versions and licences: no AGPL in the layer).
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { walletLayerChoice } from "../../src/features/wallet-rainbow/choice";
import {
  RAINBOW_CHAINS,
  RPC_REFUSED,
  rainbowLocale,
  refusingTransports,
  toExternalWallet,
  type ConnectorLike,
} from "../../src/features/wallet-rainbow/config";
import { ExternalWalletController } from "../../src/features/wallet/controller";
import { EMPTY_SESSION } from "../../src/features/wallet/store";
import type { WalletSession } from "../../src/features/wallet/session";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E";

function walletDouble(chainId = "0x1") {
  const listeners = new Map<string, ((v: unknown) => void)[]>();
  const calls: string[] = [];
  let accounts = [A];
  let chain = chainId;
  const provider = {
    async request({ method }: { method: string }) {
      calls.push(method);
      if (method === "eth_accounts") return accounts;
      if (method === "eth_chainId") return chain;
      throw Object.assign(new Error("refused"), { code: 4200 });
    },
    on(e: string, fn: (v: unknown) => void) {
      listeners.set(e, [...(listeners.get(e) ?? []), fn]);
    },
    removeListener(e: string, fn: (v: unknown) => void) {
      listeners.set(
        e,
        (listeners.get(e) ?? []).filter((f) => f !== fn),
      );
    },
  };
  const emit = (e: string, v: unknown) =>
    (listeners.get(e) ?? []).forEach((fn) => fn(v));
  return {
    provider,
    calls,
    listeners,
    setAccounts(next: string[]) {
      accounts = next;
      emit("accountsChanged", next);
    },
    setChain(next: string) {
      chain = next;
      emit("chainChanged", next);
    },
  };
}
const connector = (
  provider: unknown,
  over: Partial<ConnectorLike> = {},
): ConnectorLike => ({
  id: "io.metamask",
  name: "MetaMask",
  type: "injected",
  icon: ICON,
  getProvider: async () => provider,
  ...over,
});
function sink() {
  let s: WalletSession = EMPTY_SESSION;
  return { get: () => s, set: (n: WalletSession) => (s = n) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("GF1-W1 explicit layer choice", () => {
  it("opts in only with the exact value; anything else keeps Privy", () => {
    expect(walletLayerChoice("rainbowkit")).toBe("rainbowkit");
    for (const v of [
      undefined,
      "",
      "privy",
      "RainbowKit",
      "rainbowkit ",
      "rainbow",
      "true",
    ])
      expect(walletLayerChoice(v)).toBe("privy");
  });
  it("maps the UI language to RainbowKit locales with an English fallback", () => {
    expect(rainbowLocale("tr")).toBe("tr");
    expect(rainbowLocale("zh-TW")).toBe("zh-TW");
    for (const l of ["fa", "he", "ur", "bn", "it", "nl", "pl"])
      expect(rainbowLocale(l)).toBe("en");
  });
});

describe("GF1-W2 a wagmi connection becomes a session only through the accepted controller", () => {
  it("binds the picked injected wallet with live reads, a new epoch and an adapter", async () => {
    const w = walletDouble("0x38");
    const s = sink();
    const c = new ExternalWalletController(s);
    const disconnect = vi.fn();
    await c.select(
      toExternalWallet({
        connector: connector(w.provider),
        address: A,
        chainId: 56,
        disconnect,
      }),
    );
    const session = s.get();
    expect(session.status).toBe("connected");
    expect(session.address).toBe(A);
    expect(session.chainId).toBe(56);
    expect(session.walletName).toBe("MetaMask");
    expect(session.walletClientType).toBe("io.metamask");
    expect(session.connectorType).toBe("injected");
    expect(session.walletIcon).toEqual({ kind: "data", src: ICON });
    expect(session.provider).not.toBeNull();
    expect(session.epoch).toBeGreaterThan(0);
    // Only read methods reached the wallet while binding.
    expect(new Set(w.calls)).toEqual(new Set(["eth_accounts", "eth_chainId"]));
  });
  it("account change, chain change, wallet-side disconnect and user disconnect follow the controller rules", async () => {
    const w = walletDouble();
    const s = sink();
    const c = new ExternalWalletController(s);
    const disconnect = vi.fn();
    await c.select(
      toExternalWallet({
        connector: connector(w.provider),
        address: A,
        chainId: 1,
        disconnect,
      }),
    );
    const first = s.get();
    w.setAccounts([B]);
    await settle();
    await settle();
    expect(s.get().address).toBe(B);
    expect(s.get().epoch).toBeGreaterThan(first.epoch);
    expect(first.provider).not.toBe(s.get().provider);
    w.setChain("0xa");
    await settle();
    await settle();
    expect(s.get().chainId).toBe(10);
    // The wagmi connection list no longer has this connector: the session ends; the list never selects.
    c.syncConnected([
      { connectorType: "injected", walletClientType: "io.metamask" },
    ]);
    expect(s.get().status).toBe("connected");
    c.syncConnected([
      { connectorType: "injected", walletClientType: "io.rabby" },
    ]);
    expect(s.get().status).toBe("disconnected");
    expect(s.get().reason).toBe("WALLET_DISCONNECTED");
    // User disconnect also asks wagmi to drop the connection.
    await c.select(
      toExternalWallet({
        connector: connector(w.provider),
        address: B,
        chainId: 10,
        disconnect,
      }),
    );
    c.disconnect();
    expect(s.get().status).toBe("disconnected");
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
  it("a locked wallet (no account) clears the session", async () => {
    const w = walletDouble();
    const s = sink();
    const c = new ExternalWalletController(s);
    await c.select(
      toExternalWallet({
        connector: connector(w.provider),
        address: A,
        chainId: 1,
        disconnect: () => {},
      }),
    );
    w.setAccounts([]);
    await settle();
    expect(s.get().status).toBe("disconnected");
    expect(s.get().reason).toBe("WALLET_LOCKED");
  });
  it("refuses what Privy's path refuses: embedded or smart accounts, non-EVM addresses, remote icons", async () => {
    const w = walletDouble();
    for (const [over, address, code] of [
      [{ type: "embedded" }, A, "EMBEDDED_WALLET_REFUSED"],
      [{ id: "privy" }, A, "EMBEDDED_WALLET_REFUSED"],
      [{ id: "coinbase_smart_wallet" }, A, "SMART_WALLET_REFUSED"],
      [{}, "So1anaAccount1111111111111111111111111111111", "WALLET_NOT_EVM"],
    ] as const) {
      const s = sink();
      const c = new ExternalWalletController(s);
      await c.select(
        toExternalWallet({
          connector: connector(w.provider, over),
          address,
          chainId: 1,
          disconnect: () => {},
        }),
      );
      expect(s.get().status, code).toBe("disconnected");
      expect(s.get().reason).toBe(code);
    }
    const s = sink();
    await new ExternalWalletController(s).select(
      toExternalWallet({
        connector: connector(w.provider, {
          icon: "https://evil.example/icon.svg",
        }),
        address: A,
        chainId: 1,
        disconnect: () => {},
      }),
    );
    expect(s.get().status).toBe("connected");
    expect(s.get().walletIcon).toBeNull();
  });
  it("the adapter it hands out has no generic request path: reads only, signing refused, switching only to trusted chains", async () => {
    const w = walletDouble();
    const s = sink();
    await new ExternalWalletController(s).select(
      toExternalWallet({
        connector: connector(w.provider),
        address: A,
        chainId: 1,
        disconnect: () => {},
      }),
    );
    const adapter = s.get().provider!;
    expect("request" in adapter).toBe(false);
    for (const method of [
      "personal_sign",
      "eth_signTypedData_v4",
      "eth_sendRawTransaction",
      "eth_requestAccounts",
    ])
      expect(() => adapter.read(method as "eth_accounts")).toThrow(
        "WALLET_METHOD_FORBIDDEN",
      );
    await expect(adapter.switchChain(8453)).rejects.toThrow(
      "WALLET_CHAIN_NOT_TRUSTED",
    );
    expect(w.calls.filter((m) => /sign|send|switch/i.test(m))).toEqual([]);
  });
});

describe("GF1-W3 no RPC from the wallet layer", () => {
  it("every configured chain's transport refuses without touching the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const transports = refusingTransports(RAINBOW_CHAINS);
    expect(
      Object.keys(transports)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([1, 10, 56, 137, 8453, 42161, 43114, 612055]);
    for (const chain of RAINBOW_CHAINS) {
      const t = transports[chain.id]({ chain, retryCount: 0 });
      await expect(t.request({ method: "eth_blockNumber" })).rejects.toThrow(
        RPC_REFUSED,
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("GF1-W4 pinned, reviewed dependency set (isolated lockfile)", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  it("pins the reviewed versions exactly", () => {
    expect(pkg.dependencies["@rainbow-me/rainbowkit"]).toBe("2.2.10");
    expect(pkg.dependencies.wagmi).toBe("2.19.5");
    expect(pkg.dependencies["@tanstack/react-query"]).toBe("5.104.1");
    expect(pkg.dependencies["get-nonce"]).toBe("1.0.1");
    expect(pkg.dependencies.viem).toBe("2.57.2");
  });
  it("RainbowKit's resolved runtime dependencies are permissively licensed (no AGPL ua-parser-js 2.x)", () => {
    // The pnpm virtual-store folder of this exact RainbowKit instance (its siblings are its resolved dependencies).
    const modules = join(
      realpathSync("node_modules/@rainbow-me/rainbowkit"),
      "..",
      "..",
    );
    const rk = JSON.parse(
      readFileSync(
        join(modules, "@rainbow-me/rainbowkit/package.json"),
        "utf8",
      ),
    );
    expect(rk.version).toBe("2.2.10");
    expect(rk.license).toBe("MIT");
    const permissive =
      /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|\(MIT OR Apache-2\.0\))$/;
    for (const name of Object.keys(rk.dependencies)) {
      const dep = JSON.parse(
        readFileSync(join(modules, name, "package.json"), "utf8"),
      );
      expect(dep.license, `${name}@${dep.version}`).toMatch(permissive);
    }
    const ua = JSON.parse(
      readFileSync(join(modules, "ua-parser-js/package.json"), "utf8"),
    );
    expect(ua.version.startsWith("1.")).toBe(true);
    expect(ua.license).toBe("MIT");
  });
});

describe("GF1-W5 RainbowKit cool mode stays off (the 2.2.10 innerHTML wallet-icon sink is unreachable)", () => {
  it("the VEINED layer never enables cool mode, authentication or recent transactions", () => {
    const layer = readFileSync("src/features/wallet-rainbow/layer.tsx", "utf8");
    expect(layer).not.toMatch(
      /coolMode|CoolModeContext|RainbowKitAuthenticationProvider|showRecentTransactions/,
    );
    expect(layer).toMatch(/<RainbowKitProvider\s+theme=\{null\}/);
  });
  it("the pinned RainbowKit keeps cool mode off by default and reaches its only HTML sink behind the cool-mode guard", () => {
    const dist = readFileSync(
      join(
        realpathSync("node_modules/@rainbow-me/rainbowkit"),
        "dist/index.js",
      ),
      "utf8",
    );
    expect(dist).toMatch(/coolMode = false,/);
    expect(
      dist.match(
        /if \(coolModeEnabled && ref\.current && resolvedImageUrl\) \{\s+return makeElementCool\(/g,
      ),
    ).toHaveLength(1);
    // makeElementCool: its definition and that single guarded call; the only innerHTML assignment lives inside it.
    expect(dist.match(/makeElementCool\(/g)).toHaveLength(2);
    expect(dist.match(/\.innerHTML\s*=/g)).toHaveLength(1);
  });
});
