// V1.9 integration: the Privy wallet layer meets the existing gates. Missing App ID and outage fail closed with no
// injected fallback; one session store feeds every surface; the G7 local pilot (fixture data) works only for the
// authorized new EOA through the adapter, refuses the old EOA, and its one-shot lock survives reconnects, reloads
// and other tabs. No network, no wallet, no real write.
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../../src/proxy";
import {
  WalletProviderAdapter,
  type Eip1193Like,
} from "../../src/features/wallet/adapter";
import { ExternalWalletController } from "../../src/features/wallet/controller";
import { EMPTY_SESSION, walletStore } from "../../src/features/wallet/store";
import { validPrivyAppId } from "../../src/features/wallet/privy/config";
import { PILOT_EOA, SUPERSEDED_PILOT_EOAS } from "../../src/g7/policy";
import { fixtureTracker } from "../../scripts/g7-pilot/fixture";
import { fixturePreflight } from "../fixtures/g7-candidate";
import { CONFIRMATION_PHRASE } from "../../scripts/g7-pilot/policy";
import { PilotSession, fileLockStore } from "../../scripts/g7-pilot/session";
import { requestWalletConfirmationOnce } from "../../scripts/g7-pilot/product/wallet-send";
import { exactTx, type PilotTx } from "../../scripts/g7-pilot/product/verify";

const dirs: string[] = [];
const sessions: PilotSession[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const s of sessions.splice(0)) s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  walletStore.set({ ...EMPTY_SESSION });
});
const tempLock = () => {
  const d = mkdtempSync(join(tmpdir(), "v19-g7-"));
  dirs.push(d);
  return join(d, "g7-pilot-lock.json");
};
const CONFIRM = { scope: true, trust: true, phrase: CONFIRMATION_PHRASE };
function pilotSession(lockPath: string) {
  const s = new PilotSession({
    mode: "real",
    fixture: true,
    preflight: fixturePreflight("ready"),
    tracker: fixtureTracker("ready"),
    lock: fileLockStore(lockPath),
    journal: () => undefined,
    trackIntervalMs: 5,
    detectIntervalMs: 5,
  });
  sessions.push(s);
  return s;
}
/** Recording EIP-1193 wallet double behind a Privy ConnectedWallet double. */
function connected(account: string, chain = "0x956d7") {
  const calls: { method: string; params: unknown }[] = [];
  const provider: Eip1193Like = {
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === "eth_accounts") return [account];
      if (method === "eth_chainId") return chain;
      if (method === "eth_sendTransaction") return `0x${"cd".repeat(32)}`;
      throw Object.assign(new Error(method), { code: 4200 });
    },
    on() {},
    removeListener() {},
  };
  const wallet = {
    type: "ethereum",
    address: account,
    chainId: `eip155:${Number(chain)}`,
    walletClientType: "metamask",
    connectorType: "injected",
    imported: false,
    meta: { name: "MetaMask", id: "io.metamask" },
    getEthereumProvider: async () => provider,
    disconnect: () => undefined,
  };
  return { provider, wallet, calls };
}

describe("V1.9 missing App ID / outage: fail closed, no fallback", () => {
  it("no App ID: the CSP is the strict V1.5 policy (no third-party origin at all)", () => {
    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "");
    vi.stubEnv("NODE_ENV", "production");
    const csp = proxy(new NextRequest("http://127.0.0.1:3101/")).headers.get(
      "Content-Security-Policy",
    )!;
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toMatch(/privy|walletconnect/);
    expect(validPrivyAppId(process.env.NEXT_PUBLIC_PRIVY_APP_ID)).toBe(false);
  });
  it("a configured App ID adds only the exact Privy/WalletConnect origins (production stays nonce-only)", () => {
    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "abcdefghijklmnopqrstuvwxy");
    vi.stubEnv("NODE_ENV", "production");
    const csp = proxy(new NextRequest("http://127.0.0.1:3101/")).headers.get(
      "Content-Security-Policy",
    )!;
    expect(csp).toContain("https://auth.privy.io");
    expect(csp).toContain("wss://relay.walletconnect.org");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(csp).toContain("style-src-attr 'none'");
  });
  it("an outage leaves an unavailable session without any provider; nothing in src reads an injected provider", () => {
    walletStore.unavailable("WALLET_UNAVAILABLE");
    expect(walletStore.get()).toMatchObject({
      status: "unavailable",
      provider: null,
      address: "",
    });
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e)) files.push(p);
      }
    };
    walk("src");
    // The adapter's frozen deny list names refused methods; it is the only exemption (as in verify-safety).
    const denyList =
      /export const FORBIDDEN_WALLET_METHODS = Object\.freeze\(\[[^\]]*\]\);/;
    for (const f of files)
      expect(readFileSync(f, "utf8").replace(denyList, ""), f).not.toMatch(
        /window\.ethereum|eip6963:requestProvider|eth_requestAccounts"/,
      );
  });
});

describe("V1.9 one session for every surface", () => {
  it("Bridge, Swap, Portfolio and Activity read one store; a change reaches all subscribers with a new epoch", async () => {
    const seen: string[][] = [[], [], [], []];
    const unsub = seen.map((log) =>
      walletStore.subscribe(() => log.push(walletStore.get().address)),
    );
    const controller = new ExternalWalletController(walletStore);
    const a = connected("0x3333333333333333333333333333333333333333", "0x1");
    await controller.select(a.wallet);
    const epoch = walletStore.get().epoch;
    controller.disconnect();
    unsub.forEach((u) => u());
    for (const log of seen) {
      expect(log).toContain("0x3333333333333333333333333333333333333333");
      expect(log.at(-1)).toBe("");
    }
    expect(walletStore.get().epoch).toBeGreaterThan(epoch);
    expect(walletStore.get().provider).toBeNull();
  });
});

