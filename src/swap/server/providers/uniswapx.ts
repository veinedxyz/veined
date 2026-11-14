import {
  CosignedV2DutchOrder,
  CosignedV3DutchOrder,
  CosignedPriorityOrder,
  UNISWAPX_REACTORS,
  UniswapXOrderType,
} from "../../../../swap-providers/uniswapx-runtime";
import { z } from "zod";
import {
  canonical,
  identity,
  SwapError,
  ZERO,
  type SwapIntent,
} from "../../model";
import { PERMIT2 } from "../config";
import { makeQuote, type QuoteAdapter } from "../provider";
import { jsonRead } from "../transport";
import { digest } from "../digest";
const supported = z.enum(["DUTCH_V2", "DUTCH_V3", "PRIORITY"]);
const n = (v: { toString(): string } | bigint) => BigInt(v.toString());
function reject(): never {
  throw new SwapError("REVIEW_REQUIRED");
}
/** Current API families only. Permissioned V4/Hybrid/Relay and unknown future types cannot enter this path. */
export function decodeUniswapX(encoded: string, type: string, i: SwapIntent) {
  try {
    const kind = supported.parse(type);
    if (
      !/^0x([0-9a-f]{2})+$/i.test(encoded) ||
      encoded.length > 32000 ||
      i.kind !== "EXACT_IN" ||
      i.tokenIn.native ||
      i.tokenOut.native
    )
      reject();
    const order =
      kind === "DUTCH_V2"
        ? CosignedV2DutchOrder.parse(encoded, Number(i.chain))
        : kind === "DUTCH_V3"
          ? CosignedV3DutchOrder.parse(encoded, Number(i.chain))
          : CosignedPriorityOrder.parse(encoded, Number(i.chain));
    const p = order.info,
      orderType =
        kind === "DUTCH_V2"
          ? UniswapXOrderType.Dutch_V2
          : kind === "DUTCH_V3"
            ? UniswapXOrderType.Dutch_V3
            : UniswapXOrderType.Priority;
    if (
      identity(UNISWAPX_REACTORS[Number(i.chain)]?.[orderType] ?? "") !==
        identity(p.reactor) ||
      identity(p.swapper) !== identity(i.taker) ||
      identity(p.input.token) !== identity(i.tokenIn.address) ||
      p.outputs.length !== 1 ||
      identity(p.outputs[0].token) !== identity(i.tokenOut.address) ||
      identity(p.outputs[0].recipient) !== identity(i.recipient) ||
      p.additionalValidationData !== "0x" ||
      identity(p.additionalValidationContract) !== ZERO ||
      !Number.isSafeInteger(p.deadline) ||
      p.deadline * 1000 <= Date.now() ||
      identity(order.permit2Address) !== identity(PERMIT2.Uniswap) ||
      identity(p.cosigner) === ZERO ||
      order.serialize().toLowerCase() !== encoded.toLowerCase()
    )
      reject();
    if (
      order.info.cosignature !== "0x" &&
      identity(order.recoverCosigner()) !== identity(p.cosigner)
    )
      reject();
    let amountOut: bigint, minOut: bigint, maxIn: bigint;
    if (order instanceof CosignedPriorityOrder) {
      const p = order.info;
      // Exact-input priority orders must not increase the user debit. Output priority scaling only improves credit.
      if (
        n(p.input.mpsPerPriorityFeeWei) !== 0n ||
        n(p.outputs[0].mpsPerPriorityFeeWei) < 0n ||
        n(p.input.amount) !== i.amount ||
        n(p.cosignerData.auctionTargetBlock) < n(p.auctionStartBlock)
      )
        reject();
      amountOut = n(p.outputs[0].amount);
      minOut = amountOut;
      maxIn = n(p.input.amount);
    } else if (order instanceof CosignedV2DutchOrder) {
      const p = order.info,
        c = p.cosignerData;
      if (
        n(p.input.startAmount) !== i.amount ||
        n(p.input.endAmount) !== i.amount ||
        c.decayEndTime < c.decayStartTime ||
        c.decayEndTime > p.deadline ||
        c.outputOverrides.length !== 1 ||
        n(c.inputOverride) > i.amount ||
        (n(c.outputOverrides[0]) !== 0n &&
          n(c.outputOverrides[0]) < n(p.outputs[0].startAmount)) ||
        n(c.exclusivityOverrideBps) > 10000n
      )
        reject();
      amountOut = n(p.outputs[0].startAmount);
      minOut = n(p.outputs[0].endAmount);
      maxIn = n(p.input.endAmount);
    } else {
      const p = order.info,
        c = p.cosignerData;
      if (
        n(p.input.startAmount) !== i.amount ||
        n(p.input.maxAmount) !== i.amount ||
        c.outputOverrides.length !== 1 ||
        n(c.inputOverride) > i.amount ||
        (n(c.outputOverrides[0]) !== 0n &&
          n(c.outputOverrides[0]) < n(p.outputs[0].startAmount)) ||
        n(c.exclusivityOverrideBps) > 10000n
      )
        reject();
      for (const a of [p.input, ...p.outputs]) {
        const b = a.curve.relativeBlocks,
          amounts = a.curve.relativeAmounts;
        if (
          b.length !== amounts.length ||
          b.length > 16 ||
          b.some(
            (v, j) =>
              !Number.isSafeInteger(v) ||
              v < 1 ||
              v > 65535 ||
              (j > 0 && v <= b[j - 1]),
          ) ||
          amounts.some(
            (v) =>
              n(a.startAmount) - v < 0n || n(a.startAmount) - v >= 1n << 256n,
          )
        )
          reject();
      }
      amountOut = n(p.outputs[0].startAmount);
      minOut = n(p.outputs[0].minAmount);
      maxIn = n(p.input.maxAmount);
    }
    if (
      minOut <= 0n ||
      minOut > amountOut ||
      minOut < (amountOut * BigInt(10000 - i.slippage.bps)) / 10000n ||
      maxIn !== i.amount
    )
      reject();
    return {
      encodedOrder: encoded,
      type: kind,
      chain: i.chain,
      reactor: p.reactor,
      nonce: n(p.nonce),
      deadline: p.deadline,
      amountIn: i.amount,
      amountOut,
      minAmountOut: minOut,
      maxAmountIn: maxIn,
      recipient: p.outputs[0].recipient,
      cosigner: p.cosigner,
      cosignature: p.cosignature,
      signatureValidity:
        p.cosignature === "0x" ? "NOT_PRESENT" : "COSIGNER_VERIFIED",
      order: order.toJSON(),
      permit: order.permitData(),
      orderHash: order.hash(),
      signable: false as const,
    };
  } catch (e) {
    if (e instanceof SwapError) throw e;
    throw new SwapError("REVIEW_REQUIRED");
  }
}
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    if ("_isBigNumber" in value && "toString" in value) return String(value);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, plain(v)]),
    );
  }
  return value;
}
export function uniswapx(key: string): QuoteAdapter {
  return {
    mode: "UNISWAPX",
    provider: "Uniswap",
    chains: ["1", "8453"],
    exactOut: false,
    async quote(i, signal) {
      if (!key) throw new SwapError("CREDENTIAL_REQUIRED");
      if (i.tokenIn.native || i.tokenOut.native)
        throw new SwapError("UNSUPPORTED_TOKEN");
      const raw = await jsonRead(
        "https://trade-api.gateway.uniswap.org/v1/quote",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-api-key": key,
          },
          body: JSON.stringify({
            type: "EXACT_INPUT",
            amount: i.amount.toString(),
            tokenInChainId: Number(i.chain),
            tokenOutChainId: Number(i.chain),
            tokenIn: i.tokenIn.address,
            tokenOut: i.tokenOut.address,
            swapper: i.taker,
            recipient: i.recipient,
            slippageTolerance: i.slippage.bps / 100,
            protocols: ["UNISWAPX_V2", "UNISWAPX_V3"],
          }),
        },
        signal,
      );
      const r = z
          .object({
            routing: supported,
            quote: z.object({
              encodedOrder: z.string().max(32000),
              orderHash: z.string().optional(),
            }),
            permitData: z.unknown(),
          })
          .parse(raw),
        d = decodeUniswapX(r.quote.encodedOrder, r.routing, i);
      if (
        canonical(plain(r.permitData)) !== canonical(plain(d.permit)) ||
        (r.quote.orderHash &&
          r.quote.orderHash.toLowerCase() !== d.orderHash.toLowerCase())
      )
        reject();
      const q = makeQuote(
        i,
        "Uniswap",
        "UNISWAPX",
        d.amountIn,
        d.amountOut,
        [
          {
            venue: "UniswapX",
            poolType: "INTENT",
            pool: d.reactor,
            tokenIn: i.tokenIn.address,
            tokenOut: i.tokenOut.address,
            shareBps: 10000,
          },
        ],
        {
          minAmountOut: d.minAmountOut,
          expiresAt: Math.min(
            i.expiresAt,
            Date.now() + 20000,
            d.deadline * 1000,
          ),
        },
      );
      q.id = digest({ q, order: d });
      return [q];
    },
  };
}
