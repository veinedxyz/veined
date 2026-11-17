// VEINED-MC1 (BRIDGE LANE): the bridge lane's pin sets — per chain, every contract the lane reads or calls, with the
// keccak256 of its runtime code. A review re-reads every hash on BOTH source operators at one block (and the
// destination SpokePool and USDC on BOTH destination operators) and refuses on any change: an upgrade, a re-deployment,
// a re-pointed proxy, or the Diamond's selector 0x1794958f re-routed to another facet.
//   Diamond 0x1231…4EaE (LI.FI): one address on every chain; the code hash is the same on five chains, Base differs.
//   AcrossFacetV4 0xAd3f…6BCd: one address, but the code hash is PER CHAIN (SPOKEPOOL / WRAPPED_NATIVE immutables).
//   FeeCollector 0xde2b…bbae (selector 0x332d746b forwardERC20Fees, one recipient 0xc06e…264b): one hash everywhere.
//   SpokePool (Across, = the facet's SPOKEPOOL()): an EIP-1967 proxy, implementation pinned per chain.
//   USDC (Circle FiatTokenProxy, zeppelinos implementation slot; BNB: Binance-Peg, EIP-1967).
// Source: read-only evidence D:/vnd/hk1/mc1/evidence/B-matrix (2026-11-15): D-lifi-onchain.json (Diamond, facet for
// the selector, SPOKEPOOL(), SpokePool + implementation, FeeCollector; every hash equal on both evidence operators of
// the chain), BC-tokens-swap.json (USDC + implementation), equal byte for byte to the signer v5 code table
// (policy-v5.mjs CHAINS[*].code) and, for Base, to the reviewed canary pin set (g14-canary-pins.2026-11-12.2).
import { BRIDGE_LANE_CHAINS, bridgeChainById } from "./bridge-scope";
import { ARBITRUM_NODE_INTERFACE, type LanePin } from "./pins";

export const BRIDGE_LANE_PIN_SET = "veined-bridge-lane-pins.2026-11-16.1";
export const BRIDGE_LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
export const BRIDGE_ACROSS_FACET = "0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd";
export const BRIDGE_FEE_COLLECTOR =
  "0xde2b920506ee931a6a2abdf566526220214fbbae";
/** The only fee recipient (LI.FI fee wallet, identical in all 30 simulated quotes). */
export const BRIDGE_FEE_RECIPIENT =
  "0xc06ebbefd94032b85424d51906e2a335efae264b";
export const BRIDGE_LANE_SELECTORS = Object.freeze({
  approve: "0x095ea7b3",
  /** AcrossFacetV4.swapAndStartBridgeTokensViaAcrossV4 — the ONLY bridge entry point. */
  bridge: "0x1794958f",
  /** FeeCollector.forwardERC20Fees(address,(address,uint256)[]) — the ONLY source step. */
  forwardFees: "0x332d746b",
  /** Diamond loupe facetAddress(bytes4). */
  facetAddress: "0xcdffacc6",
  /** AcrossFacetV4.SPOKEPOOL(). */
  spokePool: "0xf6503992",
});
/** keccak256 of the event signatures (tests recompute them from the ABI). */
export const BRIDGE_LANE_TOPICS = Object.freeze({
  fundsDeposited:
    "0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3",
  filledRelay:
    "0x44b559f101f8fbcc8a0ea43fa91a05a729a5ea6e14a7c75aa750374690137208",
  transfer:
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
});
const ZOS_SLOT =
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const EIP1967_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const OP_STACK_ORACLE = "0x420000000000000000000000000000000000000F";
const DIAMOND_HASH =
  "0x828f8a0694bfba25c80a406283f149d701cdc944acbbc18b57315cf157db9220";
const FEE_COLLECTOR_HASH =
  "0x99a76627aece8903612e0246c10f13a46e511a0a074d9a4e68987a28c78ebd52";
const SPOKE_POOL_PROXY_HASH =
  "0x932cddc50793da935ccf915651ad67f6b746e9936fcc5614f0ff492563782c75";

