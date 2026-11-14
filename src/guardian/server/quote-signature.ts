// Server-only verification of NEAR Intents 1Click quote signatures, byte-compatible with the official SDK
// (@defuse-protocol/one-click-sdk-typescript 0.1.26, src/quote-signature.ts): the 1Click manager key signs, with
// ed25519, the UTF-8 bytes of base58(sha256(json-stable-stringify({...signedRequest, ...signedQuote, timestamp}))).
// It MUST run on the response exactly as received: any re-serialization (for example turning "22.4260" into 22.426)
// changes the signed bytes. No dependency is added: node:crypto verifies ed25519, @noble/hashes and @scure/base are
// already VEINED dependencies.
import { createPublicKey, verify } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

export const ONE_CLICK_MANAGER_KEY =
  "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** json-stable-stringify semantics: keys in code-unit order, undefined object members dropped, undefined array items null. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}
type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : undefined;
const orUndefined = (v: unknown) => (v ? v : undefined);

/** The exact message the 1Click manager signs for a quote response (SDK `quoteHash`). */
export function quoteMessage(response: unknown): string | null {
  const r = obj(response),
    q = obj(r?.quoteRequest),
    o = obj(r?.quote);
  if (!r || !q || !o || typeof r.timestamp !== "string") return null;
  const request = {
    dry: q.dry,
    swapType: q.swapType,
    slippageTolerance: q.slippageTolerance,
    originAsset: q.originAsset,
    depositType: q.depositType,
    destinationAsset: q.destinationAsset,
    amount: q.amount,
    refundTo: q.refundTo,
    refundType: q.refundType,
    recipient: q.recipient,
    recipientType: q.recipientType,
    deadline: q.deadline,
    quoteWaitingTimeMs: orUndefined(q.quoteWaitingTimeMs),
    referral: orUndefined(q.referral),
    virtualChainRecipient: orUndefined(q.virtualChainRecipient),
    virtualChainRefundRecipient: orUndefined(q.virtualChainRefundRecipient),
    customRecipientMsg: orUndefined(q.customRecipientMsg),
  };
  const priced = {
    amountIn: o.amountIn,
    amountInFormatted: o.amountInFormatted,
    amountInUsd: o.amountInUsd,
    minAmountIn: o.minAmountIn,
    amountOut: o.amountOut,
    amountOutFormatted: o.amountOutFormatted,
    amountOutUsd: o.amountOutUsd,
    minAmountOut: o.minAmountOut,
  };
  const quote = q.dry
    ? priced
    : {
        ...priced,
        depositAddress: orUndefined(o.depositAddress),
        depositMemo: orUndefined(o.depositMemo),
        deadline: orUndefined(o.deadline),
        timeWhenInactive: orUndefined(o.timeWhenInactive),
        timeEstimate: orUndefined(o.timeEstimate),
        refundFee: orUndefined(o.refundFee),
        withdrawFee: orUndefined(o.withdrawFee),
      };
  const data = stableStringify({
    ...request,
    ...quote,
    timestamp: r.timestamp,
  });
  return base58.encode(sha256(new TextEncoder().encode(data)));
}

export type SignatureState = "VALID" | "INVALID" | "MISSING";
/** Verify a raw 1Click quote response against the manager key. Anything malformed is INVALID, never VALID. */
export function verifyQuoteSignature(
  response: unknown,
  managerKey = ONE_CLICK_MANAGER_KEY,
): { state: SignatureState; message: string | null } {
  const r = obj(response);
  if (!r || typeof r.signature !== "string" || !r.signature)
    return { state: "MISSING", message: null };
  const message = quoteMessage(r);
  if (!message) return { state: "INVALID", message: null };
  try {
    const raw = (v: string) => base58.decode(v.replace(/^ed25519:/, ""));
    const key = raw(managerKey),
      signature = raw(r.signature);
    if (key.length !== 32 || signature.length !== 64)
      return { state: "INVALID", message };
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_ED25519, Buffer.from(key)]),
      format: "der",
      type: "spki",
    });
    return {
      state: verify(
        null,
        Buffer.from(message),
        publicKey,
        Buffer.from(signature),
      )
        ? "VALID"
        : "INVALID",
      message,
    };
  } catch {
    return { state: "INVALID", message };
  }
}
