import {
  SOL,
  ZERO,
  type SwapIntent,
  type SwapQuote,
  type ProviderMode,
} from "../../src/swap/model";
import { makeQuote } from "../../src/swap/server/provider";
import { PINS, AERO } from "../../src/swap/server/config";
export const wallet = "0x3333333333333333333333333333333333333333";
export const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export function swapIntent(extra: Partial<SwapIntent> = {}): SwapIntent {
  return {
    ecosystem: "EVM",
    chain: "1",
    taker: wallet,
    recipient: wallet,
    tokenIn: {
      chain: "1",
      address: ZERO,
      native: true,
      decimals: 18,
      symbol: "ETH",
    },
    tokenOut: {
      chain: "1",
      address: usdc,
      native: false,
      decimals: 6,
      symbol: "USDC",
    },
    kind: "EXACT_IN",
    amount: 10n ** 16n,
    slippage: { mode: "AUTO", bps: 50 },
    preference: "RECOMMENDED",
    walletEpoch: 2,
    portfolioRevision: "fixture",
    expiresAt: Date.now() + 120000,
    ...extra,
  };
}
export function swapQuote(
  i = swapIntent(),
  mode: ProviderMode = "UNISWAP",
  extra: Partial<SwapQuote> = {},
): SwapQuote {
  const aero = mode.startsWith("AERODROME"),
    pin = PINS[i.chain as keyof typeof PINS];
  return makeQuote(
    i,
    aero
      ? "Aerodrome"
      : mode === "PANCAKESWAP_SMART"
        ? "PancakeSwap"
        : "Uniswap",
    mode,
    i.amount,
    30_000_000n,
    [
      {
        venue: aero
          ? "Aerodrome"
          : mode === "PANCAKESWAP_SMART"
            ? "PancakeSwap"
            : "Uniswap",
        poolType: aero ? "VOLATILE" : "V3",
        pool: wallet,
        tokenIn: i.tokenIn.native ? pin.wrapper : i.tokenIn.address,
        tokenOut: i.tokenOut.native ? pin.wrapper : i.tokenOut.address,
        shareBps: 10000,
        fee: 500,
        ...(aero ? { factory: AERO.factory } : {}),
      },
    ],
    { build: "UNSIGNED_BUILD", ...extra },
  );
}
export function solIntent(): SwapIntent {
  return swapIntent({
    chain: "solana",
    ecosystem: "SVM",
    taker: "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z",
    recipient: "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z",
    tokenIn: {
      chain: "solana",
      address: SOL,
      native: true,
      decimals: 9,
      symbol: "SOL",
    },
    tokenOut: {
      chain: "solana",
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      native: false,
      decimals: 6,
      symbol: "USDC",
    },
    amount: 10000000n,
  });
}
export function jupiterPayload(i = solIntent()) {
  return {
    inputMint: i.tokenIn.address,
    outputMint: i.tokenOut.address,
    inAmount: i.amount.toString(),
    outAmount: "1000000",
    otherAmountThreshold: "995000",
    swapMode: "ExactIn",
    slippageBps: 50,
    priceImpact: -0.1,
    priceImpactPct: "-0.001",
    routePlan: [
      {
        percent: 100,
        swapInfo: {
          ammKey: i.taker,
          label: "Fixture venue",
          inputMint: i.tokenIn.address,
          outputMint: i.tokenOut.address,
          inAmount: i.amount.toString(),
          outAmount: "1000000",
        },
      },
    ],
    feeBps: 0,
    router: "metis",
    transactionVersion: 0,
  };
}
