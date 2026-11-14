// V1.9 two-stage loader: the product's first-load bundle references only this tiny async module; the Privy SDK
// graph (and the long list of its chunk files) is referenced from here, so pages that never press
// "Connect wallet" carry neither the SDK nor its chunk manifest.
export const loadPrivyWalletLayer = () => import("./layer");
