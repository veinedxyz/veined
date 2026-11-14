import { networkIdentity } from "../content/networks";
import type { Network } from "./model";
export const oneNetwork: Network = {
  id: "612055",
  key: "onechain",
  name: "ONEchain",
  ecosystem: "EVM",
  mainnet: true,
  nativeAsset: {
    chainId: "612055",
    address: "0x0000000000000000000000000000000000000000",
    symbol: "ONE",
    name: "ONE",
    decimals: 18,
  },
  provider: "otherbridge-onebridge",
  theme: {
    ...networkIdentity.onechain,
    provenance: "Curated official ONEchain asset; existing V1 identity",
  },
};
export const initialBsc: Network = {
  id: "56",
  key: "bsc",
  name: "BNB Smart Chain",
  ecosystem: "EVM",
  mainnet: true,
  nativeAsset: {
    chainId: "56",
    address: "0x0000000000000000000000000000000000000000",
    symbol: "BNB",
    name: "BNB",
    decimals: 18,
  },
  provider: "routing-core",
  theme: {
    ...networkIdentity.bsc,
    provenance: "Curated official BNB Chain asset; existing V1 identity",
  },
};
