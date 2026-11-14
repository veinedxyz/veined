import { MODES, SwapError, type ProviderMode } from "../model";
// Server imports only. Sources and exact revisions are retained in SWAP_PROVIDER_SOURCE_INVENTORY.md.
export const PINS = Object.freeze({
  "1": {
    wrapper: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    uniswap: "0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85",
    pancake: "0x65b382653f7C31bC0Af67f188122035461ec9C76",
  },
  "56": {
    wrapper: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    uniswap: "0xDc264714F68d84CF29BC605589405E78bDBE7C9f",
    pancake: "0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB",
  },
  "8453": {
    wrapper: "0x4200000000000000000000000000000000000006",
    uniswap: "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40",
    pancake: "0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB",
  },
});
export const AERO = Object.freeze({
  router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
  factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
  registry: "0x5C3F18F06CC09CA1910767A34a20F771039E37C0",
  slipstream: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
  clFactory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
  quoter: "0x514c8B5f54112481E28028F1166Bd78501089259",
});
export const PERMIT2 = {
  Uniswap: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  PancakeSwap: "0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768",
} as const;
export const RPC_ORIGINS = {
  "1": "https://ethereum-rpc.publicnode.com",
  "56": "https://bsc-rpc.publicnode.com",
  "8453": "https://base-rpc.publicnode.com",
  solana: "https://api.mainnet-beta.solana.com",
} as const;
/**
 * G14 protected proposal B4 — the canary's READ-ONLY RPC pool: exactly two sources per chain, each with the operator
 * that runs it. The operator id is server configuration (it is what "independent" means here): two URLs, ports or
 * subdomains of one operator are ONE source. The pool is separate from RPC_ORIGINS on purpose — Swap keeps its single
 * origin per chain and Arbitrum does not become a Swap chain. No key, account or paid service is involved; no user
 * or request can add a URL. Reads only (the canary pool reader's method list is a subset of the transport's).
 * Operators (public endpoints of record on 2026-11-12, to be re-confirmed at activation): publicnode.com — Allnodes;
 * mainnet.base.org — Base (Coinbase); arb1.arbitrum.io — Arbitrum (Offchain Labs).
 */
export interface RpcSource {
  operator: string;
  url: string;
}
export const CANARY_RPC_POOL = Object.freeze({
  "8453": Object.freeze([
    Object.freeze({
      operator: "allnodes-publicnode",
      url: RPC_ORIGINS["8453"],
    }),
    Object.freeze({
      operator: "base-coinbase",
      url: "https://mainnet.base.org",
    }),
  ] as const),
  "42161": Object.freeze([
    Object.freeze({
      operator: "allnodes-publicnode",
      url: "https://arbitrum-one-rpc.publicnode.com",
    }),
    Object.freeze({
      operator: "arbitrum-offchain-labs",
      url: "https://arb1.arbitrum.io/rpc",
    }),
  ] as const),
}) satisfies Readonly<Record<string, readonly [RpcSource, RpcSource]>>;
/**
 * G14 closure (B4): the ONLY contracts a canary read may name, per chain (transport.ts canaryRead: eth_call,
 * eth_getCode, eth_getStorageAt, eth_getLogs and the simulated calls). They are the pinned contracts of the canary's
 * pin set g14-canary-pins.2026-11-12.2 (src/execution/canary/pins.ts; a unit test keeps the two equal): on Base the
 * LI.FI Diamond, the Across facet, the SpokePool proxy and implementation, Circle USDC proxy and implementation, the
 * LI.FI fee collector and the OP-stack GasPriceOracle; on Arbitrum the SpokePool and USDC, each with its
 * implementation. Nothing else can be read through the canary capability — no caller-chosen contract.
 */
export const CANARY_READ_CONTRACTS = Object.freeze({
  "8453": Object.freeze([
    "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
    "0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd",
    "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
    "0xf23c6c04a2b88e8651fe99bbdccbb5c9d306e6b0",
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "0x2ce6311ddae708829bc0784c967b7d77d19fd779",
    "0xde2b920506ee931a6a2abdf566526220214fbbae",
    "0x420000000000000000000000000000000000000F",
  ]),
  "42161": Object.freeze([
    "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
    "0xcfcda84333431bcc9155f2368b8362f0d1dff8c9",
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "0x86e721b43d4ecfa71119dd38c0f938a75fdb57b3",
  ]),
}) satisfies Readonly<Record<keyof typeof CANARY_RPC_POOL, readonly string[]>>;
export function swapConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (typeof window !== "undefined") throw new SwapError("EXECUTION_CLOSED");
  const killed = new Set(
    (env.SWAP_DISABLED_PROVIDERS ?? "").split(",").filter(Boolean),
  );
  if (
    [...killed].some((v) => !MODES.includes(v as ProviderMode)) ||
    env.SWAP_EXECUTION_ENABLED === "true"
  )
    throw new SwapError("REVIEW_REQUIRED");
  return {
    killed,
    build: env.SWAP_BUILD_ENABLED !== "false",
    review: env.SWAP_REVIEW_ENABLED !== "false",
    uniswapKey: env.UNISWAP_API_KEY ?? "",
    jupiterKey: env.JUPITER_API_KEY ?? "",
    titanToken: env.TITAN_AUTH_TOKEN ?? "",
    titanEndpoint: env.TITAN_WS_ENDPOINT ?? "",
    pcsx: env.PCSX_QUOTE_ENABLED === "true",
    pcsxKey: env.PCSX_INTEGRATOR_KEY ?? "",
  };
}
export function routerPin(mode: ProviderMode, chain: string) {
  if (mode === "AERODROME_CLASSIC" && chain === "8453")
    return { address: AERO.router, version: "classic@1ba30815", permit2: null };
  if (mode === "AERODROME_SLIPSTREAM" && chain === "8453")
    return {
      address: AERO.slipstream,
      version: "gauges-v3@f8717faa",
      permit2: null,
    };
  const pin = PINS[chain as keyof typeof PINS];
  if (!pin) throw new SwapError("REVIEW_REQUIRED");
  if (mode === "UNISWAP")
    return {
      address: pin.uniswap,
      version: "2.1.2@802fe4c",
      permit2: PERMIT2.Uniswap,
    };
  if (mode === "PANCAKESWAP_SMART")
    return {
      address: pin.pancake,
      version: chain === "1" ? "v3" : "infinity@1b6d479e",
      permit2: PERMIT2.PancakeSwap,
    };
  throw new SwapError("REVIEW_REQUIRED");
}
