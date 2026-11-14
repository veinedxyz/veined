// V1.9 external-wallet controller: turns Privy's connect-only events into the normalized Otherbridge session.
// Framework-free so the whole lifecycle (explicit selection, bind, accountsChanged, chainChanged, disconnect,
// reconnect, races) is unit-tested with a deterministic Privy double. Rules:
//   - a wallet becomes ACTIVE only through select(), i.e. the wallet the user picked in the connect modal;
//     Privy's wallet list (linked/connected order) is never used to choose a signer;
//   - the address and chain are bound to bounded live reads of that wallet's provider; any competing event
//     during a bind aborts it;
//   - every identity change creates a new epoch and a new adapter and revokes the previous adapter, so a quote,
//     review, simulation or armed pilot state bound to the old epoch can never reach the wallet;
//   - disconnect clears the provider reference and the address; it never touches server state, one-shot locks
//     or local history.
import { BridgeError } from "../../core/model";
import { WalletProviderAdapter, type Eip1193Like } from "./adapter";
import { bindExternalWallet, errorCode, parseChain } from "./provider";
import {
  normalizeExternalWallet,
  type ExternalWalletLike,
  type NormalizedExternalWallet,
  type WalletSession,
} from "./session";

export interface PrivyWalletLike extends ExternalWalletLike {
  getEthereumProvider?: () => Promise<Eip1193Like>;
  disconnect?: () => void;
}
export interface SessionSink {
  get(): WalletSession;
  set(next: WalletSession): void;
}
interface Active {
  wallet: PrivyWalletLike;
  normalized: NormalizedExternalWallet;
  raw: Eip1193Like;
  address: string;
  unsubscribe: () => void;
}

