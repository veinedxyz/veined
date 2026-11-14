// G14 Track A: the ONE owner-signed canary route and every contract it touches, pinned from live read-only evidence
// (C:\vnd\hk1\g14\fin\evidence\canary-probe-1: LI.FI quote with a synthetic address, Diamond loupe, eth_getCode keccak
// code hashes, EIP-1967 / FiatToken implementation slots, two independent RPCs per chain, eth_simulateV1;
// fee-collector-pin-1: the fee collector's code hash from two RPCs at one block).
// Browser-safe data only. A pin is a claim to RE-VERIFY at review time (pinProblems, source side) and at settlement
// time (destinationPinProblems): a code change, an upgrade, or a re-routing of THE selector the call uses fails the
// canary closed until the owner reviews a new pin set. Only the swap-and-start entry point is in scope (round-1 review
// F1: the direct "start" path is not pinned, decoded or accepted).
// Source review of the pinned facet: LI.FI's own deployment registry names 0xAd3f…6BCd on Base "AcrossFacetV4"
// (lifinance/contracts deployments/base.json); its published source (src/Facets/AcrossFacetV4.sol, @custom:version
// 1.0.0) enforces BridgeData.receiver == AcrossV4Data.receiverAddress when there is no destination call, deposits with
// depositor = refundAddress, and computes the bridged output as minAmountAfterSwaps * outputAmountMultiplier / 1e18
// WITHOUT further checks ("only use LI.FI backend-generated calldata") — so VEINED recomputes and bounds it itself.
// The pinned code hash proves the deployed bytes did not change since the evidence; it does not by itself prove that
// those bytes compile from the published source (stated, not hidden).

export const CANARY_PIN_SET = "g14-canary-pins.2026-11-12.2";
export const CANARY_PINS_OBSERVED_AT = "2026-11-12T09:16:39Z";

export interface ContractPin {
  chainId: string;
  address: string;
  /** keccak256 of the runtime bytecode at `address`. */
  codehash: string;
  /** For proxies: the implementation slot value and that implementation's runtime keccak256. */
  implementation?: { slot: string; address: string; codehash: string };
}

export const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** Circle FiatTokenProxy keeps its implementation in the zeppelinos slot, not the EIP-1967 one. */
export const FIATTOKEN_IMPLEMENTATION_SLOT =
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

export const CANARY_PINS = Object.freeze({
  set: CANARY_PIN_SET,
  diamond: Object.freeze({
    chainId: "8453",
    address: LIFI_DIAMOND,
    codehash:
      "0x5efa2ebe1ed041ce83c069f1cedc04945f1438680dacf5f88068ef6c7d94110a",
  } satisfies ContractPin),
  /** The ONLY accepted entry point: AcrossFacetV4.swapAndStartBridgeTokensViaAcrossV4 (keccak selector verified). */
  selector: "0x1794958f",
  /** Diamond loupe facetAddress(selector) must return this facet, whose code must hash to this value. */
  facet: Object.freeze({
    chainId: "8453",
    address: "0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd",
    codehash:
      "0x0d049cb64bfcb713b3fe8fa4727ae763cc1efe1e741ea5c43d41d07add0fb1f8",
  } satisfies ContractPin),
  /** The facet's immutable SPOKEPOOL (read from the facet) and the Across SpokePool on the destination. */
  spokePools: Object.freeze({
    "8453": Object.freeze({
      chainId: "8453",
      address: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
      codehash:
        "0x932cddc50793da935ccf915651ad67f6b746e9936fcc5614f0ff492563782c75",
      implementation: {
        slot: EIP1967_IMPLEMENTATION_SLOT,
        address: "0xf23c6c04a2b88e8651fe99bbdccbb5c9d306e6b0",
        codehash:
          "0xb36f3bbdffcc931890a4354aa13c9756f032cf6f968d1d1a9604cb3ece9eb480",
      },
    } satisfies ContractPin),
    "42161": Object.freeze({
      chainId: "42161",
      address: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
      codehash:
        "0x932cddc50793da935ccf915651ad67f6b746e9936fcc5614f0ff492563782c75",
      implementation: {
        slot: EIP1967_IMPLEMENTATION_SLOT,
        address: "0xcfcda84333431bcc9155f2368b8362f0d1dff8c9",
        codehash:
          "0xa860f20748abfdf98f4e55411b5db7630457bec1abfb5d88f1ecd5f25b4ec24b",
      },
    } satisfies ContractPin),
  }),
  /** Circle native USDC (FiatTokenProxy) on both ends: name "USD Coin", symbol USDC, 6 decimals (read on chain). */
  usdc: Object.freeze({
    "8453": Object.freeze({
      chainId: "8453",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      codehash:
        "0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab",
      implementation: {
        slot: FIATTOKEN_IMPLEMENTATION_SLOT,
        address: "0x2ce6311ddae708829bc0784c967b7d77d19fd779",
        codehash:
          "0x11b75a237997ab8328f65b2d5a55c10f0346d0a175741ed42ddf4f2c66b9e873",
      },
    } satisfies ContractPin),
    "42161": Object.freeze({
      chainId: "42161",
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      codehash:
        "0xad30d819dbc47814b7e6cb837fd7cc57fcb591479a38596ee93de4fc52e8c435",
      implementation: {
        slot: FIATTOKEN_IMPLEMENTATION_SLOT,
        address: "0x86e721b43d4ecfa71119dd38c0f938a75fdb57b3",
        codehash:
          "0xda0578bf7fe0d04e320e166ab8f98061328fda8ae0a299882aeb38f1543c6a9d",
      },
    } satisfies ContractPin),
  }),
  /** The only source-side step allowed: LI.FI's fee collection (not a proxy; code pinned, review F8). */
  feeCollector: Object.freeze({
    chainId: "8453",
    address: "0xde2b920506ee931a6a2abdf566526220214fbbae",
    codehash:
      "0x99a76627aece8903612e0246c10f13a46e511a0a074d9a4e68987a28c78ebd52",
    selector: "0x332d746b",
    recipients: Object.freeze(["0xc06ebbefd94032b85424d51906e2a335efae264b"]),
  }),
  /** OP-stack GasPriceOracle predeploy on Base (getL1Fee: the L1 data fee of a transaction, review F11). */
  gasPriceOracle: "0x420000000000000000000000000000000000000F",
  /** Event topics (keccak of the published event signatures). */
  topics: Object.freeze({
    transfer:
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    approval:
      "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
    fundsDeposited:
      "0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3",
    lifiTransferStarted:
      "0xcba69f43792f9f399347222505213b55af8e0b0b54b893085c2e27ecbe1644f1",
  }),
});

