import { z } from "zod";
import {
  identity,
  rawUnits,
  SwapError,
  type SwapIntent,
  type SwapQuote,
} from "../model";
import { routerPin } from "./config";
import { digest } from "./digest";
export const permitSchema = z
  .object({
    quoteId: z.string(),
    intentDigest: z.string(),
    owner: z.string(),
    domain: z
      .object({
        name: z.literal("Permit2"),
        chainId: z.number().int(),
        verifyingContract: z.string(),
      })
      .strict(),
    details: z
      .object({
        token: z.string(),
        amount: rawUnits,
        expiration: z.number().int(),
        nonce: rawUnits,
      })
      .strict(),
    spender: z.string(),
    sigDeadline: z.number().int(),
  })
  .strict();
/** Internal normalized Permit2 authorization only. Never forwarded for signing. Requote always changes quoteId. */
export function validatePermit(
  raw: unknown,
  q: SwapQuote,
  i: SwapIntent,
  now = Date.now(),
) {
  const r = permitSchema.safeParse(raw);
  if (!r.success) throw new SwapError("REVIEW_REQUIRED");
  const p = r.data,
    pin = routerPin(q.mode, i.chain);
  if (
    !pin.permit2 ||
    i.tokenIn.native ||
    p.quoteId !== q.id ||
    p.intentDigest !== digest(i) ||
    p.intentDigest !== q.intentDigest ||
    identity(p.owner) !== identity(i.taker) ||
    p.domain.chainId !== Number(i.chain) ||
    identity(p.domain.verifyingContract) !== identity(pin.permit2) ||
    identity(p.spender) !== identity(pin.address) ||
    identity(p.details.token) !== identity(i.tokenIn.address) ||
    p.details.amount !== q.maxAmountIn ||
    p.details.amount >= 2n ** 160n - 1n ||
    p.details.nonce >= 2n ** 48n ||
    p.sigDeadline * 1000 > q.expiresAt ||
    p.details.expiration * 1000 > q.expiresAt ||
    Math.min(p.sigDeadline, p.details.expiration) * 1000 <= now
  )
    throw new SwapError("REVIEW_REQUIRED");
  return { digest: digest(p), signable: false as const };
}