export class ExternalWalletController {
  readonly #sink: SessionSink;
  #active: Active | null = null;
  #generation = 0;
  #bindAbort: AbortController | null = null;
  #disposed = false;
  constructor(sink: SessionSink) {
    this.#sink = sink;
  }
  get activeKey() {
    return this.#active?.normalized.key ?? null;
  }
  #publish(patch: Partial<WalletSession>) {
    if (this.#disposed) return;
    const previous = this.#sink.get();
    this.#sink.set({
      ...previous,
      ...patch,
      chainType: "ethereum",
      isEmbedded: false,
      epoch: previous.epoch + 1,
    });
  }
  #teardown() {
    this.#generation++;
    this.#bindAbort?.abort();
    this.#bindAbort = null;
    this.#active?.unsubscribe();
    this.#active = null;
  }
  #clear(reason: string) {
    this.#teardown();
    this.#publish({
      status: "disconnected",
      address: "",
      chainId: undefined,
      walletClientType: "",
      walletName: "",
      walletIcon: null,
      walletId: "",
      connectorType: "",
      provider: null,
      reason,
    });
  }
  /** The user's explicit choice in the connect modal (Privy onSuccess). Replaces any previous active wallet. */
  async select(wallet: PrivyWalletLike): Promise<void> {
    if (this.#disposed) return;
    this.#teardown();
    let normalized: NormalizedExternalWallet;
    try {
      normalized = normalizeExternalWallet(wallet);
      if (typeof wallet.getEthereumProvider !== "function")
        throw new BridgeError("WALLET_UNAVAILABLE");
    } catch (e) {
      return this.#clear(errorCode(e));
    }
    // The previously active wallet stops being usable at once (the store revokes its adapter).
    this.#publish({
      status: "connecting",
      address: "",
      chainId: undefined,
      provider: null,
      walletClientType: normalized.walletClientType,
      walletName: normalized.walletName,
      walletIcon: normalized.walletIcon,
      walletId: normalized.walletId,
      connectorType: normalized.connectorType,
      reason: "",
    });
    const generation = this.#generation;
    let raw: Eip1193Like;
    try {
      raw = await wallet.getEthereumProvider();
    } catch {
      if (generation === this.#generation) this.#clear("WALLET_UNAVAILABLE");
      return;
    }
    if (generation !== this.#generation) return;
    const onAccounts = (value: unknown) => void this.#accountsChanged(value);
    const onChain = (value: unknown) => this.#chainChanged(value);
    const onDisconnect = () => this.#clear("WALLET_DISCONNECTED");
    raw.on?.("accountsChanged", onAccounts);
    raw.on?.("chainChanged", onChain);
    raw.on?.("disconnect", onDisconnect);
    this.#active = {
      wallet,
      normalized,
      raw,
      address: normalized.address,
      unsubscribe: () => {
        raw.removeListener?.("accountsChanged", onAccounts);
        raw.removeListener?.("chainChanged", onChain);
        raw.removeListener?.("disconnect", onDisconnect);
      },
    };
    await this.#bind(normalized.address);
  }
  async #bind(address: string) {
    const active = this.#active;
    if (!active) return;
    const generation = ++this.#generation;
    this.#bindAbort?.abort();
    const controller = new AbortController();
    this.#bindAbort = controller;
    active.address = address;
    // Nothing financial can use the wallet while it is being (re)bound.
    this.#publish({
      status: "connecting",
      address: "",
      chainId: undefined,
      provider: null,
      walletClientType: active.normalized.walletClientType,
      walletName: active.normalized.walletName,
      walletIcon: active.normalized.walletIcon,
      walletId: active.normalized.walletId,
      connectorType: active.normalized.connectorType,
      reason: "",
    });
    try {
      const bound = await bindExternalWallet(
        active.raw,
        address,
        controller.signal,
      );
      if (
        this.#disposed ||
        generation !== this.#generation ||
        this.#active !== active
      )
        return;
      const epoch = this.#sink.get().epoch + 1;
      const adapter = new WalletProviderAdapter(active.raw, {
        address: bound.account,
        chainId: bound.chain,
        epoch,
      });
      this.#sink.set({
        ...this.#sink.get(),
        status: "connected",
        address: bound.account,
        chainId: bound.chain,
        walletClientType: active.normalized.walletClientType,
        walletName: active.normalized.walletName,
        walletIcon: active.normalized.walletIcon,
        walletId: active.normalized.walletId,
        connectorType: active.normalized.connectorType,
        chainType: "ethereum",
        provider: adapter,
        isEmbedded: false,
        epoch,
        reason: "",
      });
    } catch (e) {
      if (generation !== this.#generation || this.#active !== active) return;
      this.#clear(errorCode(e));
    }
  }
  async #accountsChanged(value: unknown) {
    const active = this.#active;
    if (!active) return;
    const next =
      Array.isArray(value) &&
      typeof value[0] === "string" &&
      /^0x[0-9a-fA-F]{40}$/.test(value[0])
        ? value[0]
        : "";
    // Locked wallet / no account exposed: no active account.
    if (!next) return this.#clear("WALLET_LOCKED");
    await this.#bind(next);
  }
  #chainChanged(value: unknown) {
    const active = this.#active;
    if (!active) return;
    try {
      parseChain(value);
    } catch {
      return this.#clear("INVALID_CHAIN");
    }
    // Re-bind: the new chain is read back from the wallet and gets a new epoch and adapter.
    void this.#bind(active.address);
  }
  /**
   * Privy's current connected wallets. Used only to notice that the active connector is gone (e.g. a WalletConnect
   * session ended); it never selects a wallet.
   */
  syncConnected(wallets: readonly PrivyWalletLike[]) {
    const active = this.#active;
    if (!active) return;
    const present = wallets.some(
      (w) =>
        w.connectorType === active.normalized.connectorType &&
        w.walletClientType === active.normalized.walletClientType,
    );
    // Deliberately not matched by address: Privy's list follows an account switch later than the wallet's own
    // accountsChanged event; the account itself is always confirmed by live reads (bind, adapter.identity()).
    if (!present) this.#clear("WALLET_DISCONNECTED");
  }
  /**
   * The Privy layer unmounted (route without the product shell, crash): detach from the wallet and never publish
   * again, so a stale controller cannot bring a session back. Privy's own connection is left alone.
   */
  dispose() {
    this.#teardown();
    this.#disposed = true;
  }
  /** Effect setup of the layer that owns this controller (React StrictMode re-runs setup after a cleanup). */
  activate() {
    this.#disposed = false;
  }
  /** User action. The session is cleared first; Privy's own disconnect may be a no-op for injected wallets. */
  disconnect() {
    const wallet = this.#active?.wallet;
    this.#clear("");
    try {
      wallet?.disconnect?.();
    } catch {
      // the Otherbridge session is already cleared
    }
  }
}
