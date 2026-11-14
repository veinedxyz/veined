// gf1 G02: optional RainbowKit EVM connect layer (connect-only), the alternative to the Privy layer.
// - Selected only explicitly at build time (NEXT_PUBLIC_VEINED_WALLET_LAYER=rainbowkit, ./choice.ts); it is never a
//   fallback for a missing or invalid Privy App ID, so V1.9's "no fallback to an injected provider" rule is unchanged.
// - Injected wallets only, discovered through EIP-6963 (MetaMask, Rabby, Phantom-EVM, Coinbase extension, ...): no
//   WalletConnect project id, no QR/mobile deep links, no RainbowKit wallet list, no cool mode, no recent transactions.
// - No RPC from the wallet layer: every wagmi transport refuses (RainbowKit's ENS/balance lookups never reach a node);
//   account and chain come from the wallet itself, as with Privy.
// - Nothing persisted (storage null, no reconnect on mount): a reload starts disconnected.
// - The connected wallet reaches the product only through ExternalWalletController.select(), so the adapter's
//   allowlist (read/connection methods only, every signing method refused) stays the single wallet path.
// Pure functions, unit-tested.
import { custom, type Config } from "wagmi";
import { watchConnectors } from "wagmi/actions";
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  mainnet,
  optimism,
  polygon,
} from "wagmi/chains";
import type { Chain } from "viem";
import type { Eip1193Like } from "../wallet/adapter";
import type { PrivyWalletLike } from "../wallet/controller";
import { ONECHAIN } from "../wallet/privy/config";

/** EVM networks the product reviews or routes on (Swap, Bridge, the legacy ONEchain pair). Labels only: the wallet
 * layer never switches chains by itself; switching stays with the adapter's trusted registry. */
export const RAINBOW_CHAINS = Object.freeze([
  mainnet,
  bsc,
  base,
  arbitrum,
  optimism,
  polygon,
  avalanche,
  ONECHAIN as unknown as Chain,
]) as unknown as readonly [Chain, ...Chain[]];

export const RPC_REFUSED = "WALLET_LAYER_RPC_REFUSED";
/** A transport that never reaches the network: wagmi/RainbowKit read helpers fail closed instead of calling a node. */
export const refusingTransport = custom(
  {
    async request() {
      throw new Error(RPC_REFUSED);
    },
  },
  { retryCount: 0 },
);
export function refusingTransports(chains: readonly Chain[]) {
  return Object.fromEntries(chains.map((c) => [c.id, refusingTransport]));
}

/**
 * G14 protected proposal C (W-2 root fix): a connector whose connect() never receives a chain.
 * Root cause (verified in the installed packages): RainbowKit 2.2.10 connectWallet() always calls
 * connectAsync({ chainId: initialChain ?? <wallet chain if supported> ?? chains[0].id }), and wagmi's injected
 * connector then asks the wallet to switch when that id differs from the wallet's chain — so connecting on an
 * unsupported network (Linea 0xe708) prompted a switch to Ethereum that the owner never asked for.
 * The wrap removes `chainId` from the parameters before the connector's own connect() runs; every other parameter
 * (isReconnecting, withCapabilities, ...) passes unchanged. It replaces the one method in place, so the connector
 * keeps its identity, uid, emitter, event subscriptions, every other method and its `this` (a spread copy made by
 * RainbowKit carries the same wrapped method and is called with the copy as `this`). Idempotent.
 * Switching networks stays an explicit owner action through the wallet adapter's trusted registry.
 */
export interface ConnectCapable {
  connect(parameters?: never): unknown;
}
const chainless = new WeakSet<object>();
export function withoutConnectChainId<T extends ConnectCapable>(
  connector: T,
): T {
  if (!connector || typeof connector.connect !== "function")
    throw new TypeError("CONNECTOR_INVALID");
  if (chainless.has(connector)) return connector;
  const inner = connector.connect as (
    this: unknown,
    parameters?: Record<string, unknown>,
  ) => unknown;
  const connect = function (
    this: unknown,
    parameters?: Record<string, unknown> | null,
  ) {
    const self = this ?? connector;
    if (parameters === undefined || parameters === null)
      return inner.call(self);
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(parameters))
      if (key !== "chainId") rest[key] = parameters[key];
    return inner.call(self, rest);
  };
  Object.defineProperty(connector, "connect", {
    value: connect,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  chainless.add(connector);
  return connector;
}
/**
 * Applies withoutConnectChainId to every connector a wagmi config has now and to every connector it gains later
 * (EIP-6963 discovery adds them after creation). Returns the unsubscribe function. The wallet layer has to call this
 * once on its config for the fix to take effect in the product.
 */
export function guardConnectChain(config: Config): () => void {
  for (const connector of config.connectors) withoutConnectChainId(connector);
  return watchConnectors(config, {
    onChange(connectors) {
      for (const connector of connectors) withoutConnectChainId(connector);
    },
  });
}

/** Structural subset of a wagmi connector. */
export interface ConnectorLike {
  id: string;
  name: string;
  type: string;
  icon?: string;
  getProvider(): Promise<unknown>;
}

/**
 * Maps a wagmi connection to the wallet shape ExternalWalletController.select() normalizes (the same checks as for
 * Privy: EVM address, eip155 chain, embedded/smart accounts refused, label and icon sanitized there).
 */
export function toExternalWallet(input: {
  connector: ConnectorLike;
  address: string;
  chainId: number;
  disconnect: () => void;
}): PrivyWalletLike {
  const { connector } = input;
  return {
    type: "ethereum",
    address: input.address,
    chainId: `eip155:${input.chainId}`,
    walletClientType: connector.id,
    connectorType: connector.type,
    imported: false,
    meta: { name: connector.name, id: connector.id, icon: connector.icon },
    getEthereumProvider: async () =>
      (await connector.getProvider()) as Eip1193Like,
    disconnect: input.disconnect,
  };
}

/** RainbowKit ships these UI locales; everything else falls back to its English modal copy. */
const RAINBOW_LOCALES = new Set([
  "ar",
  "de",
  "en",
  "es",
  "fr",
  "hi",
  "id",
  "ja",
  "ko",
  "pt-BR",
  "ru",
  "th",
  "tr",
  "uk",
  "vi",
  "zh-CN",
  "zh-TW",
]);
export function rainbowLocale(language: string) {
  return RAINBOW_LOCALES.has(language) ? language : "en";
}
