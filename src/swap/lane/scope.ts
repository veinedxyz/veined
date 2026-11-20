// VEINED-FIN-LIVE-20261115-01 (SWAP-LIVE-01): the frozen scope of the narrowly scoped Swap execution lane, as a ROUTE
// TABLE. One route = one chain, Circle's native USDC -> that chain's canonical wrapped native token, Uniswap V3
// SwapRouter02 exactInputSingle on ONE pinned pool, wrapped in multicall(deadline, [..]); exact-amount ERC-20 approve
// to the router (no signature-based allowance and no off-chain signature of any kind); at most 1 unit of the pay token;
// recipient = the owner's own account; single use. The protected owner record names exactly ONE route.
// The table authorizes NOTHING by itself: the lane gate (./approval.ts swapLaneGateState) stays CLOSED unless the
// separate protected facts of a LOCAL armed variant are set (OWNER_SWAP_LANE_APPROVAL, OWNER_SWAP_LANE_KEY_SHA256,
// SWAP_LANE_LIVE_WIRING); a record may only name a route whose status is ENABLED. The general execution firewall
// (src/security/firewall.ts) is not touched and stays closed. This lane is a SEPARATE authority: it never accepts,
// reads or reuses the Bridge canary's record, key, tokens, sessions, journal or dispatch authority.
//
// Route values (multi-chain routes): read-only evidence D:/vnd/hk1/mc1/evidence/B-matrix (2026-11-15; BC-tokens-swap.json
// tokens / router / quoter / factory / pool, both operators equal; E-swap-sims.json eth_simulateV1 approve + multicall
// PASS on both operators; F-fees.json fee data; A-rpc.json operators). The Base route keeps the tokens, router, pool and
// calldata it was reviewed and live-tested with (fl1 evidence/C-swap-pins-20261115.json).
// The lane is never looser than the multi-chain restricted signer v5 (D:/vnd/hk1/mc1/signer/policy-v5.mjs, CHAINS +
// swap routes, 2026-11-16): per ENABLED route maxFeePerGasWei EQUALS the signer's chain ceiling, gasBudgetWei = min(lane
// value, the signer's swap budget), confirmations >= the signer's minConfirmations, maxReviewBlockAgeSec <= its
// maxReadBlockAgeSec, minTipWei >= its minPriorityFeePerGasWei, maxGas <= its gas caps (APPROVE 120 k / EXECUTE 400 k).
// (tests/unit/swap-lane-routes.test.ts pins a copy of those signer values.)

/** Global lane policy (the same for every route). */
export const SWAP_LANE_SCOPE = Object.freeze({
  /** amountOutMinimum may lose at most this much against the fresh, verified quote (GOAL: 0.5 %). */
  maxSlippageBps: 50,
  /** What the lane actually applies: half the cap, so the signer's independent re-quote (which requires the minimum
   * to be within 0.5 % below and not above ITS fresh quote) accepts a price move of about +/-0.25 % (review MAJOR-3). */
  appliedSlippageBps: 25,
  /** The quote may differ from the pool's spot price by at most this much (fee tier + impact). */
  maxPriceImpactBps: 30,
  /** Router deadline window written into multicall(deadline, ...). */
  deadlineSec: 300,
  /** A review (quote, pins, balances, simulation) is usable for this long, then a new review is needed. */
  reviewTtlSec: 20,
  /** Simulated gas need x (1 + margin) is the gas limit (it must fit below the route's cap). */
  gasMarginBps: 2_000n,
  /** ARBITRUM fee model: eth_estimateGas (which includes the L1 component as gas units) x (1 + this margin). */
  estimateMarginBps: 1_000n,
  minGas: 21_000n,
  singleUse: true,
});
export type SwapLaneStep = "APPROVE" | "SWAP";
export const SWAP_LANE_STEPS: readonly SwapLaneStep[] = Object.freeze([
  "APPROVE",
  "SWAP",
]);

export interface SwapLaneToken {
  address: string;
  symbol: string;
  decimals: number;
}
/** How a route pays for its transactions beyond L2 execution gas.
 *  OP_STACK: an L1 data fee (GasPriceOracle.getL1Fee), receipts carry l1Fee. ARBITRUM: the L1 component is charged as
 *  extra gas units (covered by the gas limit; no separate fee). PLAIN: execution gas only. */