describe("V1.9 G7 local pilot through the Privy wallet adapter (fixture data, mock wallet)", () => {
  it("authorized new EOA: armed canonical tx is sent exactly once, field-for-field, then the lock persists", async () => {
    const lockPath = tempLock();
    const s = pilotSession(lockPath);
    await s.start();
    expect(s.state).toBe("READY");
    const digest = s.latest!.review!.intentDigest;
    const reviewedTx = s.latest!.review!.tx as PilotTx;
    const controller = new ExternalWalletController(walletStore);
    const w = connected(PILOT_EOA);
    await controller.select(w.wallet);
    const adapter = walletStore.get().provider!;
    const identity = await adapter.identity();
    expect(identity.account.toLowerCase()).toBe(PILOT_EOA);
    expect(identity.chainId).toBe(612055);
    const fin = await s.final({
      intentDigest: digest,
      confirmations: CONFIRM,
      wallet: { account: identity.account.toLowerCase(), chainId: "0x956d7" },
    });
    expect(fin.outcome).toBe("ARMABLE");
    const arm = s.arm({
      candidateId: (fin as { candidateId: string }).candidateId,
      intentDigest: digest,
      wallet: { account: PILOT_EOA, chainId: "0x956d7" },
    }) as { tx: PilotTx; armId: string };
    // the request the wallet receives equals the canonical server transaction field for field
    const hash = await requestWalletConfirmationOnce(
      adapter,
      exactTx(arm.tx),
      exactTx(reviewedTx),
      s.id,
    );
    expect(hash).toBe(`0x${"cd".repeat(32)}`);
    const sends = w.calls.filter((c) => c.method === "eth_sendTransaction");
    expect(sends).toHaveLength(1);
    expect((sends[0].params as PilotTx[])[0]).toEqual(exactTx(arm.tx));
    // amount always exactly 5 ONE principal; exposure within the approved bound
    expect(BigInt(arm.tx.value)).toBeLessThanOrEqual(
      5_180_000_000_000_000_000n,
    );
    expect(() =>
      requestWalletConfirmationOnce(
        adapter,
        exactTx(arm.tx),
        exactTx(arm.tx),
        s.id,
      ),
    ).toThrow("SECOND_WALLET_REQUEST_REFUSED");
    expect(JSON.parse(readFileSync(lockPath, "utf8")).state).toBe("ARMED");
    // reconnect (new epoch, new adapter), reload or another tab: the lock is authoritative
    controller.disconnect();
    await controller.select(connected(PILOT_EOA).wallet);
    const again = pilotSession(lockPath);
    expect(again.state).toBe("LOCKED");
    await again.start();
    await expect(
      again.final({
        intentDigest: digest,
        confirmations: CONFIRM,
        wallet: { account: PILOT_EOA, chainId: "0x956d7" },
      }),
    ).rejects.toThrow(/FINAL_NOT_ALLOWED_IN_LOCKED/);
    expect(again.snapshot().sendCapability).toBe(false);
  });
  it("the old EOA is refused by the server and cannot carry the new EOA's transaction through the adapter", async () => {
    const s = pilotSession(tempLock());
    await s.start();
    const digest = s.latest!.review!.intentDigest;
    await expect(
      s.final({
        intentDigest: digest,
        confirmations: CONFIRM,
        wallet: { account: SUPERSEDED_PILOT_EOAS[0], chainId: "0x956d7" },
      }),
    ).rejects.toThrow(/WALLET_ACCOUNT_NOT_OWNER_EOA/);
    const old = connected(SUPERSEDED_PILOT_EOAS[0]);
    const adapter = new WalletProviderAdapter(old.provider, {
      address: SUPERSEDED_PILOT_EOAS[0],
      chainId: 612055,
      epoch: 1,
    });
    const tx = exactTx(s.latest!.review!.tx as PilotTx);
    await expect(
      adapter.sendCanonicalTransaction(
        tx,
        { ...tx },
        { gate: "g7-local-pilot" },
      ),
    ).rejects.toThrow("WALLET_ACCOUNT_MISMATCH");
    expect(old.calls.map((c) => c.method)).not.toContain("eth_sendTransaction");
    expect(s.snapshot().sendCapability).toBe(true);
  });
  it("an account change after review revokes the adapter: the armed send cannot reach the wallet", async () => {
    const s = pilotSession(tempLock());
    await s.start();
    const controller = new ExternalWalletController(walletStore);
    const w = connected(PILOT_EOA);
    await controller.select(w.wallet);
    const adapter = walletStore.get().provider!;
    controller.disconnect();
    const tx = exactTx(s.latest!.review!.tx as PilotTx);
    await expect(
      adapter.sendCanonicalTransaction(
        tx,
        { ...tx },
        { gate: "g7-local-pilot" },
      ),
    ).rejects.toThrow("WALLET_SESSION_STALE");
    expect(w.calls.map((c) => c.method)).not.toContain("eth_sendTransaction");
  });
});
