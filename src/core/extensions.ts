export type Capability = "unknown" | "unsupported" | "supported";
// Design boundaries only; V1 ships no provider implementations or financial actions.
export interface GasProvider {
  capability: Capability;
  quote(request: {
    sourceChain: number;
    destinationChain: number;
    nativeAsset: string;
  }): Promise<never>;
}
export interface SwapProvider {
  capability: Capability;
  quote(request: {
    chain: number;
    inputAsset: string;
    outputAsset: string;
  }): Promise<never>;
}
export const futureCapabilities = {
  gasDelivery: "unsupported",
  swap: "unsupported",
} as const;
