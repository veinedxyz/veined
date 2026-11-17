// VEINED-FIN-LIVE-20261115-01: the swap lane's pin sets — per route, every contract the lane reads or calls, with the
// keccak256 of its runtime code. A review re-reads every hash on both operators of the route's pool and refuses on any
// change (an upgrade, a re-deployment, a re-pointed proxy), and refuses a route whose pin set holds an UNVERIFIED hash
// (null): nothing is ever pinned that the evidence does not show on both operators.
//   Base: read on 2026-11-15 (Base block 57814258) from BOTH Base operators (base-rpc.publicnode.com and mainnet.base.org
//   agreed byte for byte; fl1 evidence/C-swap-pins-20261115.json).
//   Every other route: D:/vnd/hk1/mc1/evidence/B-matrix/BC-tokens-swap.json (2026-11-15; each hash equal on both
//   evidence operators of that chain); the Uniswap V3 POOL hashes from B-matrix/pool-codehashes.json (2026-11-15, read
//   on BOTH lane operators of SWAP_LANE_RPC_POOL — Avalanche: publicnode + api.avax.network — with token0 / token1 /
//   fee / factory equal on both and matching each route's payIsToken0, fee and factory).
//   No pin is null in this table; a future null pin is still refused by every review (PIN_UNVERIFIED).
import { SWAP_LANE_ROUTES, routeById } from "./scope";

export interface LanePin {
  address: string;
  /** keccak256 of the runtime code, or null = not verified (a review then refuses the route). */
  codehash: string | null;
  implementation?: { slot: string; address: string; codehash: string };
}
export interface LaneRoutePins {
  set: string;
  route: string;
  /** The route's pay token (Circle FiatTokenProxy: implementation slot pinned). */
  pay: LanePin;
  /** The route's wrapped native token. */
  receive: LanePin;
  /** Uniswap V3 SwapRouter02: the ONLY call target and the ONLY spender of the lane on this route. */
  router: LanePin;
  /** Uniswap V3 QuoterV2 (read only). */
  quoter: LanePin;
  /** Uniswap V3 factory: getPool(pay, receive, fee) must return the pinned pool. */
  factory: LanePin;
  pool: LanePin;
  /** OP-stack GasPriceOracle (L1 data fee) — OP_STACK routes only. */
  gasPriceOracle: string | null;
}
/** The three selectors of the lane (the same ABI on every route). */
export const SWAP_LANE_SELECTORS = Object.freeze({
  approve: "0x095ea7b3",
  multicall: "0x5ae401dc",
  exactInputSingle: "0x04e45aaf",
});
const ZOS_SLOT =
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const EIP1967_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const OP_STACK_ORACLE = "0x420000000000000000000000000000000000000F";
/** Arbitrum NodeInterface (virtual, eth_call only): gasEstimateL1Component, the L1 gas signer v5 requires. */
export const ARBITRUM_NODE_INTERFACE =
  "0x00000000000000000000000000000000000000C8";
const pins = (p: LaneRoutePins): Readonly<LaneRoutePins> =>
  Object.freeze({
    ...p,
    pay: Object.freeze({
      ...p.pay,
      ...(p.pay.implementation
        ? { implementation: Object.freeze({ ...p.pay.implementation }) }
        : {}),
    }),
    receive: Object.freeze({ ...p.receive }),
    router: Object.freeze({ ...p.router }),
    quoter: Object.freeze({ ...p.quoter }),
    factory: Object.freeze({ ...p.factory }),
    pool: Object.freeze({ ...p.pool }),
  });

export const SWAP_LANE_ROUTE_PINS: Readonly<
  Record<string, Readonly<LaneRoutePins>>
