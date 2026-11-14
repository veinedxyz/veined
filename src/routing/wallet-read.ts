import { validAddress } from "./addresses";
import { RoutingError, type Network } from "./model";
interface SolanaReadWallet {
  connect: () => Promise<{ publicKey: { toString: () => string } }>;
  publicKey?: { toString: () => string };
}
interface BitcoinReadWallet {
  requestAccounts: () => Promise<string[]>;
  getAccounts: () => Promise<string[]>;
  getNetwork?: () => Promise<string>;
}
interface TronReadWallet {
  request: (args: { method: "tron_requestAccounts" }) => Promise<unknown>;
}
declare global {
  interface Window {
    solana?: SolanaReadWallet;
    unisat?: BitcoinReadWallet;
    tronLink?: TronReadWallet;
    tronWeb?: { defaultAddress?: { base58?: string } };
  }
}
// Read/permission methods only. Never hand transaction payloads to these objects.
export async function connectNativeRead(network: Network): Promise<string> {
  let value = "";
  if (network.ecosystem === "SVM" && window.solana)
    value = (await window.solana.connect()).publicKey.toString();
  else if (
    network.ecosystem === "UTXO" &&
    network.key === "btc" &&
    window.unisat
  ) {
    const bitcoinWallet = window.unisat;
    if (
      !bitcoinWallet.getNetwork ||
      (await bitcoinWallet.getNetwork()) !== "livenet"
    )
      throw new RoutingError("WALLET_ECOSYSTEM_UNSUPPORTED");
    value = (await bitcoinWallet.requestAccounts())[0] ?? "";
    if ((await bitcoinWallet.getNetwork()) !== "livenet")
      throw new RoutingError("WALLET_ECOSYSTEM_UNSUPPORTED");
  } else if (network.ecosystem === "TVM" && window.tronLink) {
    await window.tronLink.request({ method: "tron_requestAccounts" });
    value = window.tronWeb?.defaultAddress?.base58 ?? "";
  } else if (network.ecosystem === "MVM" || network.ecosystem === "SVM") {
    const { getWallets } = await import("@wallet-standard/app");
    const chain =
      network.ecosystem === "MVM" ? "sui:mainnet" : "solana:mainnet";
    const wallet = getWallets()
      .get()
      .find(
        (w) =>
          w.chains.includes(chain as `${string}:${string}`) &&
          "standard:connect" in w.features,
      );
    if (!wallet) throw new RoutingError("WALLET_ECOSYSTEM_UNSUPPORTED");
    const feature = wallet.features["standard:connect"] as {
      connect?: () => Promise<{
        accounts: readonly { address: string; chains: readonly string[] }[];
      }>;
    };
    if (typeof feature.connect !== "function")
      throw new RoutingError("WALLET_ECOSYSTEM_UNSUPPORTED");
    const connected = await feature.connect();
    value =
      connected.accounts.find((a) => a.chains.includes(chain))?.address ?? "";
    standardIdentities.set(
      network.ecosystem,
      () => wallet.accounts.find((a) => a.chains.includes(chain))?.address,
    );
  } else if (network.ecosystem === "STL") {
    const { isConnected, requestAccess, getNetwork } =
      await import("@stellar/freighter-api");
    if (!(await isConnected()).isConnected)
      throw new RoutingError("WALLET_ECOSYSTEM_UNSUPPORTED");
    const { networkPassphrase } = await getNetwork();
    if (networkPassphrase !== "Public Global Stellar Network ; September 2015")
      throw new RoutingError("WALLET_ECOSYSTEM_UNSUPPORTED");
    const read = await requestAccess();
    if (read.error) throw new RoutingError("WALLET_ECOSYSTEM_UNSUPPORTED");
    value = read.address;
    if (
      (await getNetwork()).networkPassphrase !==
      "Public Global Stellar Network ; September 2015"
    )
      throw new RoutingError("WALLET_ECOSYSTEM_UNSUPPORTED");
  } else throw new RoutingError("WALLET_ECOSYSTEM_UNSUPPORTED");
  if (!validAddress(network.ecosystem, value, network.key))
    throw new RoutingError("INVALID_ADDRESS");
  return value;
}
const standardIdentities = new Map<string, () => string | undefined>();
export async function readNativeIdentity(
  network: Network,
): Promise<string | undefined> {
  if (network.ecosystem === "SVM")
    return (
      window.solana?.publicKey?.toString() ?? standardIdentities.get("SVM")?.()
    );
  if (network.ecosystem === "TVM")
    return window.tronWeb?.defaultAddress?.base58;
  if (network.ecosystem === "UTXO") {
    if (
      network.key !== "btc" ||
      (await window.unisat?.getNetwork?.()) !== "livenet"
    )
      return undefined;
    return (await window.unisat?.getAccounts())?.[0];
  }
  if (network.ecosystem === "MVM") return standardIdentities.get("MVM")?.();
  if (network.ecosystem === "STL") {
    const { getAddress, getNetwork } = await import("@stellar/freighter-api");
    if (
      (await getNetwork()).networkPassphrase !==
      "Public Global Stellar Network ; September 2015"
    )
      return undefined;
    return (await getAddress()).address;
  }
}
const pendingPermissions = new Set<string>();
export async function boundedNativeConnect(network: Network) {
  if (pendingPermissions.has(network.ecosystem))
    throw new RoutingError("WALLET_REQUEST_PENDING");
  pendingPermissions.add(network.ecosystem);
  const underlying = connectNativeRead(network).finally(() =>
    pendingPermissions.delete(network.ecosystem),
  );
  return await boundedWalletRead(underlying);
}
export async function boundedWalletRead<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RoutingError("WALLET_TIMEOUT")),
          12000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