export interface BridgeChainPins {
  set: string;
  chainId: string;
  /** Where the hashes come from (evidence file + operators). */
  source: string;
  diamond: LanePin;
  /** The facet the Diamond routes the bridge selector to. */
  facet: LanePin;
  feeCollector: LanePin;
  /** Across SpokePool (EIP-1967 proxy): = AcrossFacetV4.SPOKEPOOL() on this chain. */
  spokePool: LanePin & {
    implementation: { slot: string; address: string; codehash: string };
  };
  usdc: LanePin & {
    implementation: { slot: string; address: string; codehash: string };
  };
  /** OP-stack GasPriceOracle (L1 data fee, operator fee) — OP_STACK chains only. */
  gasPriceOracle: string | null;
}
const pins = (p: BridgeChainPins): Readonly<BridgeChainPins> =>
  Object.freeze({
    ...p,
    diamond: Object.freeze({ ...p.diamond }),
    facet: Object.freeze({ ...p.facet }),
    feeCollector: Object.freeze({ ...p.feeCollector }),
    spokePool: Object.freeze({
      ...p.spokePool,
      implementation: Object.freeze({ ...p.spokePool.implementation }),
    }),
    usdc: Object.freeze({
      ...p.usdc,
      implementation: Object.freeze({ ...p.usdc.implementation }),
    }),
  });
const common = (diamondHash: string) => ({
  diamond: { address: BRIDGE_LIFI_DIAMOND, codehash: diamondHash },
  feeCollector: { address: BRIDGE_FEE_COLLECTOR, codehash: FEE_COLLECTOR_HASH },
});

export const BRIDGE_LANE_CHAIN_PINS: Readonly<
  Record<string, Readonly<BridgeChainPins>>
