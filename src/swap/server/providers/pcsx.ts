import {
  parseOrder,
  parseRouterOrder,
  OrderType,
} from "../../../../swap-providers/runtime";
import { z } from "zod";
import { recoverEvmAddress } from "../../../../swap-providers/uniswapx-runtime";
import {
  canonical,
  identity,
  SwapError,
  ZERO,
  type SwapIntent,
} from "../../model";
import { makeQuote, type QuoteAdapter } from "../provider";
import { jsonRead } from "../transport";
import { digest } from "../digest";
const orderSchema = z.object({
  type: z.literal("DUTCH_LIMIT"),
  order: z.object({
    encodedOrder: z
      .string()
      .regex(/^0x[0-9a-f]+$/i)
      .max(32000),
    permitData: z.unknown(),
    orderType: z.enum(OrderType).optional(),
    rfqVersion: z.enum(["v1", "v3", "v4"]).optional(),
  }),
});
export function decodePcsx(
  encoded: string,
  i: SwapIntent,
  routerType?: OrderType,
) {
  try {
    if (encoded.length > 32000 || i.kind !== "EXACT_IN" || i.tokenIn.native)
      throw new SwapError("REVIEW_REQUIRED");
    const parsed = (() => {
      try {
        const p = parseOrder(encoded as `0x${string}`, Number(i.chain));
        if (routerType && p.orderType !== routerType)
          throw new SwapError("REVIEW_REQUIRED");
        return p;
      } catch {
        if (!routerType) throw new SwapError("REVIEW_REQUIRED");
        return parseRouterOrder(
          encoded as `0x${string}`,
          Number(i.chain),
          routerType,
        );
      }
    })();
    const info = parsed.order.info;
    if (
      parsed.order.encode().toLowerCase() !== encoded.toLowerCase() ||
      identity(info.swapper) !== identity(i.taker) ||
      info.deadline <= BigInt(Math.floor(Date.now() / 1000)) ||
      info.deadline > BigInt(Number.MAX_SAFE_INTEGER) ||
      identity(info.additionalValidationContract) !== ZERO ||
      info.additionalValidationData !== "0x"
    )
      throw new SwapError("REVIEW_REQUIRED");
    if (parsed.orderType !== OrderType.ExclusiveDutchOrder) {
      const order = parsed.order,
        p = order.info,
        c = order.cosignerData,
        input = p.baseInput,
        outputs = p.baseOutputs,
        bits = parsed.orderType === OrderType.ExclusiveDutchOrderV4 ? 32n : 16n;
      const curve = (v: typeof input | (typeof outputs)[number]) => {
        const { relativeAmounts: amounts, relativeBlocks: packed } = v.curve;
        if (
          amounts.length > Number(256n / bits) ||
          packed < 0n ||
          packed >> (BigInt(amounts.length) * bits)
        )
          throw new SwapError("REVIEW_REQUIRED");
        let previous = 0n;
        return amounts.map((delta, index) => {
          const block =
            (packed >> (BigInt(index) * bits)) & ((1n << bits) - 1n);
          if (block <= previous || delta < -(1n << 255n) || delta >= 1n << 255n)
            throw new SwapError("REVIEW_REQUIRED");
          previous = block;
          const amount = v.startAmount - delta;
          if (amount < 0n || amount >= 1n << 256n)
            throw new SwapError("REVIEW_REQUIRED");
          return { block, amount };
        });
      };
      if (
        identity(input.token) !== identity(i.tokenIn.address) ||
        input.startAmount !== i.amount ||
        input.maxAmount !== i.amount ||
        outputs.length !== 1 ||
        identity(outputs[0].token) !== identity(i.tokenOut.address) ||
        identity(outputs[0].recipient) !== identity(i.recipient) ||
        outputs[0].minAmount <= 0n ||
        outputs[0].minAmount > outputs[0].startAmount ||
        outputs[0].minAmount <
          (outputs[0].startAmount * BigInt(10000 - i.slippage.bps)) / 10000n ||
        c.outputAmounts.length !== outputs.length ||
        c.inputAmount > input.startAmount ||
        c.exclusivityOverrideBps > 10000n ||
        c.exclusivityOverrideBps < 0n ||
        identity(p.cosigner) === ZERO
      )
        throw new SwapError("REVIEW_REQUIRED");
      if (
        c.outputAmounts.some(
          (amount, index) =>
            amount !== 0n && amount < outputs[index].startAmount,
        ) ||
        !(
          order.cosignature === "0x" ||
          /^0x[0-9a-f]{130}$/i.test(order.cosignature)
        )
      )
        throw new SwapError("REVIEW_REQUIRED");
      // Domain/permit fields are produced by the version-specific SDK from the canonical bytes, never API display data.
      if (
        order.cosignature !== "0x" &&
        identity(
          recoverEvmAddress(order.cosignerDigest(c), order.cosignature),
        ) !== identity(p.cosigner)
      )
        throw new SwapError("REVIEW_REQUIRED");
      const permit = order.permitData(),
        resolvedInput = order.resolvedInput(),
        resolvedOutputs = order.resolvedOutputs();
      return {
        encodedOrder: encoded,
        orderType: parsed.orderType,
        reactor: p.reactor,
        input: {
          ...input,
          startAmount: resolvedInput.startAmount,
          endAmount: input.maxAmount,
        },
        output: {
          ...outputs[0],
          startAmount: resolvedOutputs[0].startAmount,
          endAmount: outputs[0].minAmount,
        },
        deadline: Number(p.deadline),
        nonce: p.nonce,
        chain: i.chain,
        auction: {
          start: c.decayStartBlock,
          end: null,
          filler: c.exclusiveFiller,
          overrideBps: c.exclusivityOverrideBps,
          inputCurve: curve(input),
          outputCurves: outputs.map(curve),
          startingBaseFee: p.startingBaseFee,
          inputGasAdjustment: input.adjustmentPerGweiBaseFee,
          outputGasAdjustments: outputs.map((v) => v.adjustmentPerGweiBaseFee),
        },
        cosigner: p.cosigner,
        cosignerData: c,
        cosignerDigest: order.cosignerDigest(c),
        cosignature: order.cosignature,
        signatureValidity: "NOT_ASSERTED" as const,
        permit,
        signable: false as const,
      };
    }
    const order = parsed.order,
      p = order.info;
    if (
      order.encode().toLowerCase() !== encoded.toLowerCase() ||
      identity(p.swapper) !== identity(i.taker) ||
      identity(p.input.token) !== identity(i.tokenIn.address) ||
      p.input.startAmount !== i.amount ||
      p.input.endAmount !== i.amount ||
      p.outputs.length !== 1 ||
      identity(p.outputs[0].token) !== identity(i.tokenOut.address) ||
      identity(p.outputs[0].recipient) !== identity(i.recipient) ||
      p.outputs[0].endAmount <= 0n ||
      p.outputs[0].endAmount > p.outputs[0].startAmount ||
      p.outputs[0].endAmount <
        (p.outputs[0].startAmount * BigInt(10000 - i.slippage.bps)) / 10000n ||
      p.decayEndTime < p.decayStartTime ||
      p.deadline < p.decayEndTime ||
      Number(p.deadline) * 1000 <= Date.now() ||
      identity(p.additionalValidationContract) !== ZERO ||
      p.additionalValidationData !== "0x"
    )
      throw new SwapError("REVIEW_REQUIRED");
    return {
      encodedOrder: encoded,
      orderType: parsed.orderType,
      reactor: p.reactor,
      input: p.input,
      output: p.outputs[0],
      deadline: Number(p.deadline),
      nonce: p.nonce,
      chain: i.chain,
      auction: {
        start: p.decayStartTime,
        end: p.decayEndTime,
        filler: p.exclusiveFiller,
        overrideBps: p.exclusivityOverrideBps,
      },
      permit: order.permitData(),
      signable: false as const,
    };
  } catch (e) {
    if (e instanceof SwapError) throw e;
    throw new SwapError("REVIEW_REQUIRED");
  }
}
export function pcsx(enabled: boolean, key = ""): QuoteAdapter {
  return {
    mode: "PANCAKESWAP_X_INTENT",
    provider: "PancakeSwap X",
    chains: ["1", "56"],
    exactOut: false,
    async quote(i, signal) {
      if (!enabled) throw new SwapError("CREDENTIAL_REQUIRED");
      const raw = await jsonRead(
        "https://x.pancakeswap.com/order-price/get-price",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key ? { "X-API-Key": key } : {}),
          },
          body: JSON.stringify({
            tokenInChainId: Number(i.chain),
            tokenOutChainId: Number(i.chain),
            tokenIn: i.tokenIn.address,
            tokenOut: i.tokenOut.address,
            amount: i.amount.toString(),
            type: "EXACT_INPUT",
            slippageTolerance: String(i.slippage.bps / 100),
            configs: [
              {
                routingType: "DUTCH_LIMIT",
                swapper: i.taker,
                recipient: i.recipient,
              },
            ],
          }),
        },
        signal,
      );
      const schema = z.object({
        messageType: z.literal("PRICE_RESPONSE"),
        message: z.object({ bestOrder: orderSchema }),
      });
      const r = schema.safeParse(raw);
      if (!r.success) throw new SwapError("INVALID_SCHEMA");
      const order = r.data.message.bestOrder.order;
      // The current API names its explicit wire-version discriminator rfqVersion.
      // A MultiReactor address alone cannot distinguish the V3 and V4 layouts.
      const versionType = order.rfqVersion
        ? {
            v1: OrderType.ExclusiveDutchOrder,
            v3: OrderType.ExclusiveDutchOrderV3,
            v4: OrderType.ExclusiveDutchOrderV4,
          }[order.rfqVersion]
        : undefined;
      if (order.orderType && versionType && order.orderType !== versionType)
        throw new SwapError("REVIEW_REQUIRED");
      const d = decodePcsx(
        order.encodedOrder,
        i,
        versionType ?? order.orderType,
      );
      if (canonical(order.permitData) !== canonical(d.permit))
        throw new SwapError("REVIEW_REQUIRED");
      const q = makeQuote(
        i,
        "PancakeSwap X",
        "PANCAKESWAP_X_INTENT",
        i.amount,
        d.output.startAmount,
        [
          {
            venue: "PancakeSwap X",
            poolType: "INTENT",
            pool: d.reactor,
            tokenIn: i.tokenIn.address,
            tokenOut: i.tokenOut.address,
            shareBps: 10000,
          },
        ],
        {
          minAmountOut: d.output.endAmount,
          expiresAt: Math.min(
            i.expiresAt,
            Date.now() + 20000,
            d.deadline * 1000,
          ),
        },
      );
      q.id = digest({ q, encodedOrder: d.encodedOrder, permit: d.permit });
      return [q];
    },
  };
}
