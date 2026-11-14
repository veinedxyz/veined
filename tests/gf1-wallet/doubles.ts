// gf1 G02 keyless EIP-6963 wallet doubles for the RainbowKit layer (SYNTHETIC_TEST_ONLY). Same metadata as the main
// suite's doubles (tests/e2e/privy-mock.ts); adds a "reject" connect mode (EIP-1193 4001 on eth_requestAccounts) and
// records every request in window.__walletCalls. Signing methods and raw broadcasts always throw; nothing has a key.
export { WALLET_DOUBLES } from "../e2e/privy-mock";
import type { WALLET_DOUBLES as Doubles } from "../e2e/privy-mock";

export interface DoubleConfig {
  wallets: (keyof typeof Doubles)[];
  account: string;
  chainId: string;
  connect?: "accept" | "reject";
  doubles: typeof Doubles;
}

/** Init script (self-contained: it is serialized into the page). */
export function installDoubles(config: DoubleConfig) {
  if (window !== window.top) return;
  type Listener = (value: unknown) => void;
  const calls: { wallet: string; method: string }[] = [];
  const registry: Record<string, unknown> = {};
  (window as unknown as { __walletCalls: unknown }).__walletCalls = calls;
  (window as unknown as { __wallets: unknown }).__wallets = registry;
  for (const key of config.wallets) {
    const meta = config.doubles[key];
    const listeners: Record<string, Listener[]> = {};
    let accounts = [config.account];
    let chainId = config.chainId;
    let permitted = false;
    const emit = (event: string, value: unknown) =>
      (listeners[event] ?? []).slice().forEach((fn) => fn(value));
    const fail = (message: string, code: number) =>
      Object.assign(new Error(message), { code });
    const provider = {
      ...meta.flags,
      async request({ method, params }: { method: string; params?: unknown }) {
        calls.push({ wallet: key, method });
        switch (method) {
          case "eth_requestAccounts":
          case "wallet_requestPermissions":
            // A person rejects in the extension a moment later (never synchronously).
            if (config.connect === "reject") {
              await new Promise((r) => setTimeout(r, 250));
              throw fail("User rejected the request.", 4001);
            }
            permitted = true;
            return method === "eth_requestAccounts"
              ? accounts
              : [{ parentCapability: "eth_accounts" }];
          case "eth_accounts":
            return permitted ? accounts : [];
          case "eth_chainId":
            return chainId;
          case "net_version":
            return String(Number(chainId));
          case "wallet_getPermissions":
            return permitted ? [{ parentCapability: "eth_accounts" }] : [];
          case "wallet_revokePermissions":
            permitted = false;
            return null;
          case "wallet_switchEthereumChain": {
            chainId = (params as { chainId: string }[])[0].chainId;
            setTimeout(() => emit("chainChanged", chainId), 0);
            return null;
          }
          default:
            if (/sign|send/i.test(method))
              throw fail("TEST_SIGNING_REFUSED", 4100);
            throw fail(`unsupported ${method}`, 4200);
        }
      },
      on(event: string, fn: Listener) {
        (listeners[event] ??= []).push(fn);
      },
      removeListener(event: string, fn: Listener) {
        listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
      },
    };
    registry[key] = {
      setAccounts(next: string[]) {
        accounts = next;
        if (permitted) emit("accountsChanged", next);
      },
      setChain(next: string) {
        chainId = next;
        emit("chainChanged", next);
      },
      disconnect() {
        permitted = false;
        emit("disconnect", { code: 4900 });
      },
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze({
            info: {
              uuid: meta.uuid,
              name: meta.name,
              icon: meta.icon,
              rdns: meta.rdns,
            },
            provider,
          }),
        }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }
}