> = Object.freeze({
  "1": pins({
    set: BRIDGE_LANE_PIN_SET,
    chainId: "1",
    source:
      "B-matrix D-lifi-onchain.json block 26422857 (rpc.mevblocker.io = ethereum-rpc.publicnode.com); BC-tokens-swap.json",
    ...common(DIAMOND_HASH),
    facet: {
      address: BRIDGE_ACROSS_FACET,
      codehash:
        "0x3018e22e23c2513b0a199a42882e855aa98777883cc7e68062fe3828ff6e2689",
    },
    spokePool: {
      address: "0x5c7BCd6E7De5423a257D81B442095a1a6ced35C5",
      codehash: SPOKE_POOL_PROXY_HASH,
      implementation: {
        slot: EIP1967_SLOT,
        address: "0x456Ac26E5ec083EE9889eBa0d1a0A582502B8e84",
        codehash:
          "0x94cc890a705ae8f4b973b6531b201fcd53c6bcbefba7caa12d1812f6fcede5bf",
      },
    },
    usdc: {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      codehash:
        "0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505",
      implementation: {
        slot: ZOS_SLOT,
        address: "0x43506849D7C04F9138D1A2050bbF3A0c054402dd",
        codehash:
          "0xcdfb7d322961af3acae7a8f7ee8b69c205b36f576cc5b077f170c7eb8ecbe3ea",
      },
    },
    gasPriceOracle: null,
  }),
  "8453": pins({
    set: BRIDGE_LANE_PIN_SET,
    chainId: "8453",
    source:
      "B-matrix D-lifi-onchain.json block 57924448 (base-rpc.publicnode.com = base.drpc.org); = canary pin set g14-canary-pins.2026-11-12.2",
    ...common(
      "0x5efa2ebe1ed041ce83c069f1cedc04945f1438680dacf5f88068ef6c7d94110a",
    ),
    facet: {
      address: BRIDGE_ACROSS_FACET,
      codehash:
        "0x0d049cb64bfcb713b3fe8fa4727ae763cc1efe1e741ea5c43d41d07add0fb1f8",
    },
    spokePool: {
      address: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
      codehash: SPOKE_POOL_PROXY_HASH,
      implementation: {
        slot: EIP1967_SLOT,
        address: "0xf23C6C04A2B88e8651FE99bbDccbB5C9D306e6B0",
        codehash:
          "0xb36f3bbdffcc931890a4354aa13c9756f032cf6f968d1d1a9604cb3ece9eb480",
      },
    },
    usdc: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      codehash:
        "0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab",
      implementation: {
        slot: ZOS_SLOT,
        address: "0x2ce6311ddae708829bc0784c967b7d77d19fd779",
        codehash:
          "0x11b75a237997ab8328f65b2d5a55c10f0346d0a175741ed42ddf4f2c66b9e873",
      },
    },
    gasPriceOracle: OP_STACK_ORACLE,
  }),
  "42161": pins({
    set: BRIDGE_LANE_PIN_SET,
    chainId: "42161",
    source:
      "B-matrix D-lifi-onchain.json block 524559413 (arb1.arbitrum.io/rpc = arbitrum.drpc.org); BC-tokens-swap.json",
    ...common(DIAMOND_HASH),
    facet: {
      address: BRIDGE_ACROSS_FACET,
      codehash:
        "0xf55f58c8e685178b358b945bcc6c6c7ba0d96cc78f6f22878a4a862f2ba8d339",
    },
    spokePool: {
      address: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
      codehash: SPOKE_POOL_PROXY_HASH,
      implementation: {
        slot: EIP1967_SLOT,
        address: "0xcfCDA84333431BCC9155f2368B8362F0d1dfF8c9",
        codehash:
          "0xa860f20748abfdf98f4e55411b5db7630457bec1abfb5d88f1ecd5f25b4ec24b",
      },
    },
    usdc: {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      codehash:
        "0xad30d819dbc47814b7e6cb837fd7cc57fcb591479a38596ee93de4fc52e8c435",
      implementation: {
        slot: ZOS_SLOT,
        address: "0x86E721b43d4ECFa71119Dd38c0f938A75Fdb57B3",
        codehash:
          "0xda0578bf7fe0d04e320e166ab8f98061328fda8ae0a299882aeb38f1543c6a9d",
      },
    },
    gasPriceOracle: null,
  }),
  "10": pins({
    set: BRIDGE_LANE_PIN_SET,
    chainId: "10",
    source:
      "B-matrix D-lifi-onchain.json block 159588244 (mainnet.optimism.io = optimism.drpc.org); BC-tokens-swap.json",
    ...common(DIAMOND_HASH),
    facet: {
      address: BRIDGE_ACROSS_FACET,
      codehash:
        "0x5a04fc18f35fa01344a2d752123551bc57edb3065573fe0ef02d5d8108591298",
    },
    spokePool: {
      address: "0x6f26Bf09B1C792e3228e5467807a900A503c0281",
      codehash: SPOKE_POOL_PROXY_HASH,
      implementation: {
        slot: EIP1967_SLOT,
        address: "0x60674c53a4cC4ED350659C95fb8020B5AC61cA1D",
        codehash:
          "0xcf5c48ec3d2a4cbd9e097f08e8888e4c07d8698e626414e284f52b66515e2b21",
      },
    },
    usdc: {
      address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      codehash:
        "0xaad43333d28e146557f1c682e8a4226743fb231fdd00a577512233bd9e920008",
      implementation: {
        slot: ZOS_SLOT,
        address: "0xdEd3b9a8DBeDC2F9CB725B55d0E686A81E6d06dC",
        codehash:
          "0x24c6e8b8e0aaea31861e014c15e9da1564402d3512eb474d46def8e8bb2b2259",
      },
    },
    gasPriceOracle: OP_STACK_ORACLE,
  }),
  "137": pins({
    set: BRIDGE_LANE_PIN_SET,
    chainId: "137",
    source:
      "B-matrix D-lifi-onchain.json block 97379867 (polygon-bor-rpc.publicnode.com = polygon.drpc.org); BC-tokens-swap.json",
    ...common(DIAMOND_HASH),
    facet: {
      address: BRIDGE_ACROSS_FACET,
      codehash:
        "0x053d15581598f1724768a049b13c4cf8a746d4ff5f201f8aee767b43dec2db0e",
    },
    spokePool: {
      address: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096",
      codehash: SPOKE_POOL_PROXY_HASH,
      implementation: {
        slot: EIP1967_SLOT,
        address: "0x304BEd95DaeCD3e680073eab385193da711D59d4",
        codehash:
          "0x9fccb54e8a69629d8cb50bb3e00042456418de9c600dc73763e81b80e7262518",
      },
    },
    usdc: {
      address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      codehash:
        "0x7dbf0ee7d6d69b563891ceb7056cf0ff0fa09d21a48e5f812d89981c2ef95944",
      implementation: {
        slot: ZOS_SLOT,
        address: "0x235AE97b28466Db30469b89A9fe4cFf0659f82Cb",
        codehash:
          "0x39ec98a4509fb2d4380a9cd4623e7b20cf651cb58edb8d8332bfad9c3d698143",
      },
    },
    gasPriceOracle: null,
  }),
  // BNB Chain: BLOCKED (no Circle USDC). Pinned so a later owner decision only re-verifies; never read while BLOCKED.
  "56": pins({
    set: BRIDGE_LANE_PIN_SET,
    chainId: "56",
    source:
      "B-matrix D-lifi-onchain.json block 133801346 (bsc-rpc.publicnode.com = rpc-bsc.48.club); BC-tokens-swap.json",
    ...common(DIAMOND_HASH),
    facet: {
      address: BRIDGE_ACROSS_FACET,
      codehash:
        "0xc4d421a71c7be08e990bd0b88fdf61afb6ed1b3c60afed6899cad8deebb42e5e",
    },
    spokePool: {
      address: "0x4e8E101924eDE233C13e2D8622DC8aED2872d505",
      codehash: SPOKE_POOL_PROXY_HASH,
      implementation: {
        slot: EIP1967_SLOT,
        address: "0xC7B7029373f504949553106c9eb2dAfDd48eF086",
        codehash:
          "0x536bd9288be6c656bfc28f182d249a6483cbaa3c645190eaa71a17ea6aca9dfa",
      },
    },
    usdc: {
      address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      codehash:
        "0x56069ff2fd59ae482f7984aa894b6d3bc84cb910354dcda9cd6c828d61526914",
      implementation: {
        slot: EIP1967_SLOT,
        address: "0xBA5Fe23f8a3a24BEd3236F05F2FcF35fd0BF0B5C",
        codehash:
          "0xd2d7cf7504e1cb572af28476d45907fc30bee1297917bed153e6fbba125821a3",
      },
    },
    gasPriceOracle: null,
  }),
});
/** The pin set of a chain (own entries only), or null. */
export function bridgePinsOf(
  chainId: unknown,
): Readonly<BridgeChainPins> | null {
  return typeof chainId === "string" &&
    Object.prototype.hasOwnProperty.call(BRIDGE_LANE_CHAIN_PINS, chainId)
    ? BRIDGE_LANE_CHAIN_PINS[chainId]
    : null;
}
/** The source-side contracts whose code a review re-reads, in a fixed order (proxies and their implementations). */
export const sourceCodePins = (p: Readonly<BridgeChainPins>) =>
  [
    p.diamond,
    p.facet,
    p.feeCollector,
    p.spokePool,
    {
      address: p.spokePool.implementation.address,
      codehash: p.spokePool.implementation.codehash,
    },
    p.usdc,
    {
      address: p.usdc.implementation.address,
      codehash: p.usdc.implementation.codehash,
    },
  ] as readonly LanePin[];
