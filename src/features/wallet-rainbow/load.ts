// gf1 G02 two-stage loader (same pattern as the Privy layer): the product's first-load bundle references only this
// tiny async module; RainbowKit, wagmi and their styles load on the first "Connect wallet" click.
export const loadRainbowWalletLayer = () => import("./layer");