/** What a review READS on Base from ONE source, all at ONE block, to re-verify the source-side pins. */
export interface PinReads {
  /** Normalized origin of the RPC operator that answered (see chain-reads.ts normalizeOrigin). */
  origin: string;
  chainId: string | null;
  block: { number: string; hash: string } | null;
  /** The selector `facetForSelector` was read for (must be the call's selector, review F1). */
  selector: string;
  diamondCodehash: string | null;
  facetForSelector: string | null;
  facetCodehash: string | null;
  facetSpokePool: string | null;
  feeCollectorCodehash: string | null;
  sourceSpokePool: {
    codehash: string | null;
    implementation: string | null;
    implementationCodehash: string | null;
  };
  sourceUsdc: {
    codehash: string | null;
    implementation: string | null;
    implementationCodehash: string | null;
    decimals: number | null;
    symbol: string | null;
  };
}
/** The destination-side pins, read on Arbitrum at settlement time (review F8). */
export interface DestinationPinReads {
  spokePool: {
    codehash: string | null;
    implementation: string | null;
    implementationCodehash: string | null;
  };
  usdc: {
    codehash: string | null;
    implementation: string | null;
    implementationCodehash: string | null;
    decimals: number | null;
    symbol: string | null;
  };
}
export type PinProblem =
  | "SELECTOR_NOT_IN_SCOPE"
  | "DIAMOND_CODE_CHANGED"
  | "FACET_REROUTED"
  | "FACET_CODE_CHANGED"
  | "FEE_COLLECTOR_CHANGED"
  | "SPOKEPOOL_CHANGED"
  | "SPOKEPOOL_UPGRADED"
  | "USDC_CHANGED"
  | "USDC_UPGRADED"
  | "WRONG_CHAIN"
  | "PIN_UNREADABLE";
const eq = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const text = (v: unknown) => typeof v === "string";

