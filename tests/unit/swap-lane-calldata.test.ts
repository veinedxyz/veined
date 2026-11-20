// VEINED-FIN-LIVE-20261115-01 (SWAP-LIVE-01): the swap lane's two transactions and their INDEPENDENT exact decoder
// (src/swap/lane/calldata.ts). Expected bytes are built by hand here (not with the module's own encoder), so an
// encoder change cannot silently move the decoder with it. Every adversarial calldata must be refused with a reason.
// SYNTHETIC_TEST_ONLY: the owner 0x3333…3333 and every amount are synthetic; nothing here signs or reaches a network.
import { describe, expect, it } from "vitest";
import { encodeFunctionData, maxUint256, parseAbi, type Hex } from "viem";
import {
  LANE_QUOTER_ABI,
  LANE_ROUTER_ABI,
  approveCalldata,
  approveProblem,
  decodeApprove,
  decodeSwap,
  minimumOutFor,
  quoteCalldata,
  swapCalldata,
  swapProblem,
} from "../../src/swap/lane/calldata";
import { SWAP_LANE_ROUTE_PINS } from "../../src/swap/lane/pins";
import { SWAP_LANE_ROUTES, SWAP_LANE_SCOPE } from "../../src/swap/lane/scope";

/** The reviewed Base route: this file's fixture; its bytes are unchanged (every other route: swap-lane-routes.test.ts). */
const BASE = "base-usdc-weth-univ3-max1";
const BASE_ROUTE = SWAP_LANE_ROUTES[BASE];
const BASE_PINS = SWAP_LANE_ROUTE_PINS[BASE];
const OWNER = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";
const USDC = BASE_PINS.pay.address;
const WETH = BASE_PINS.receive.address;
const ROUTER = BASE_PINS.router.address;
const NOW_SEC = 1_794_830_400; // 2026-11-15T12:00:00Z
const AMOUNT = 1_000_000n;
const MIN_OUT = 330_000_000_000_000n;
const DEADLINE = BigInt(NOW_SEC + SWAP_LANE_SCOPE.deadlineSec);
const WANT = { owner: OWNER, amountIn: AMOUNT, amountOutMinimum: MIN_OUT };

/** One 32-byte ABI word (no 0x) of an unsigned value or an address. */
const w = (x: bigint | number | string) =>
  typeof x === "string"
    ? x.toLowerCase().replace(/^0x/, "").padStart(64, "0")
    : BigInt(x).toString(16).padStart(64, "0");
/** exactInputSingle((tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96)), by hand. */
const innerHex = (
  p: Partial<{
    tokenIn: string;
    tokenOut: string;
    fee: number;
    recipient: string;
    amountIn: bigint;
    amountOutMinimum: bigint;
    sqrtPriceLimitX96: bigint;
  }> = {},
) =>
  "04e45aaf" +
  w(p.tokenIn ?? USDC) +
  w(p.tokenOut ?? WETH) +
  w(p.fee ?? 500) +
  w(p.recipient ?? OWNER) +
  w(p.amountIn ?? AMOUNT) +
  w(p.amountOutMinimum ?? MIN_OUT) +
  w(p.sqrtPriceLimitX96 ?? 0n);
/** multicall(uint256 deadline, bytes[] data), canonical layout, by hand. */
const multicallHex = (deadline: bigint, inners: string[]) => {
  const padded = inners.map((h) => {
    const len = h.length / 2;
    return { len, body: h.padEnd(Math.ceil(len / 32) * 64, "0") };
  });
  let offsets = "";
  let tails = "";
  let at = 32 * inners.length;
  for (const p of padded) {
    offsets += w(at);
    tails += w(p.len) + p.body;
    at += 32 + p.body.length / 2;
  }
  return ("0x5ae401dc" +
    w(deadline) +
    w(0x40) +
    w(inners.length) +
    offsets +
    tails) as Hex;
};
const swapHex = (
  p: Parameters<typeof innerHex>[0] = {},
  deadline: bigint = DEADLINE,
) => multicallHex(deadline, [innerHex(p)]);
const approveHex = (spender: string, amount: bigint) =>
  ("0x095ea7b3" + w(spender) + w(amount)) as Hex;