/** The destination-side contracts whose code a review and a settlement re-read. */
export const destinationCodePins = (p: Readonly<BridgeChainPins>) =>
  [
    p.spokePool,
    {
      address: p.spokePool.implementation.address,
      codehash: p.spokePool.implementation.codehash,
    },
    p.usdc,
    {
      address: p.usdc.implementation.address,
      codehash: p.usdc.implementation.codehash,
    },
  ] as readonly LanePin[];
/** Every contract a bridge-lane read on this chain may name (nothing else, no caller-chosen contract), lower case. */
export function bridgeReadContracts(chainId: unknown): readonly string[] {
  const p = bridgePinsOf(chainId);
  if (!p) return Object.freeze([]);
  return Object.freeze(
    [
      ...sourceCodePins(p).map((c) => c.address),
      ...(p.gasPriceOracle ? [p.gasPriceOracle] : []),
      ...(bridgeChainById(chainId)?.feeModel === "ARBITRUM"
        ? [ARBITRUM_NODE_INTERFACE]
        : []),
    ].map((a) => a.toLowerCase()),
  );
}
/** Why a chain's pin set does not match the chain table ([] = it does). The engine refuses a review on any of them. */
export function bridgePinProblems(chainId: unknown): string[] {
  const c = bridgeChainById(chainId),
    p = bridgePinsOf(chainId);
  if (!c || !p) return ["PIN_SET_MISSING"];
  const out: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (p.set !== BRIDGE_LANE_PIN_SET || p.chainId !== c.chainId)
    out.push("PIN_SET_CHAIN");
  if (!same(p.usdc.address, c.usdc.address)) out.push("PIN_ADDRESS:usdc");
  if (!same(p.diamond.address, BRIDGE_LIFI_DIAMOND))
    out.push("PIN_ADDRESS:diamond");
  if (!same(p.facet.address, BRIDGE_ACROSS_FACET))
    out.push("PIN_ADDRESS:facet");
  if (!same(p.feeCollector.address, BRIDGE_FEE_COLLECTOR))
    out.push("PIN_ADDRESS:feeCollector");
  for (const pin of [...sourceCodePins(p)])
    if (pin.codehash !== null && !/^0x[0-9a-f]{64}$/.test(pin.codehash))
      out.push(`PIN_HASH_MALFORMED:${pin.address}`);
  const all = sourceCodePins(p).map((x) => x.address.toLowerCase());
  if (new Set(all).size !== all.length) out.push("ADDRESS_REUSED");
  if ((c.feeModel === "OP_STACK") !== (p.gasPriceOracle !== null))
    out.push("PIN_ORACLE");
  return out;
}
/** Every chain of the table has exactly one pin set (a unit test keeps the two tables equal). */
export const BRIDGE_LANE_PIN_CHAINS: readonly string[] = Object.freeze(
  Object.keys(BRIDGE_LANE_CHAINS).filter((id) => bridgePinsOf(id) !== null),
);
