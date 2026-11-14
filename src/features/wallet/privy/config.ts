// V1.9 Privy configuration: EXTERNAL WALLETS, CONNECT-ONLY. Privy is the wallet discovery/connection/modal layer
// only. No login method other than wallet, no embedded wallet creation, no smart wallets, no funding, no
// automatic chain switch on connect (`defaultChain` is deliberately unset: Privy only enforces a chain on connect
// when it is set), no session cookies. Pure function so the exact shape is unit-tested.

/**
 * Privy App IDs are public browser identifiers; the value comes only from NEXT_PUBLIC_PRIVY_APP_ID (.env.local).
 * The SDK itself refuses anything that is not exactly 25 characters; Privy issues lowercase alphanumeric IDs.
 */
export function validPrivyAppId(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-z0-9]{25}$/.test(value);
}

export interface ChainLike {
  id: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: { default: { http: readonly string[] } };
  blockExplorers?: { default: { name: string; url: string } };
}

/** ONEchain as the wallet layer knows it (WalletConnect optional chain). Same values as the trusted registry. */
export const ONECHAIN: ChainLike = Object.freeze({
  id: 612055,
  name: "ONEchain Mainnet",
  nativeCurrency: Object.freeze({ name: "ONE", symbol: "ONE", decimals: 18 }),
  rpcUrls: Object.freeze({
    default: Object.freeze({
      http: Object.freeze(["https://mainnet.crosstoken.io:22001"]),
    }),
  }),
  blockExplorers: Object.freeze({
    default: Object.freeze({
      name: "ONEchain Explorer",
      url: "https://explorer.onechain.nexus/612055",
    }),
  }),
});

/** Wallets shown in the modal, in order. Rabby, Phantom (EVM) and every other extension arrive via EIP-6963. */
export const WALLET_LIST = Object.freeze([
  "detected_ethereum_wallets",
  "metamask",
  "phantom",
  "coinbase_wallet",
  "rainbow",
  "wallet_connect",
] as const);

export function privyConnectOnlyConfig(options: {
  theme: "dark" | "light";
  chains: readonly ChainLike[];
}) {
  const chains = [
    ...options.chains.filter((c) => c.id !== ONECHAIN.id),
    ONECHAIN,
  ];
  return {
    loginMethods: ["wallet"] as ["wallet"],
    appearance: {
      theme:
        options.theme === "dark" ? ("#151619" as const) : ("light" as const),
      accentColor:
        options.theme === "dark" ? ("#bdccb9" as const) : ("#3e604a" as const),
      walletChainType: "ethereum-only" as const,
      walletList: [...WALLET_LIST],
      showWalletLoginFirst: true,
    },
    embeddedWallets: {
      ethereum: { createOnLogin: "off" as const },
      solana: { createOnLogin: "off" as const },
      showWalletUIs: false,
    },
    externalWallets: {
      // Coinbase Wallet as an EOA only (extension or mobile app): the passkey smart wallet is account abstraction.
      coinbaseWallet: {
        config: { preference: { options: "eoaOnly" as const } },
      },
      walletConnect: { enabled: true },
    },
    supportedChains: chains,
    mfa: { noPromptOnMfaRequired: true },
    sessions: { cookieWriteBehavior: "never" as const },
  };
}