export type SwapLaneFeeModel = "OP_STACK" | "ARBITRUM" | "PLAIN";
export interface SwapLaneRoute {
  /** Also the record's `scope`. */
  id: string;
  /** Decimal chain id (the record's chainId). */
  chainId: string;
  /** The transaction's chainId field. */
  chainHex: string;
  /** Circle's native USDC on this chain (raw units, `decimals`). */
  pay: Readonly<SwapLaneToken>;
  /** The chain's canonical wrapped native token. */
  receive: Readonly<SwapLaneToken>;
  provider: "uniswap-v3-swaprouter02";
  /** SwapRouter02: the ONLY call target of the swap and the ONLY spender of the approve. */
  router: string;
  /** QuoterV2 (read only). */
  quoter: string;
  /** Uniswap V3 factory: getPool(pay, receive, poolFee) must return `pool`. */
  factory: string;
  pool: string;
  /** Uniswap V3 fee tier of the pool (hundredths of a bip). */
  poolFee: number;
  /** Token order of the pool (token0 = pay when true): decides the spot-price direction. */
  payIsToken0: boolean;
  feeModel: SwapLaneFeeModel;
  /** Raw pay units: 0.1 unit minimum, exactly 1 unit maximum (GOAL SWAP-LIVE-01). */
  minAmount: bigint;
  maxAmount: bigint;
  /** Gas limits the signer may be asked for (gas need x margin must fit below). */
  maxGas: Readonly<{ APPROVE: bigint; SWAP: bigint }>;
  /** The restricted signer's fee ceiling on this chain (a review above it is refused, never spent). */
  maxFeePerGasWei: bigint;
  /** The priority fee is the higher operator's suggestion, clamped to [minTipWei, maxTipWei]. */
  minTipWei: bigint;
  maxTipWei: bigint;
  /** Native wei both lane transactions together may cost (the record's budget may not exceed it). */
  gasBudgetWei: bigint;
  /** Confirmations before a receipt counts (both operators). */
  confirmations: number;
  /** The block a review reads may be at most this old. */
  maxReviewBlockAgeSec: number;
  status: "ENABLED" | "BLOCKED";
  blockReason: string | null;
}
const route = (r: SwapLaneRoute): Readonly<SwapLaneRoute> =>
  Object.freeze({
    ...r,
    pay: Object.freeze({ ...r.pay }),
    receive: Object.freeze({ ...r.receive }),
    maxGas: Object.freeze({ ...r.maxGas }),
  });

export const SWAP_LANE_ROUTES: Readonly<
  Record<string, Readonly<SwapLaneRoute>>
