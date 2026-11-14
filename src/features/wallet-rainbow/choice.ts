// gf1 G02: which external-wallet layer this build uses. Dependency-free so the product's first-load bundle can read it
// without pulling wagmi or RainbowKit. Exact opt-in only; anything else (unset, typo, other case) keeps the accepted
// Privy layer, and RainbowKit is never a fallback for a missing Privy App ID.
export type WalletLayerChoice = "privy" | "rainbowkit";
export function walletLayerChoice(
  value: string | undefined,
): WalletLayerChoice {
  return value === "rainbowkit" ? "rainbowkit" : "privy";
}
