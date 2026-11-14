// Injected (init script) EIP-6963 / EIP-1193 mock wallet. It records every request so tests can prove which wallet
// methods the page used, how many times, and with which exact parameters. "Confirming" here simulates the owner
// pressing confirm in a real wallet; the page itself can never confirm anything.
export interface MockWalletConfig {
  accounts: string[];
  chainId: string;
  send: "hash" | "reject" | "error" | "hang";
  switchError?: number;
  rdns?: string;
  isMock?: boolean;
  name?: string;
}
export interface WalletCall {
  method: string;
  params: unknown;
  at: number;
}
export function installMockWallet(config: MockWalletConfig) {
  if (window !== window.top) return;
  const calls: WalletCall[] = [];
  // V1.9: like a real extension, no account is exposed before the user grants permission.
  let permitted = false;
  const listeners: Record<string, ((v: unknown) => void)[]> = {};
  let chainId = config.chainId;
  let accounts = config.accounts;
  const emit = (ev: string, v: unknown) =>
    (listeners[ev] ?? []).forEach((f) => f(v));
  const fail = (message: string, code: number) =>
    Object.assign(new Error(message), { code });
  const provider = {
    isOtherbridgeG7Mock: config.isMock !== false,
    async request({ method, params }: { method: string; params?: unknown[] }) {
      calls.push({
        method,
        params: JSON.parse(JSON.stringify(params ?? null)),
        at: Date.now(),
      });
      switch (method) {
        case "eth_requestAccounts":
          permitted = true;
          return accounts;
        case "eth_accounts":
          return permitted ? accounts : [];
        case "eth_chainId":
          return chainId;
        case "wallet_switchEthereumChain":
          if (config.switchError)
            throw fail("switch failed", config.switchError);
          chainId = (params![0] as { chainId: string }).chainId;
          setTimeout(() => emit("chainChanged", chainId), 0);
          return null;
        case "wallet_addEthereumChain":
          chainId = (params![0] as { chainId: string }).chainId;
          setTimeout(() => emit("chainChanged", chainId), 0);
          return null;
        case "eth_sendTransaction":
          if (config.send === "reject")
            throw fail("User rejected the request.", 4001);
          if (config.send === "error")
            throw fail("Internal JSON-RPC error.", -32603);
          if (config.send === "hang") return new Promise(() => undefined);
          return "0x" + "ab".repeat(32);
        default:
          throw fail(`unsupported ${method}`, 4200);
      }
    },
    on(ev: string, fn: (v: unknown) => void) {
      (listeners[ev] ??= []).push(fn);
    },
    removeListener(ev: string, fn: (v: unknown) => void) {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
    },
  };
  (window as unknown as { __g7Mock: unknown }).__g7Mock = {
    calls,
    setAccounts(a: string[]) {
      accounts = a;
      emit("accountsChanged", a);
    },
  };
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({
          info: {
            uuid: "00000000-0000-4000-8000-000000000001",
            name: config.name ?? "G7 Mock Wallet",
            icon: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22/%3E",
            rdns: config.rdns ?? "invalid.otherbridge.g7-mock",
          },
          provider,
        }),
      }),
    );
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}
