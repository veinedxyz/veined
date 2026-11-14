import { z } from "zod";
import { base58 } from "@scure/base";
import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "../../../../swap-providers/runtime";
import { impactBps, rawUnits, SwapError, type SwapIntent } from "../../model";
import {
  baseCosts,
  makeQuote,
  type QuoteAdapter,
  type SolanaBuild,
} from "../provider";
import { jsonRead, rpc } from "../transport";
const uint = z.number().int().nonnegative().safe();
const ixSchema = z
  .object({
    programId: z.string(),
    accounts: z
      .array(
        z
          .object({
            pubkey: z.string(),
            isSigner: z.boolean(),
            isWritable: z.boolean(),
          })
          .strict(),
      )
      .max(256),
    data: z.string().max(16000),
  })
  .strict();
const schema = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: rawUnits,
  outAmount: rawUnits,
  otherAmountThreshold: rawUnits,
  swapMode: z.literal("ExactIn"),
  slippageBps: uint,
  routePlan: z
    .array(
      z.object({
        swapInfo: z.object({
          ammKey: z.string(),
          label: z.string(),
          inputMint: z.string(),
          outputMint: z.string(),
          inAmount: rawUnits,
          outAmount: rawUnits,
        }),
        percent: z.number().optional(),
        bps: z.number().optional(),
      }),
    )
    .min(1)
    .max(64),
  priceImpact: z.number().optional(),
  priceImpactPct: z.string().optional(),
  feeBps: uint.optional(),
  feeMint: z.string().optional(),
  platformFee: z
    .object({ amount: rawUnits, feeBps: uint })
    .nullable()
    .optional(),
  signatureFeeLamports: uint.optional(),
  prioritizationFeeLamports: uint.optional(),
  rentFeeLamports: uint.optional(),
  signatureFeePayer: z.string().nullable().optional(),
  taker: z.string().nullable().optional(),
  transactionVersion: uint.optional(),
  transaction: z.string().nullable().optional(),
  lastValidBlockHeight: z.string().optional(),
  expireAt: z.string().optional(),
  router: z.enum(["metis", "jupiterz", "dflow", "okx"]).optional(),
  computeBudgetInstructions: z.array(ixSchema).optional(),
  setupInstructions: z.array(ixSchema).optional(),
  swapInstruction: ixSchema.optional(),
  cleanupInstruction: ixSchema.nullable().optional(),
  otherInstructions: z.array(ixSchema).optional(),
  tipInstruction: ixSchema.nullable().optional(),
  addressesByLookupTableAddress: z
    .record(z.string(), z.array(z.string()))
    .nullable()
    .optional(),
  blockhashWithMetadata: z
    .object({
      blockhash: z.array(z.number().int().min(0).max(255)).length(32),
      lastValidBlockHeight: uint,
    })
    .optional(),
});
export function normalizeJupiter(
  raw: unknown,
  i: SwapIntent,
  mode: "JUPITER_META" | "JUPITER_ROUTER",
) {
  const result = schema.safeParse(raw);
  if (!result.success) throw new SwapError("INVALID_SCHEMA");
  const r = result.data;
  if (
    r.inputMint !== i.tokenIn.address ||
    r.outputMint !== i.tokenOut.address ||
    r.inAmount !== i.amount ||
    (r.taker && r.taker !== i.taker) ||
    r.slippageBps > i.slippage.bps ||
    (r.transactionVersion !== undefined && r.transactionVersion !== 0)
  )
    throw new SwapError("REVIEW_REQUIRED");
  const costs = baseCosts(i.tokenOut.address);
  const fee = costs.find((c) => c.kind === "PROVIDER")!;
  fee.amount = r.platformFee?.amount ?? ((r.feeBps ?? 0) > 0 ? null : 0n);
  fee.token = r.feeMint ?? i.tokenOut.address;
  fee.usdMicros = fee.amount === 0n ? 0n : null;
  for (const [field, kind] of [
    ["signatureFeeLamports", "NETWORK"],
    ["prioritizationFeeLamports", "PRIORITY"],
    ["rentFeeLamports", "RENT"],
  ] as const) {
    const existing = costs.find((c) => c.kind === kind);
    const c = {
      kind,
      amount: r[field] === undefined ? null : BigInt(r[field]!),
      token: "native",
      included: false,
      usdMicros: null,
      evidence: "PROVIDER" as const,
    };
    if (existing) Object.assign(existing, c);
    else costs.push(c);
  }
  const route = r.routePlan.map((s) => ({
    venue: s.swapInfo.label,
    poolType: "SOLANA" as const,
    pool: s.swapInfo.ammKey,
    tokenIn: s.swapInfo.inputMint,
    tokenOut: s.swapInfo.outputMint,
    shareBps: s.bps ?? Math.round((s.percent ?? 100) * 100),
  }));
  const q = makeQuote(i, "Jupiter", mode, r.inAmount, r.outAmount, route, {
    minAmountOut: r.otherAmountThreshold,
    slippageBps: r.slippageBps,
    costs,
    priceImpactBps:
      mode === "JUPITER_META"
        ? impactBps(r.priceImpact, "PERCENT")
        : impactBps(r.priceImpactPct, "FRACTION"),
    build: r.transaction || r.swapInstruction ? "UNSIGNED_BUILD" : "QUOTE_ONLY",
    splitCount: Math.max(
      1,
      route.filter((s) => s.tokenIn === i.tokenIn.address).length,
    ),
  });
  if (r.expireAt) {
    const expiry = Date.parse(r.expireAt);
    if (!Number.isFinite(expiry)) throw new SwapError("INVALID_SCHEMA");
    q.expiresAt = Math.min(q.expiresAt, expiry);
  }
  return { q, r };
}
export function jupiter(
  key: string,
  mode: "JUPITER_META" | "JUPITER_ROUTER",
): QuoteAdapter {
  const builds = new Map<string, z.infer<typeof schema>>();
  return {
    mode,
    provider: "Jupiter",
    chains: ["solana"],
    exactOut: false,
    async quote(i, signal) {
      if (!key) throw new SwapError("CREDENTIAL_REQUIRED");
      if (i.recipient !== i.taker) throw new SwapError("BUILD_REVIEW_REQUIRED");
      const params = new URLSearchParams({
        inputMint: i.tokenIn.address,
        outputMint: i.tokenOut.address,
        amount: i.amount.toString(),
        taker: i.taker,
        slippageBps: String(i.slippage.bps),
        ...(mode === "JUPITER_META"
          ? { mode: "manual", maxSupportedTransactionVersion: "0" }
          : { transactionVersion: "0" }),
      });
      const raw = await jsonRead(
        `https://api.jup.ag/swap/v2/${mode === "JUPITER_META" ? "order" : "build"}?${params}`,
        { headers: { "x-api-key": key } },
        signal,
      );
      const { q, r } = normalizeJupiter(raw, i, mode);
      builds.set(q.id, r);
      while (builds.size > 128) builds.delete(builds.keys().next().value!);
      return [q];
    },
    async build(q, i, signal): Promise<SolanaBuild> {
      const r = builds.get(q.id);
      if (!r) throw new SwapError("QUOTE_STALE");
      if (r.signatureFeePayer && r.signatureFeePayer !== i.taker)
        throw new SwapError("REVIEW_REQUIRED");
      if (r.transaction) {
        const height = Number(r.lastValidBlockHeight);
        if (!Number.isSafeInteger(height) || height <= 0)
          throw new SwapError("INVALID_SCHEMA");
        return {
          ecosystem: "SVM",
          transaction: r.transaction,
          lastValidBlockHeight: height,
        };
      }
      if (!r.swapInstruction || !r.blockhashWithMetadata)
        throw new SwapError("BUILD_REVIEW_REQUIRED");
      const tables: AddressLookupTableAccount[] = [];
      for (const [address, expected] of Object.entries(
        r.addressesByLookupTableAddress ?? {},
      )) {
        const account = (await rpc(
          "solana",
          "getAccountInfo",
          [address, { encoding: "base64", commitment: "confirmed" }],
          signal,
        )) as { value?: { owner?: string; data?: [string, string] } };
        if (
          account.value?.owner !==
            "AddressLookupTab1e1111111111111111111111111" ||
          !account.value.data
        )
          throw new SwapError("REVIEW_REQUIRED");
        const table = new AddressLookupTableAccount({
          key: new PublicKey(address),
          state: AddressLookupTableAccount.deserialize(
            Buffer.from(account.value.data[0], "base64"),
          ),
        });
        if (
          table.state.deactivationSlot !== 2n ** 64n - 1n ||
          JSON.stringify(table.state.addresses.map((a) => a.toBase58())) !==
            JSON.stringify(expected)
        )
          throw new SwapError("REVIEW_REQUIRED");
        tables.push(table);
      }
      const ix = [
        ...(r.computeBudgetInstructions ?? []),
        ...(r.setupInstructions ?? []),
        ...(r.otherInstructions ?? []),
        r.swapInstruction,
        ...(r.cleanupInstruction ? [r.cleanupInstruction] : []),
        ...(r.tipInstruction ? [r.tipInstruction] : []),
      ].map(
        (x) =>
          new TransactionInstruction({
            programId: new PublicKey(x.programId),
            keys: x.accounts.map((a) => ({
              pubkey: new PublicKey(a.pubkey),
              isSigner: a.isSigner,
              isWritable: a.isWritable,
            })),
            data: Buffer.from(x.data, "base64"),
          }),
      );
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: new PublicKey(i.taker),
          recentBlockhash: base58.encode(
            Uint8Array.from(r.blockhashWithMetadata.blockhash),
          ),
          instructions: ix,
        }).compileToV0Message(tables),
      );
      return {
        ecosystem: "SVM",
        transaction: Buffer.from(tx.serialize()).toString("base64"),
        lastValidBlockHeight: r.blockhashWithMetadata.lastValidBlockHeight,
      };
    },
  };
}