> = Object.freeze({
  // Base: the reviewed and live-tested route (tokens, router, 0.05 % pool, calldata unchanged). Pool token0 = WETH,
  // token1 = USDC. Aligned to signer v5: budget 1.77e13 wei (signer swap budget, was 1e14), 300 confirmations.
  "base-usdc-weth-univ3-max1": route({
    id: "base-usdc-weth-univ3-max1",
    chainId: "8453",
    chainHex: "0x2105",
    pay: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      decimals: 6,
    },
    receive: {
      address: "0x4200000000000000000000000000000000000006",
      symbol: "WETH",
      decimals: 18,
    },
    provider: "uniswap-v3-swaprouter02",
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    pool: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
    poolFee: 500,
    payIsToken0: false,
    feeModel: "OP_STACK",
    minAmount: 100_000n,
    maxAmount: 1_000_000n,
    maxGas: { APPROVE: 100_000n, SWAP: 350_000n },
    maxFeePerGasWei: 200_000_000n,
    minTipWei: 0n,
    maxTipWei: 10_000_000n,
    gasBudgetWei: 17_700_000_000_000n,
    confirmations: 300,
    maxReviewBlockAgeSec: 20,
    status: "ENABLED",
    blockReason: null,
  }),
  // Ethereum: pair rpc.mevblocker.io + ethereum-rpc.publicnode.com (strict pair). Best pool 0.01 % (1.39 M USDC,
  // token0 = USDC). Fees (F-fees): base 0.196 gwei, p50 tip 0.05 gwei, p90 2 gwei; approve + swap ~0.103 USD expected
  // -> budget 5e14 wei (~0.92 USD at 1 830 USD/ETH; signer 5.46e14). Signer v5: 5 gwei ceiling, 10 confirmations,
  // read block at most 45 s old.
  "eth-usdc-weth-univ3-max1": route({
    id: "eth-usdc-weth-univ3-max1",
    chainId: "1",
    chainHex: "0x1",
    pay: {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    },
    receive: {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      symbol: "WETH",
      decimals: 18,
    },
    provider: "uniswap-v3-swaprouter02",
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    pool: "0xE0554a476A092703abdB3Ef35c80e0D76d32939F",
    poolFee: 100,
    payIsToken0: true,
    feeModel: "PLAIN",
    minAmount: 100_000n,
    maxAmount: 1_000_000n,
    maxGas: { APPROVE: 100_000n, SWAP: 350_000n },
    maxFeePerGasWei: 5_000_000_000n,
    minTipWei: 50_000_000n,
    maxTipWei: 1_000_000_000n,
    gasBudgetWei: 500_000_000_000_000n,
    confirmations: 10,
    maxReviewBlockAgeSec: 45,
    status: "ENABLED",
    blockReason: null,
  }),
  // Arbitrum One: pair arb1.arbitrum.io/rpc + arbitrum.drpc.org (publicnode refuses all receipts on Arbitrum; dRPC
  // serves state only for the latest ~5-30 blocks, so the read block must be young). Best pool 0.01 % (6 981 USDC,
  // token0 = WETH; 1 USDC impact 1.15 bps). Tips are ignored (0); base 0.02 gwei; approve + swap ~0.0085 USD expected
  // -> budget 5e13 wei (~0.09 USD; signer 5.87e13). Signer v5: 0.4 gwei ceiling, 200 confirmations.
  "arb-usdc-weth-univ3-max1": route({
    id: "arb-usdc-weth-univ3-max1",
    chainId: "42161",
    chainHex: "0xa4b1",
    pay: {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      symbol: "USDC",
      decimals: 6,
    },
    receive: {
      address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      symbol: "WETH",
      decimals: 18,
    },
    provider: "uniswap-v3-swaprouter02",
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    pool: "0x6f38e884725a116C9C7fBF208e79FE8828a2595F",
    poolFee: 100,
    payIsToken0: false,
    feeModel: "ARBITRUM",
    minAmount: 100_000n,
    maxAmount: 1_000_000n,
    maxGas: { APPROVE: 100_000n, SWAP: 350_000n },
    maxFeePerGasWei: 400_000_000n,
    minTipWei: 0n,
    maxTipWei: 0n,
    gasBudgetWei: 50_000_000_000_000n,
    confirmations: 200,
    maxReviewBlockAgeSec: 10,
    status: "ENABLED",
    blockReason: null,
  }),
  // OP Mainnet: pair mainnet.optimism.io + optimism.drpc.org (publicnode refuses all receipts on OP). Best pool
  // 0.05 % (43 475 USDC, token0 = USDC). OP-stack L1 data fee; base ~536 wei, tip 0.001 gwei; approve + swap
  // ~0.00043 USD expected -> budget 2.99e12 wei (the signer v5 swap budget). Signer v5: 0.02 gwei ceiling, 30
  // confirmations.
  "op-usdc-weth-univ3-max1": route({
    id: "op-usdc-weth-univ3-max1",
    chainId: "10",
    chainHex: "0xa",
    pay: {
      address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      symbol: "USDC",
      decimals: 6,
    },
    receive: {
      address: "0x4200000000000000000000000000000000000006",
      symbol: "WETH",
      decimals: 18,
    },
    provider: "uniswap-v3-swaprouter02",
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    pool: "0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7b",
    poolFee: 500,
    payIsToken0: true,
    feeModel: "OP_STACK",
    minAmount: 100_000n,
    maxAmount: 1_000_000n,
    maxGas: { APPROVE: 100_000n, SWAP: 350_000n },
    maxFeePerGasWei: 20_000_000n,
    minTipWei: 1_000_000n,
    maxTipWei: 10_000_000n,
    gasBudgetWei: 2_990_000_000_000n,
    confirmations: 30,
    maxReviewBlockAgeSec: 20,
    status: "ENABLED",
    blockReason: null,
  }),
  // Polygon PoS: pair polygon-bor-rpc.publicnode.com + polygon.drpc.org. Best pool 0.05 % (22 795 USDC,
  // token0 = WPOL). Bor enforces a minimum tip (eth_maxPriorityFeePerGas 30 gwei on both operators; p50 220 gwei);
  // base ~252 gwei. Approve + swap ~0.0088 USD expected -> budget 1.1 POL (~0.09 USD at 0.081 USD/POL); the 2 000 gwei
  // ceiling (= signer v5) binds before the budget does (signer 1.37 POL). Signer v5: 64 confirmations, tip >= 30 gwei.
  "pol-usdc-wpol-univ3-max1": route({
    id: "pol-usdc-wpol-univ3-max1",
    chainId: "137",
    chainHex: "0x89",
    pay: {
      address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      symbol: "USDC",
      decimals: 6,
    },
    receive: {
      address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      symbol: "WPOL",
      decimals: 18,
    },
    provider: "uniswap-v3-swaprouter02",
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    pool: "0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB",
    poolFee: 500,
    payIsToken0: false,
    feeModel: "PLAIN",
    minAmount: 100_000n,
    maxAmount: 1_000_000n,
    maxGas: { APPROVE: 100_000n, SWAP: 350_000n },
    maxFeePerGasWei: 2_000_000_000_000n,
    minTipWei: 30_000_000_000n,
    maxTipWei: 300_000_000_000n,
    gasBudgetWei: 1_100_000_000_000_000_000n,
    confirmations: 64,
    maxReviewBlockAgeSec: 20,
    status: "ENABLED",
    blockReason: null,
  }),
  // BNB Chain: BLOCKED (owner decision). There is no Circle-native USDC on BNB Chain: the only USDC is Binance-Peg
  // (0x8AC7…580d, 18 decimals, EIP-1967 proxy). Recorded so a later owner decision only flips the status after the pins
  // are re-verified: Uniswap V3 (verified, simulation PASS on both operators) is thin here (best pool 0.01 %, 1 879
  // USDC); the verified alternative is PancakeSwap V3 SmartRouter 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4 (1 bp
  // pool ~150 k USDC, same IV3SwapRouter interface) - not wired. Base fee 0; min gas price 0.05 gwei. Signer v5 (chain
  // BLOCKED there too): 3 gwei ceiling, 140 confirmations, swap budget 1.45e14.
  "bnb-usdc-wbnb-univ3-max1": route({
    id: "bnb-usdc-wbnb-univ3-max1",
    chainId: "56",
    chainHex: "0x38",
    pay: {
      address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      symbol: "USDC",
      decimals: 18,
    },
    receive: {
      address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      symbol: "WBNB",
      decimals: 18,
    },
    provider: "uniswap-v3-swaprouter02",
    router: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
    quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
    factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
    pool: "0x4141325bAc36aFFe9Db165e854982230a14e6d48",
    poolFee: 100,
    payIsToken0: true,
    feeModel: "PLAIN",
    minAmount: 100_000_000_000_000_000n,
    maxAmount: 1_000_000_000_000_000_000n,
    maxGas: { APPROVE: 100_000n, SWAP: 350_000n },
    maxFeePerGasWei: 3_000_000_000n,
    minTipWei: 50_000_000n,
    maxTipWei: 100_000_000n,
    gasBudgetWei: 120_000_000_000_000n,
    confirmations: 140,
    maxReviewBlockAgeSec: 20,
    status: "BLOCKED",
    blockReason: "NO_CIRCLE_USDC",
  }),
  // Avalanche C-Chain: BLOCKED. No public operator supports eth_simulateV1 (coreth: method does not exist), so the
  // lane's two-operator simulation cannot run; the swap path itself is verified by eth_call only (split evidence).
  // Best pool 0.05 % (173 659 USDC, token0 = WAVAX). Signer v5 (chain BLOCKED there too): 100 gwei
  // ceiling, 60 confirmations, swap budget 3.26e16.
  "avax-usdc-wavax-univ3-max1": route({
    id: "avax-usdc-wavax-univ3-max1",
    chainId: "43114",
    chainHex: "0xa86a",
    pay: {
      address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      symbol: "USDC",
      decimals: 6,
    },
    receive: {
      address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
      symbol: "WAVAX",
      decimals: 18,
    },
    provider: "uniswap-v3-swaprouter02",
    router: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE",
    quoter: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F",
    factory: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD",
    pool: "0xfAe3f424a0a47706811521E3ee268f00cFb5c45E",
    poolFee: 500,
    payIsToken0: false,
    feeModel: "PLAIN",
    minAmount: 100_000n,
    maxAmount: 1_000_000n,
    maxGas: { APPROVE: 100_000n, SWAP: 350_000n },
    maxFeePerGasWei: 100_000_000_000n,
    minTipWei: 0n,
    maxTipWei: 5_000_000_000n,
    gasBudgetWei: 26_000_000_000_000_000n,
    confirmations: 60,
    maxReviewBlockAgeSec: 20,
    status: "BLOCKED",
    blockReason: "NO_SIMULATEV1_ON_PUBLIC_OPERATORS",
  }),
});
/**
 * Signer v5 CHAINS[*].maxHeadSkewBlocks: the two operators' heads may differ by at most this many blocks. The signer
 * refuses a request whose read heads are further apart (OPERATOR_HEADS_TOO_FAR_APART), and a refusal spends the step,
 * so a review beyond it is never ready (swap lane and bridge lane alike). Own entries only.
 */