function proxyProblems(
  r:
    | {
        codehash: unknown;
        implementation: unknown;
        implementationCodehash: unknown;
      }
    | undefined,
  pin: ContractPin,
  changed: PinProblem,
  upgraded: PinProblem,
  out: Set<PinProblem>,
) {
  if (
    !r ||
    !text(r.codehash) ||
    !text(r.implementation) ||
    !text(r.implementationCodehash)
  ) {
    out.add("PIN_UNREADABLE");
    return;
  }
  if (!eq(r.codehash, pin.codehash)) out.add(changed);
  if (
    !eq(r.implementation, pin.implementation!.address) ||
    !eq(r.implementationCodehash, pin.implementation!.codehash)
  )
    out.add(upgraded);
}
/** Every mismatch between live source-side reads and the pins (an unreadable value is a problem: fail closed). */
export function pinProblems(r: PinReads | null | undefined): PinProblem[] {
  if (!r || typeof r !== "object") return ["PIN_UNREADABLE"];
  const p = CANARY_PINS;
  const out = new Set<PinProblem>();
  if (!eq(r.selector, p.selector)) out.add("SELECTOR_NOT_IN_SCOPE");
  if (r.chainId !== "8453")
    out.add(r.chainId === null ? "PIN_UNREADABLE" : "WRONG_CHAIN");
  if (!r.block || !text(r.block.number) || !text(r.block.hash))
    out.add("PIN_UNREADABLE");
  for (const v of [
    r.diamondCodehash,
    r.facetForSelector,
    r.facetCodehash,
    r.facetSpokePool,
    r.feeCollectorCodehash,
  ])
    if (!text(v)) out.add("PIN_UNREADABLE");
  if (text(r.diamondCodehash) && !eq(r.diamondCodehash, p.diamond.codehash))
    out.add("DIAMOND_CODE_CHANGED");
  if (text(r.facetForSelector) && !eq(r.facetForSelector, p.facet.address))
    out.add("FACET_REROUTED");
  if (text(r.facetCodehash) && !eq(r.facetCodehash, p.facet.codehash))
    out.add("FACET_CODE_CHANGED");
  if (
    text(r.feeCollectorCodehash) &&
    !eq(r.feeCollectorCodehash, p.feeCollector.codehash)
  )
    out.add("FEE_COLLECTOR_CHANGED");
  if (
    text(r.facetSpokePool) &&
    !eq(r.facetSpokePool, p.spokePools["8453"].address)
  )
    out.add("SPOKEPOOL_CHANGED");
  proxyProblems(
    r.sourceSpokePool,
    p.spokePools["8453"],
    "SPOKEPOOL_CHANGED",
    "SPOKEPOOL_UPGRADED",
    out,
  );
  proxyProblems(
    r.sourceUsdc,
    p.usdc["8453"],
    "USDC_CHANGED",
    "USDC_UPGRADED",
    out,
  );
  if (
    r.sourceUsdc &&
    (r.sourceUsdc.decimals !== 6 || r.sourceUsdc.symbol !== "USDC")
  )
    out.add("USDC_CHANGED");
  return [...out].sort();
}
export function destinationPinProblems(
  r: DestinationPinReads | null | undefined,
): PinProblem[] {
  if (!r || typeof r !== "object") return ["PIN_UNREADABLE"];
  const out = new Set<PinProblem>();
  proxyProblems(
    r.spokePool,
    CANARY_PINS.spokePools["42161"],
    "SPOKEPOOL_CHANGED",
    "SPOKEPOOL_UPGRADED",
    out,
  );
  proxyProblems(
    r.usdc,
    CANARY_PINS.usdc["42161"],
    "USDC_CHANGED",
    "USDC_UPGRADED",
    out,
  );
  if (r.usdc && (r.usdc.decimals !== 6 || r.usdc.symbol !== "USDC"))
    out.add("USDC_CHANGED");
  return [...out].sort();
}
/** The comparable values of a pin read (for two-source agreement). */
export function pinValues(r: PinReads): Record<string, string | null> {
  return {
    selector: r.selector,
    diamondCodehash: r.diamondCodehash,
    facetForSelector: r.facetForSelector,
    facetCodehash: r.facetCodehash,
    facetSpokePool: r.facetSpokePool,
    feeCollectorCodehash: r.feeCollectorCodehash,
    spCodehash: r.sourceSpokePool?.codehash ?? null,
    spImplementation: r.sourceSpokePool?.implementation ?? null,
    spImplementationCodehash: r.sourceSpokePool?.implementationCodehash ?? null,
    usdcCodehash: r.sourceUsdc?.codehash ?? null,
    usdcImplementation: r.sourceUsdc?.implementation ?? null,
    usdcImplementationCodehash: r.sourceUsdc?.implementationCodehash ?? null,
    usdcDecimals:
      r.sourceUsdc?.decimals == null ? null : String(r.sourceUsdc.decimals),
    usdcSymbol: r.sourceUsdc?.symbol ?? null,
  };
}
