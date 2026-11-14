// V1.9 normalized Otherbridge wallet session. Privy (external wallets, connect-only) is only the discovery and
// connection layer; this module is the single shape every surface (Bridge, Swap, Portfolio, Activity, header)
// reads. It never trusts list order: the ACTIVE wallet is the one the user explicitly picked in the connect modal.
// Financial execution stays inside the EVM boundary: only an external, non-embedded, non-smart-account EVM wallet
// with a valid 20-byte address and an eip155 chain becomes a session.
import { BridgeError } from "../../core/model";
import type { WalletProviderAdapter } from "./adapter";

export type WalletStatus =
  "disconnected" | "loading" | "connecting" | "connected" | "unavailable";

/** A wallet icon Otherbridge may render: an inline image data URI or a trusted bundled component. Never a URL. */
export type WalletIcon =
  { kind: "data"; src: string } | { kind: "component"; component: unknown };

export interface WalletSession {
  status: WalletStatus;
  address: string;
  chainId: number | undefined;
  walletClientType: string;
  walletName: string;
  walletIcon: WalletIcon | null;
  walletId: string;
  connectorType: string;
  chainType: "ethereum";
  provider: WalletProviderAdapter | null;
  isEmbedded: false;
  /** Increments on every identity change (connect, account, chain, disconnect); binds quotes and reviews. */
  epoch: number;
  /** Error code for "unavailable" (and the last connect failure), never a raw provider message. */
  reason: string;
}

/** Privy's embedded/custodial client types and connector types. Any match is refused. */
export const EMBEDDED_CLIENT_TYPES = Object.freeze(["privy", "privy-v2"]);
export const EMBEDDED_CONNECTOR_TYPES = Object.freeze([
  "embedded",
  "embedded_imported",
  "privy",
]);
/** Smart-contract / passkey accounts (account abstraction is out of scope): refused. */
export const SMART_ACCOUNT_CLIENT_TYPES = Object.freeze([
  "coinbase_smart_wallet",
  "base_account",
]);

/** Structural subset of a Privy ConnectedWallet (or the deterministic test double). */
export interface ExternalWalletLike {
  type?: unknown;
  address?: unknown;
  chainId?: unknown;
  walletClientType?: unknown;
  connectorType?: unknown;
  imported?: unknown;
  meta?: { name?: unknown; id?: unknown; icon?: unknown } | null;
}
export interface NormalizedExternalWallet {
  key: string;
  address: string;
  chainId: number;
  walletClientType: string;
  connectorType: string;
  walletName: string;
  walletId: string;
  walletIcon: WalletIcon | null;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CAIP2_EVM = /^eip155:([1-9]\d{0,15})$/;
const LABEL = /^[\p{L}\p{N} ._()'&+-]{1,60}$/u;
// Inline image data only (EIP-6963 requires a data URI). Rendered as <img src>, where SVG cannot run script; React
// sets the attribute, so quotes or spaces inside URL-encoded SVG are harmless. No http(s) URL ever passes.
const DATA_ICON =
  /^data:image\/(?:svg\+xml|png|webp|jpeg|gif)(?:;charset=[\w-]+)?(?:;base64)?,[^\u0000-\u001f\u007f]*$/i;

export function parseEvmChain(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return value;
  if (typeof value === "string") {
    const caip = CAIP2_EVM.exec(value);
    if (caip && Number.isSafeInteger(Number(caip[1]))) return Number(caip[1]);
    if (/^0x[0-9a-f]{1,13}$/i.test(value) && BigInt(value) > 0n)
      return Number(BigInt(value));
  }
  throw new BridgeError("WALLET_CHAIN_INVALID");
}

/** Only inline image data (EIP-6963 requires data URIs) or a bundled component; remote URLs are never loaded. */
export function sanitizeWalletIcon(icon: unknown): WalletIcon | null {
  if (typeof icon === "string")
    return icon.length <= 200_000 && DATA_ICON.test(icon)
      ? { kind: "data", src: icon }
      : null;
  if (typeof icon === "function") return { kind: "component", component: icon };
  return null;
}

export function walletKey(
  connectorType: string,
  walletClientType: string,
  address: string,
) {
  return `${connectorType}|${walletClientType}|${address.toLowerCase()}`;
}

/** Normalizes one Privy external wallet or throws a stable error code. Never coerces a non-EVM identity. */
export function normalizeExternalWallet(
  raw: ExternalWalletLike | null | undefined,
): NormalizedExternalWallet {
  if (!raw || typeof raw !== "object")
    throw new BridgeError("WALLET_NOT_CONNECTED");
  const walletClientType =
    typeof raw.walletClientType === "string" ? raw.walletClientType : "";
  const connectorType =
    typeof raw.connectorType === "string" ? raw.connectorType : "";
  if (
    EMBEDDED_CLIENT_TYPES.includes(walletClientType) ||
    EMBEDDED_CONNECTOR_TYPES.includes(connectorType) ||
    raw.imported === true
  )
    throw new BridgeError("EMBEDDED_WALLET_REFUSED");
  if (SMART_ACCOUNT_CLIENT_TYPES.includes(walletClientType))
    throw new BridgeError("SMART_WALLET_REFUSED");
  if (raw.type !== "ethereum") throw new BridgeError("WALLET_NOT_EVM");
  if (!walletClientType || !connectorType)
    throw new BridgeError("WALLET_UNKNOWN_CONNECTOR");
  if (typeof raw.address !== "string" || !EVM_ADDRESS.test(raw.address))
    throw new BridgeError("WALLET_NOT_EVM");
  const chainId = parseEvmChain(raw.chainId);
  const metaName =
    typeof raw.meta?.name === "string" ? raw.meta.name.trim() : "";
  const metaId = typeof raw.meta?.id === "string" ? raw.meta.id.trim() : "";
  return {
    key: walletKey(connectorType, walletClientType, raw.address),
    address: raw.address,
    chainId,
    walletClientType,
    connectorType,
    walletName: LABEL.test(metaName) ? metaName : walletClientType.slice(0, 60),
    walletId: metaId.slice(0, 100),
    walletIcon: sanitizeWalletIcon(raw.meta?.icon),
  };
}

/**
 * The active wallet is the explicitly selected key. List order (Privy's linked/connected order) is never used as
 * signer selection: no key, or a key that is no longer connected, means no active wallet.
 */
export function pickActiveWallet<T extends ExternalWalletLike>(
  wallets: readonly T[],
  activeKey: string | null,
): T | undefined {
  if (!activeKey) return undefined;
  const matches = wallets.filter((w) => {
    try {
      return normalizeExternalWallet(w).key === activeKey;
    } catch {
      return false;
    }
  });
  return matches.length >= 1 ? matches[0] : undefined;
}

/** Stable identity of a session; any difference invalidates quotes, reviews, simulations and armed pilot state. */
export function sessionFingerprint(session: WalletSession) {
  return [
    session.status,
    session.address.toLowerCase(),
    session.chainId ?? "",
    session.connectorType,
    session.walletClientType,
    session.epoch,
  ].join("|");
}
