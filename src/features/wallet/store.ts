// V1.9 wallet session store: the one place Bridge, Swap, Portfolio, Activity and the header read the active wallet
// from. It is deliberately tiny (it ships in the initial bundle); the Privy layer that fills it is loaded lazily on
// the first "Connect wallet" click. Nothing here is persisted: a reload starts disconnected.
import type { WalletSession } from "./session";

export interface WalletCommands {
  open(): void;
  disconnect(): void;
}
type Listener = () => void;

export const EMPTY_SESSION: WalletSession = Object.freeze({
  status: "disconnected",
  address: "",
  chainId: undefined,
  walletClientType: "",
  walletName: "",
  walletIcon: null,
  walletId: "",
  connectorType: "",
  chainType: "ethereum",
  provider: null,
  isEmbedded: false,
  epoch: 0,
  reason: "",
}) as WalletSession;

let session = EMPTY_SESSION;
let commands: WalletCommands | null = null;
let openRequested = false;
const listeners = new Set<Listener>();

export const walletStore = {
  get: () => session,
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  /** Wallet layer only. Revokes the previous adapter whenever the identity changes. */
  set(next: WalletSession) {
    if (session.provider && session.provider !== next.provider)
      session.provider.revoke();
    session = Object.freeze({ ...next }) as WalletSession;
    listeners.forEach((listener) => listener());
  },
  /** Wallet layer only: called once Privy is ready. A click that arrived while loading opens the modal now. */
  register(next: WalletCommands) {
    commands = next;
    if (openRequested) {
      openRequested = false;
      next.open();
    }
    return () => {
      if (commands === next) commands = null;
    };
  },
  open() {
    if (commands) commands.open();
    else openRequested = true;
  },
  /** Clears the active session at once (adapter revoked), then asks the layer to drop the connection. */
  disconnect() {
    openRequested = false;
    walletStore.set({
      ...EMPTY_SESSION,
      status: session.status === "unavailable" ? "unavailable" : "disconnected",
      reason: session.status === "unavailable" ? session.reason : "",
      epoch: session.epoch + 1,
    });
    commands?.disconnect();
  },
  /** No Privy (missing App ID, outage, SDK load failure): no wallet, no fallback to any injected provider. */
  unavailable(reason: string) {
    openRequested = false;
    walletStore.set({
      ...EMPTY_SESSION,
      status: "unavailable",
      reason,
      epoch: session.epoch + 1,
    });
  },
};