export const LANE_MAX_HEAD_SKEW_BLOCKS: Readonly<Record<string, number>> =
  Object.freeze({
    "1": 2,
    "8453": 5,
    "42161": 10,
    "10": 3,
    "137": 4,
    "56": 10,
    "43114": 10,
  });
/** The head-skew limit of a chain (decimal id), or null for a chain without one (a review then refuses). */
export function maxHeadSkewOf(chainId: unknown): number | null {
  return typeof chainId === "string" &&
    Object.prototype.hasOwnProperty.call(LANE_MAX_HEAD_SKEW_BLOCKS, chainId)
    ? LANE_MAX_HEAD_SKEW_BLOCKS[chainId]
    : null;
}
/** The route of this id (own entries only: no inherited key), or null. */
export function routeById(id: unknown): Readonly<SwapLaneRoute> | null {
  return typeof id === "string" &&
    Object.prototype.hasOwnProperty.call(SWAP_LANE_ROUTES, id)
    ? SWAP_LANE_ROUTES[id]
    : null;
}
/** Every route a record may name. */
export function enabledRoutes(): readonly Readonly<SwapLaneRoute>[] {
  return Object.freeze(
    Object.values(SWAP_LANE_ROUTES).filter((r) => r.status === "ENABLED"),
  );
}
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Internal consistency of one route ([] = consistent). Kept true for every route by the unit tests. */
export function swapLaneRouteProblems(r: Readonly<SwapLaneRoute>): string[] {
  const p: string[] = [];
  if (!/^[a-z0-9-]{8,64}$/.test(r.id)) p.push("ID");
  if (!/^[1-9]\d{0,9}$/.test(r.chainId)) p.push("CHAIN_ID");
  else if (r.chainHex !== "0x" + BigInt(r.chainId).toString(16))
    p.push("CHAIN_HEX");
  for (const [k, a] of [
    ["pay", r.pay.address],
    ["receive", r.receive.address],
    ["router", r.router],
    ["quoter", r.quoter],
    ["factory", r.factory],
    ["pool", r.pool],
  ] as const)
    if (!ADDRESS.test(a) || /^0x0{40}$/.test(a)) p.push(`ADDRESS:${k}`);
  const all = [
    r.pay.address,
    r.receive.address,
    r.router,
    r.quoter,
    r.factory,
    r.pool,
  ].map((a) => a.toLowerCase());
  if (new Set(all).size !== all.length) p.push("ADDRESS_REUSED");
  if (![100, 500, 3000, 10_000].includes(r.poolFee)) p.push("POOL_FEE");
  if (
    !Number.isInteger(r.pay.decimals) ||
    r.pay.decimals < 0 ||
    r.pay.decimals > 36
  )
    p.push("PAY_DECIMALS");
  else {
    const unit = 10n ** BigInt(r.pay.decimals);
    if (r.maxAmount !== unit) p.push("MAX_AMOUNT_NOT_ONE_UNIT");
    if (r.minAmount * 10n !== unit) p.push("MIN_AMOUNT_NOT_A_TENTH");
  }
  if (r.receive.decimals !== 18) p.push("RECEIVE_DECIMALS");
  if (
    r.maxGas.APPROVE < SWAP_LANE_SCOPE.minGas ||
    r.maxGas.SWAP < r.maxGas.APPROVE
  )
    p.push("MAX_GAS");
  if (
    r.minTipWei < 0n ||
    r.maxTipWei < r.minTipWei ||
    r.maxFeePerGasWei <= r.maxTipWei
  )
    p.push("FEE_BOUNDS");
  if (r.gasBudgetWei <= 0n) p.push("GAS_BUDGET");
  if (!Number.isInteger(r.confirmations) || r.confirmations < 1)
    p.push("CONFIRMATIONS");
  if (
    !Number.isInteger(r.maxReviewBlockAgeSec) ||
    r.maxReviewBlockAgeSec < 1 ||
    r.maxReviewBlockAgeSec > 120
  )
    p.push("BLOCK_AGE");
  if (r.status === "ENABLED" && r.blockReason !== null) p.push("BLOCK_REASON");
  if (
    r.status === "BLOCKED" &&
    !(
      typeof r.blockReason === "string" &&
      /^[A-Z0-9_]{3,64}$/.test(r.blockReason)
    )
  )
    p.push("BLOCK_REASON");
  return p;
}