describe("build / decode round trips", () => {
  it("approveCalldata is exactly approve(router, amount) and decodes back", () => {
    for (const amount of [100_000n, 123_456n, AMOUNT]) {
      const data = approveCalldata(BASE_ROUTE, amount);
      expect(data).toBe(approveHex(ROUTER, amount));
      expect(decodeApprove(data)).toEqual({
        spender: ROUTER.toLowerCase(),
        amount,
      });
      expect(approveProblem(BASE_ROUTE, data, amount)).toBeNull();
    }
  });
  it("swapCalldata is exactly multicall(deadline, [exactInputSingle(...)]) and decodes back", () => {
    const data = swapCalldata(BASE_ROUTE, {
      owner: OWNER,
      amountIn: AMOUNT,
      amountOutMinimum: MIN_OUT,
      deadline: DEADLINE,
    });
    expect(data).toBe(swapHex());
    expect(decodeSwap(data)).toEqual({
      deadline: DEADLINE,
      tokenIn: USDC.toLowerCase(),
      tokenOut: WETH.toLowerCase(),
      fee: 500,
      recipient: OWNER,
      amountIn: AMOUNT,
      amountOutMinimum: MIN_OUT,
      sqrtPriceLimitX96: 0n,
    });
    expect(swapProblem(BASE_ROUTE, data, WANT, NOW_SEC)).toBeNull();
  });
  it("the hand-built swap equals the module's own ABI encoding (the reference bytes are right)", () => {
    const viaAbi = encodeFunctionData({
      abi: LANE_ROUTER_ABI,
      functionName: "multicall",
      args: [
        DEADLINE,
        [
          encodeFunctionData({
            abi: LANE_ROUTER_ABI,
            functionName: "exactInputSingle",
            args: [
              {
                tokenIn: USDC as Hex,
                tokenOut: WETH as Hex,
                fee: 500,
                recipient: OWNER as Hex,
                amountIn: AMOUNT,
                amountOutMinimum: MIN_OUT,
                sqrtPriceLimitX96: 0n,
              },
            ],
          }),
        ],
      ],
    });
    expect(viaAbi).toBe(swapHex());
  });
  it("the owner comparison is case-insensitive (checksummed record account), and only for the owner", () => {
    const mixed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const data = swapHex({ recipient: mixed });
    expect(
      swapProblem(BASE_ROUTE, data, { ...WANT, owner: mixed }, NOW_SEC),
    ).toBeNull();
    expect(
      swapProblem(
        BASE_ROUTE,
        data,
        { ...WANT, owner: mixed.toLowerCase() },
        NOW_SEC,
      ),
    ).toBeNull();
    expect(decodeSwap(data)?.recipient).toBe(mixed.toLowerCase());
    expect(swapProblem(BASE_ROUTE, data, WANT, NOW_SEC)).toBe(
      "SWAP_RECIPIENT_NOT_OWNER",
    );
  });
  it("quoteCalldata asks QuoterV2 for exactly USDC -> WETH, 0.05 %, no price limit", () => {
    const data = quoteCalldata(BASE_ROUTE, AMOUNT);
    expect(data).toBe(
      "0xc6a5026a" + w(USDC) + w(WETH) + w(AMOUNT) + w(500) + w(0),
    );
    expect(LANE_QUOTER_ABI[0].name).toBe("quoteExactInputSingle");
  });
});