> = Object.freeze({
  "base-usdc-weth-univ3-max1": pins({
    set: "fl1-swap-lane-pins.2026-11-15.1",
    route: "base-usdc-weth-univ3-max1",
    pay: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      codehash:
        "0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab",
      // Circle FiatTokenProxy (zeppelinos implementation slot).
      implementation: {
        slot: ZOS_SLOT,
        address: "0x2ce6311ddae708829bc0784c967b7d77d19fd779",
        codehash:
          "0x11b75a237997ab8328f65b2d5a55c10f0346d0a175741ed42ddf4f2c66b9e873",
      },
    },
    receive: {
      address: "0x4200000000000000000000000000000000000006",
      codehash:
        "0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c",
    },
    router: {
      address: "0x2626664c2603336E57B271c5C0b26F421741e481",
      codehash:
        "0x38bd640f47df62b2fd5a6755a63f4976ad847dc9b946ae0d145d21d16bb124e4",
    },
    quoter: {
      address: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
      codehash:
        "0xceb5b8bc35e09fc64b1c48c6b920e0d2e37d5710e4f3ef214e1a81f75acee51e",
    },
    factory: {
      address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      codehash:
        "0x95707a4ac71f20181a63ef7d180e3c625be5d20fc8f6f980befa966bad568132",
    },
    // USDC/WETH 0.05 % pool (token0 = WETH, token1 = USDC).
    pool: {
      address: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
      codehash:
        "0xcd06f61c6db6a1d8317548aaaa0aa83254624aec741534c51815810e977587ae",
    },
    gasPriceOracle: OP_STACK_ORACLE,
  }),
  "eth-usdc-weth-univ3-max1": pins({
    set: "veined-swap-lane-pins.1.2026-11-15.1",
    route: "eth-usdc-weth-univ3-max1",
    pay: {
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
    receive: {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      codehash:
        "0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23",
    },
    router: {
      address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      codehash:
        "0x6ec798e80f3a19de650826338677604e54d6664f44a33b53a20b22b1939f402e",
    },
    quoter: {
      address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      codehash:
        "0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b",
    },
    factory: {
      address: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      codehash:
        "0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69",
    },
    // USDC/WETH 0.01 % pool (token0 = USDC, token1 = WETH).
    pool: {
      address: "0xE0554a476A092703abdB3Ef35c80e0D76d32939F",
      codehash:
        "0x65154c5c5a7a171a3d89df22d2a11319ddcb60bdf00ff9a4e3bd7312cb6badce",
    },
    gasPriceOracle: null,
  }),
  "arb-usdc-weth-univ3-max1": pins({
    set: "veined-swap-lane-pins.42161.2026-11-15.1",
    route: "arb-usdc-weth-univ3-max1",
    pay: {
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
    receive: {
      address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      codehash:
        "0x2d240bb4510ed1acfeaba905eb4bcc4524d63c8ae66e48fcccac55ea714db7a7",
    },
    router: {
      address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      codehash:
        "0x209f9820ed7257d51c2f96ee837e8ec057b44774899f4be16fc45bd30cbb16f6",
    },
    quoter: {
      address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      codehash:
        "0xd8162b13ba57ce21a146063b10658bda0a3fd15c99f768c86283fce6640858a5",
    },
    factory: {
      address: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      codehash:
        "0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69",
    },
    // WETH/USDC 0.01 % pool (token0 = WETH, token1 = USDC).
    pool: {
      address: "0x6f38e884725a116C9C7fBF208e79FE8828a2595F",
      codehash:
        "0x2a97cecfded007e8ef2bb083121cd8331ae4984c84abef1516776f57a887fd9b",
    },
    gasPriceOracle: null,
  }),
  "op-usdc-weth-univ3-max1": pins({
    set: "veined-swap-lane-pins.10.2026-11-15.1",
    route: "op-usdc-weth-univ3-max1",
    pay: {
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
    receive: {
      address: "0x4200000000000000000000000000000000000006",
      codehash:
        "0x779bbf2a738ef09d961c945116197e2ac764c1b39304b2b4418cd4e42668b173",
    },
    router: {
      address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      codehash:
        "0x3199a91b0b54bb5e4717f543da9c1bd8efd451d200689d52ef0845d3aa7904f0",
    },
    quoter: {
      address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      codehash:
        "0xd833dcf44a912014423afa2b637f23b5db5b7dc492494cbe3f46026a6d57b424",
    },
    factory: {
      address: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      codehash:
        "0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69",
    },
    // USDC/WETH 0.05 % pool (token0 = USDC, token1 = WETH).
    pool: {
      address: "0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7b",
      codehash:
        "0xd20e8366dace090b2b758dd366810eae25224ad5d9d562a683fbbe78f566e4d4",
    },
    gasPriceOracle: OP_STACK_ORACLE,
  }),
  "pol-usdc-wpol-univ3-max1": pins({
    set: "veined-swap-lane-pins.137.2026-11-15.1",
    route: "pol-usdc-wpol-univ3-max1",
    pay: {
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
    receive: {
      address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      codehash:
        "0xae820ea59b005f58a45eea35b374afbd5dc503d4f219a6b670cd3453f1142ed5",
    },
    router: {
      address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      codehash:
        "0x04cdae9f4e3eea720a4d0ea57b46c20ae0c7f40ee77182f32dc63ddc0dfbba5b",
    },
    quoter: {
      address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      codehash:
        "0x67d7cce806743d638e191025ab4233f44e99469f1bcda4c2b4b964b8af9099d9",
    },
    factory: {
      address: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      codehash:
        "0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69",
    },
    // WPOL/USDC 0.05 % pool (token0 = WPOL, token1 = USDC).
    pool: {
      address: "0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB",
      codehash:
        "0x01852aa83592c7f15c79f75d316e5af8ac007bb693136bae1068e1160992dd8a",
    },
    gasPriceOracle: null,
  }),
  "bnb-usdc-wbnb-univ3-max1": pins({
    set: "veined-swap-lane-pins.56.2026-11-15.1",
    route: "bnb-usdc-wbnb-univ3-max1",
    pay: {
      address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      codehash:
        "0x56069ff2fd59ae482f7984aa894b6d3bc84cb910354dcda9cd6c828d61526914",
      // Binance-Peg USDC: an EIP-1967 proxy (not Circle's FiatTokenProxy).
      implementation: {
        slot: EIP1967_SLOT,
        address: "0xBA5Fe23f8a3a24BEd3236F05F2FcF35fd0BF0B5C",
        codehash:
          "0xd2d7cf7504e1cb572af28476d45907fc30bee1297917bed153e6fbba125821a3",
      },
    },
    receive: {
      address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      codehash:
        "0xb7d84205eaaf83ce7b3940c6beaad6d22790255e34a9a2b486aa8cdfff118fe6",
    },
    router: {
      address: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
      codehash:
        "0xb5d42e79aedc88b789afbba7720e705afc985a56083c52f1ac66d094f31ef76b",
    },
    quoter: {
      address: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
      codehash:
        "0xb6652d71ca265e7b2b5f066661fec38c8c22eb9a9c17b8a5c0fae62ec401bc55",
    },
    factory: {
      address: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
      codehash:
        "0x34b1009d0f004e58da791225992645e2df7697ac71ac89dc5e80469c4ef7e322",
    },
    // USDC/WBNB 0.01 % pool (token0 = USDC, token1 = WBNB).
    pool: {
      address: "0x4141325bAc36aFFe9Db165e854982230a14e6d48",
      codehash:
        "0x62f53d9a50eae0140d6d3724e022a1abff21be88269b6f4065b10ccf15a05238",
    },
    gasPriceOracle: null,
  }),
  "avax-usdc-wavax-univ3-max1": pins({
    set: "veined-swap-lane-pins.43114.2026-11-15.1",
    route: "avax-usdc-wavax-univ3-max1",
    pay: {
      address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      codehash:
        "0x7140a935aa3bb55d334d6d325fea277e47674770b10823feefa6f8b2c58af5fc",
      implementation: {
        slot: ZOS_SLOT,
        address: "0x30DFE0469803BcE76F8F62aC24b18d33D3d6FfE6",
        codehash:
          "0x4ff47fa5d29bc7c2d76a746ea8b176d9509b49dd16d974a186d94af41ecf6d62",
      },
    },
    receive: {
      address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
      codehash:
        "0xbe0979d9ff9e744b48d32e81fd67db0d32dfc74120989df9b7b1588e2aff8597",
    },
    router: {
      address: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE",
      codehash:
        "0xdb7c09d1148af8ddb943f20bce08232d25b74c65cadbc1b1f13241a56466632b",
    },
    quoter: {
      address: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F",
      codehash:
        "0x1f9854d01a71035d67f55303f7c1adfb01c3248ae648340ef3728a5003f6e0e9",
    },
    factory: {
      address: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD",
      codehash:
        "0x47f23c387372ca89572f5e56d447fa7c8b15d0657bc4637e2aa1473b522a38f9",
    },
    // WAVAX/USDC 0.05 % pool (token0 = WAVAX, token1 = USDC).
    pool: {
      address: "0xfAe3f424a0a47706811521E3ee268f00cFb5c45E",
      codehash:
        "0x5f749fa34b67231847e5343ec7f72968e26ca17198cc0876b785292067902932",
    },
    gasPriceOracle: null,
  }),
});
/** The pin set of a route id (own entries only), or null. */
export function pinsOf(routeId: unknown): Readonly<LaneRoutePins> | null {
  return typeof routeId === "string" &&
    Object.prototype.hasOwnProperty.call(SWAP_LANE_ROUTE_PINS, routeId)
    ? SWAP_LANE_ROUTE_PINS[routeId]
    : null;
}
/** The contracts whose code a review re-reads, in a fixed order. */
export const pinnedContracts = (p: Readonly<LaneRoutePins>) =>
  [p.pay, p.receive, p.router, p.quoter, p.factory, p.pool] as const;
/** Every contract a lane read on this route may name (nothing else, no caller-chosen contract), lower case. */
export function laneReadContracts(routeId: unknown): readonly string[] {
  const p = pinsOf(routeId);
  if (!p) return Object.freeze([]);
  return Object.freeze(
    [
      ...pinnedContracts(p).map((c) => c.address),
      ...(p.gasPriceOracle ? [p.gasPriceOracle] : []),
      ...(routeById(routeId)?.feeModel === "ARBITRUM"
        ? [ARBITRUM_NODE_INTERFACE]
        : []),
    ].map((a) => a.toLowerCase()),
  );
}
/** Why a route's pin set does not match the route table ([] = it does). The engine refuses a review on any of them. */
export function routePinProblems(routeId: unknown): string[] {
  const r = routeById(routeId),
    p = pinsOf(routeId);
  if (!r || !p) return ["PIN_SET_MISSING"];
  const out: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (p.route !== r.id) out.push("PIN_SET_ROUTE");
  for (const [k, pin, want] of [
    ["pay", p.pay, r.pay.address],
    ["receive", p.receive, r.receive.address],
    ["router", p.router, r.router],
    ["quoter", p.quoter, r.quoter],
    ["factory", p.factory, r.factory],
    ["pool", p.pool, r.pool],
  ] as const) {
    if (!same(pin.address, want)) out.push(`PIN_ADDRESS:${k}`);
    if (pin.codehash !== null && !/^0x[0-9a-f]{64}$/.test(pin.codehash))
      out.push(`PIN_HASH_MALFORMED:${k}`);
  }
  if ((r.feeModel === "OP_STACK") !== (p.gasPriceOracle !== null))
    out.push("PIN_ORACLE");
  return out;
}
/** Every route has exactly one pin set (a unit test keeps the two tables equal). */
export const SWAP_LANE_PIN_ROUTES: readonly string[] = Object.freeze(
  Object.keys(SWAP_LANE_ROUTES).filter((id) => pinsOf(id) !== null),
);
