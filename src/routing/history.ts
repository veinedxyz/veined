import { z } from "zod";
import type { Network, RoutingQuote } from "./model";
import { quoteEligible, type SwapIntent, type SwapQuote } from "../swap/model";
const schema = z
  .object({
    id: z.string().max(200),
    provider: z.enum(["routing-core", "swap-intelligence"]),
    source: z.string().max(18),
    destination: z.string().max(18),
    sourceName: z.string().max(120),
    destinationName: z.string().max(120),
    sourceAsset: z.string().max(128),
    destinationAsset: z.string().max(128),
    sourceAddress: z.string().max(128),
    destinationAddress: z.string().max(128),
    amount: z.string().regex(/^\d+$/),
    expected: z.string().regex(/^\d+$/),
    minimum: z.string().regex(/^\d+$/),
    binding: z.string().max(2000),
    observedAt: z.number(),
    expiresAt: z.number(),
    sourceHash: z.string().max(200).optional(),
    slippage: z.number().min(0.0001).max(0.03).default(0.005),
    preference: z.enum(["receive", "time"]).default("receive"),
    generation: z.string().max(80).default("historical-preview"),
    walletRevision: z.number().int().nonnegative().default(0),
    steps: z
      .array(
        z.object({
          tool: z.string().max(120),
          source: z.string().max(18),
          destination: z.string().max(18),
        }),
      )
      .max(30),
    state: z.literal("QUOTE_PREVIEW"),
  })
  .strict();
export type RoutePreview = z.infer<typeof schema>;
const key = "otherbridge:routing-previews:v1";
function strictRead(): RoutePreview[] {
  const raw = localStorage.getItem(key) ?? "[]";
  if (raw.length > 300000) throw Error("STORAGE_TOO_LARGE");
  return z.array(schema).max(40).parse(JSON.parse(raw));
}
export function readPreviews(): RoutePreview[] {
  try {
    return strictRead();
  } catch {
    return [];
  }
}
export async function savePreview(
  q: RoutingQuote,
  source: Network,
  destination: Network,
) {
  if (q.executable !== false || Date.now() >= q.expiresAt)
    throw Error("INVALID_PREVIEW");
  const record = schema.parse({
    id: q.id,
    provider: q.provider,
    source: source.id,
    destination: destination.id,
    sourceName: source.name,
    destinationName: destination.name,
    sourceAsset: q.input.sourceAsset,
    destinationAsset: q.input.destinationAsset,
    sourceAddress: q.input.sourceAddress,
    destinationAddress: q.input.destinationAddress,
    amount: q.input.amount,
    expected: q.expected,
    minimum: q.minimum,
    binding: q.binding,
    observedAt: q.observedAt,
    expiresAt: q.expiresAt,
    slippage: q.input.slippage,
    preference: q.input.preference,
    generation: q.input.generation,
    walletRevision: q.input.walletRevision,
    steps: q.steps.map((s) => ({
      tool: s.tool,
      source: s.sourceAsset.chainId,
      destination: s.destinationAsset.chainId,
    })),
    state: "QUOTE_PREVIEW",
  });
  await storePreview(record);
}
/** Local quote evidence only: this record never establishes a submitted transaction. */
export async function saveSwapPreview(
  q: SwapQuote,
  i: SwapIntent,
  network: Network,
) {
  if (!quoteEligible(q, Date.now()) || q.chain !== i.chain)
    throw Error("INVALID_PREVIEW");
  const address = (token: SwapIntent["tokenIn"]) =>
    token.native ? network.nativeAsset.address : token.address;
  await storePreview(
    schema.parse({
      id: q.id,
      provider: "swap-intelligence",
      source: network.id,
      destination: network.id,
      sourceName: network.name,
      destinationName: network.name,
      sourceAsset: address(i.tokenIn),
      destinationAsset: address(i.tokenOut),
      sourceAddress: i.taker,
      destinationAddress: i.recipient,
      amount: q.amountIn.toString(),
      expected: q.amountOut.toString(),
      minimum: q.minAmountOut.toString(),
      binding: q.intentDigest,
      observedAt: q.quotedAt,
      expiresAt: q.expiresAt,
      slippage: q.slippageBps / 10000,
      preference: i.preference === "FASTEST" ? "time" : "receive",
      generation: "swap-v1151",
      walletRevision: i.walletEpoch,
      steps: q.route.map((l) => ({
        tool: l.venue,
        source: network.id,
        destination: network.id,
      })),
      state: "QUOTE_PREVIEW",
    }),
  );
}
async function storePreview(record: RoutePreview) {
  if (!navigator.locks) throw Error("STORAGE_LOCK_UNAVAILABLE");
  await navigator.locks.request(key, () => {
    const before = strictRead();
    if (before.length >= 40 && !before.some((x) => x.id === record.id))
      throw Error("HISTORY_FULL");
    localStorage.setItem(
      key,
      JSON.stringify([record, ...before.filter((x) => x.id !== record.id)]),
    );
  });
}
export async function attachPreviewHash(
  id: string,
  hash: string,
): Promise<RoutePreview> {
  if (
    !/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90}|[0-9a-fA-F]{64})$/.test(
      hash,
    ) ||
    !navigator.locks
  )
    throw Error("INVALID_HASH");
  return await navigator.locks.request(key, () => {
    const records = strictRead(),
      index = records.findIndex((r) => r.id === id);
    if (
      index < 0 ||
      (records[index].sourceHash && records[index].sourceHash !== hash)
    )
      throw Error("HASH_CONFLICT");
    const record = { ...records[index], sourceHash: hash };
    records[index] = record;
    localStorage.setItem(key, JSON.stringify(records));
    return record;
  });
}