describe("swap refusals", () => {
  const refuse = (data: unknown, code: string, now = NOW_SEC, want = WANT) =>
    expect(swapProblem(BASE_ROUTE, data, want, now)).toBe(code);
  it("planted trailing bytes (a whole word, a half word, one byte) are not canonical", () => {
    refuse(swapHex() + w(0), "SWAP_CALLDATA_NOT_CANONICAL");
    refuse(swapHex() + w(OTHER), "SWAP_CALLDATA_NOT_CANONICAL");
    refuse(swapHex() + "00".repeat(16), "SWAP_CALLDATA_NOT_CANONICAL");
    refuse(swapHex() + "ab", "SWAP_CALLDATA_NOT_CANONICAL");
    expect(decodeSwap(swapHex() + w(0))).toBeNull();
  });
  it("an extra call planted inside the inner bytes is not canonical", () => {
    const planted = innerHex() + approveHex(OTHER, maxUint256).slice(2);
    refuse(multicallHex(DEADLINE, [planted]), "SWAP_CALLDATA_NOT_CANONICAL");
    refuse(
      multicallHex(DEADLINE, [innerHex() + w(0)]),
      "SWAP_CALLDATA_NOT_CANONICAL",
    );
  });
  it("two calls in the multicall are refused (even two identical, exact swaps)", () => {
    refuse(
      multicallHex(DEADLINE, [innerHex(), innerHex()]),
      "SWAP_CALLDATA_NOT_CANONICAL",
    );
    refuse(
      multicallHex(DEADLINE, [
        innerHex(),
        approveHex(OTHER, maxUint256).slice(2),
      ]),
      "SWAP_CALLDATA_NOT_CANONICAL",
    );
    refuse(multicallHex(DEADLINE, []), "SWAP_CALLDATA_NOT_CANONICAL");
  });
  it("a wrong inner selector is refused (exactInput, exactOutputSingle, a re-labelled exactInputSingle)", () => {
    const other = parseAbi([
      "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
      "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
      "function sweepToken(address token, uint256 amountMinimum, address recipient) payable",
    ]);
    const outSingle = encodeFunctionData({
      abi: other,
      functionName: "exactOutputSingle",
      args: [
        {
          tokenIn: USDC as Hex,
          tokenOut: WETH as Hex,
          fee: 500,
          recipient: OWNER as Hex,
          amountOut: MIN_OUT,
          amountInMaximum: AMOUNT,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const multi = encodeFunctionData({
      abi: other,
      functionName: "exactInput",
      args: [
        {
          path: ("0x" + USDC.slice(2) + "0001f4" + WETH.slice(2)) as Hex,
          recipient: OWNER as Hex,
          amountIn: AMOUNT,
          amountOutMinimum: MIN_OUT,
        },
      ],
    });
    const sweep = encodeFunctionData({
      abi: other,
      functionName: "sweepToken",
      args: [USDC as Hex, 0n, OTHER as Hex],
    });
    for (const inner of [outSingle, multi, sweep])
      refuse(
        multicallHex(DEADLINE, [inner.slice(2)]),
        "SWAP_CALLDATA_NOT_CANONICAL",
      );
    refuse(
      multicallHex(DEADLINE, ["414bf389" + innerHex().slice(8)]),
      "SWAP_CALLDATA_NOT_CANONICAL",
    );
  });
  it("other outer shapes are refused: bare exactInputSingle, multicall(bytes[]), multicall(bytes32,bytes[]), non-strings", () => {
    refuse("0x" + innerHex(), "SWAP_CALLDATA_NOT_CANONICAL");
    refuse(
      "0xac9650d8" + swapHex().slice(10 + 64),
      "SWAP_CALLDATA_NOT_CANONICAL",
    );
    refuse("0x1f0464d1" + swapHex().slice(10), "SWAP_CALLDATA_NOT_CANONICAL");
    for (const bad of [
      null,
      undefined,
      42,
      {},
      "",
      "0x",
      "0x5ae401dc",
      swapHex().slice(0, -2),
    ])
      refuse(bad, "SWAP_CALLDATA_NOT_CANONICAL");
  });
  it("a relocated (non-canonical) offset decodes to the same values but is refused", () => {
    // multicall(deadline, bytes[]) with the array placed one word later (a gap word planted before it).
    const canonical = swapHex().slice(10);
    const tail = canonical.slice(128);
    const relocated = "0x5ae401dc" + w(DEADLINE) + w(0x60) + w(0) + tail;
    refuse(relocated, "SWAP_CALLDATA_NOT_CANONICAL");
    // the same with the inner element's offset relocated
    const arr = tail.slice(64 * 2); // after length + offset words
    const inner = "0x5ae401dc" + w(DEADLINE) + w(0x40) + w(1) + w(0x40) + w(0);
    refuse(inner + arr, "SWAP_CALLDATA_NOT_CANONICAL");
  });
  it("wrong tokenIn / tokenOut / fee tier", () => {
    refuse(swapHex({ tokenIn: WETH }), "SWAP_TOKEN_IN");
    refuse(swapHex({ tokenIn: OTHER }), "SWAP_TOKEN_IN");
    refuse(swapHex({ tokenOut: USDC }), "SWAP_TOKEN_OUT");
    refuse(swapHex({ tokenOut: OTHER }), "SWAP_TOKEN_OUT");
    refuse(swapHex({ tokenIn: WETH, tokenOut: USDC }), "SWAP_TOKEN_IN");
    for (const fee of [0, 100, 3000, 10_000, 501])
      refuse(swapHex({ fee }), "SWAP_FEE_TIER");
  });
  it("a recipient other than the owner (another account, the router, the pool, zero)", () => {
    for (const recipient of [
      OTHER,
      ROUTER,
      BASE_PINS.pool.address,
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000002",
    ])
      refuse(swapHex({ recipient }), "SWAP_RECIPIENT_NOT_OWNER");
  });
  it("amountIn other than the record's exact amount", () => {
    for (const amountIn of [AMOUNT - 1n, AMOUNT + 1n, 0n, maxUint256])
      refuse(swapHex({ amountIn }), "SWAP_AMOUNT_NOT_EXACT");
  });
  it("amountOutMinimum other than the reviewed minimum (lower, higher, zero)", () => {
    for (const amountOutMinimum of [MIN_OUT - 1n, MIN_OUT + 1n, 0n, 1n])
      refuse(swapHex({ amountOutMinimum }), "SWAP_MIN_OUT_NOT_REVIEWED");
    // a zero minimum is refused even when the "reviewed" minimum is zero too
    refuse(swapHex({ amountOutMinimum: 0n }), "SWAP_MIN_OUT_ZERO", NOW_SEC, {
      ...WANT,
      amountOutMinimum: 0n,
    });
  });
  it("a price limit (sqrtPriceLimitX96 != 0)", () => {
    for (const sqrtPriceLimitX96 of [1n, 4295128740n, (1n << 160n) - 1n])
      refuse(swapHex({ sqrtPriceLimitX96 }), "SWAP_PRICE_LIMIT_SET");
  });
  it("deadline passed / at now / too far (boundary: now + window + 30 s is the last accepted)", () => {
    refuse(swapHex({}, BigInt(NOW_SEC)), "SWAP_DEADLINE_PASSED");
    refuse(swapHex({}, BigInt(NOW_SEC - 1)), "SWAP_DEADLINE_PASSED");
    refuse(swapHex({}, 0n), "SWAP_DEADLINE_PASSED");
    expect(
      swapProblem(BASE_ROUTE, swapHex({}, BigInt(NOW_SEC + 1)), WANT, NOW_SEC),
    ).toBe(null);
    const last = BigInt(NOW_SEC + SWAP_LANE_SCOPE.deadlineSec + 30);
    expect(
      swapProblem(BASE_ROUTE, swapHex({}, last), WANT, NOW_SEC),
    ).toBeNull();
    refuse(swapHex({}, last + 1n), "SWAP_DEADLINE_TOO_FAR");
    refuse(swapHex({}, maxUint256), "SWAP_DEADLINE_TOO_FAR");
    // the same calldata becomes refused once the clock passes its deadline
    refuse(swapHex(), "SWAP_DEADLINE_PASSED", Number(DEADLINE));
  });
});

describe("approve refusals", () => {
  it("a wrong spender (another account, the pool, Permit2, zero)", () => {
    for (const spender of [
      OTHER,
      BASE_PINS.pool.address,
      BASE_PINS.quoter.address,
      "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      "0x0000000000000000000000000000000000000000",
    ])
      expect(
        approveProblem(BASE_ROUTE, approveHex(spender, AMOUNT), AMOUNT),
      ).toBe("APPROVE_SPENDER_NOT_ROUTER");
  });
  it("an unlimited or any non-exact amount", () => {
    for (const amount of [
      maxUint256,
      maxUint256 - 1n,
      AMOUNT + 1n,
      AMOUNT - 1n,
      0n,
    ])
      expect(
        approveProblem(BASE_ROUTE, approveHex(ROUTER, amount), AMOUNT),
      ).toBe("APPROVE_NOT_EXACT_AMOUNT");
    expect(
      approveProblem(
        BASE_ROUTE,
        approveCalldata(BASE_ROUTE, AMOUNT),
        AMOUNT - 1n,
      ),
    ).toBe("APPROVE_NOT_EXACT_AMOUNT");
  });
  it("non-canonical approve bytes (trailing, truncated, dirty address bits, other selectors, non-strings)", () => {
    const ok = approveHex(ROUTER, AMOUNT);
    const dirty =
      "0x095ea7b3" +
      "ff".repeat(12) +
      ROUTER.slice(2).toLowerCase() +
      w(AMOUNT);
    const other = parseAbi([
      "function transfer(address to, uint256 amount) returns (bool)",
      "function increaseAllowance(address spender, uint256 addedValue) returns (bool)",
      "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
    ]);
    const bad: unknown[] = [
      ok + w(0),
      ok + "00",
      ok.slice(0, -64),
      ok.slice(0, -2),
      dirty,
      encodeFunctionData({
        abi: other,
        functionName: "transfer",
        args: [ROUTER as Hex, AMOUNT],
      }),
      encodeFunctionData({
        abi: other,
        functionName: "increaseAllowance",
        args: [ROUTER as Hex, AMOUNT],
      }),
      encodeFunctionData({
        abi: other,
        functionName: "permit",
        args: [
          OWNER as Hex,
          ROUTER as Hex,
          AMOUNT,
          maxUint256,
          27,
          ("0x" + "11".repeat(32)) as Hex,
          ("0x" + "22".repeat(32)) as Hex,
        ],
      }),
      swapHex(),
      null,
      undefined,
      AMOUNT,
      "",
      "0x095ea7b3",
    ];
    for (const data of bad) {
      expect(approveProblem(BASE_ROUTE, data, AMOUNT)).toBe(
        "APPROVE_CALLDATA_NOT_CANONICAL",
      );
      expect(decodeApprove(data)).toBeNull();
    }
  });
});

describe("minimumOutFor rounds up (never in the pool's favour)", () => {
  it("exact and fractional cases", () => {
    expect(minimumOutFor(10_000n, 30)).toBe(9_970n);
    expect(minimumOutFor(12_345n, 30)).toBe(12_308n); // 12_307.965 -> 12_308
    expect(minimumOutFor(1n, 30)).toBe(1n); // 0.997 -> 1
    expect(minimumOutFor(1n, 50)).toBe(1n);
    expect(minimumOutFor(0n, 30)).toBe(0n);
    expect(minimumOutFor(333_000_000_000_001n, 30)).toBe(
      332_001_000_000_001n, // 332_001_000_000_000.997 -> ...001
    );
    expect(minimumOutFor(20_000n, 0)).toBe(20_000n);
  });
  it("is the smallest value >= quote * (1 - slippage) for many quotes and every lane slippage", () => {
    let q = 7n;
    for (let i = 0; i < 400; i++) {
      q =
        (q * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) %
        10n ** 24n;
      for (const s of [1, 29, 30, 50]) {
        const m = minimumOutFor(q, s);
        const exact = q * BigInt(10_000 - s);
        expect(m * 10_000n >= exact).toBe(true);
        expect((m - 1n) * 10_000n < exact).toBe(true);
      }
    }
  });
});
