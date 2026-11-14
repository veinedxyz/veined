import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "../../../swap-providers/runtime";
import { SwapError, type SwapIntent, type SwapQuote } from "../model";
import {
  inspectSolanaEconomics,
  type SolanaEconomics,
} from "./solana-economics";
import type { SolanaBuild } from "./provider";
import { rpc } from "./transport";
import { digest } from "./digest";
export const SOL_PROGRAMS = Object.freeze({
  system: "11111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  compute: "ComputeBudget111111111111111111111111111111",
  jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
});
export type SolanaInspection = {
  payer: string;
  signers: string[];
  blockhash: string;
  lastValidBlockHeight: number | null;
  lookups: { address: string; digest: string }[];
  accountKeys: string[];
  instructions: {
    program: string;
    accounts: { address: string; signer: boolean; writable: boolean }[];
    data: string;
  }[];
  transactionDigest: string;
  computeLimit: number;
  priorityMicroLamports: bigint;
  review: "BUILD_REVIEW_REQUIRED" | "ECONOMICS_VERIFIED";
  economics?: SolanaEconomics;
};
/** Structural decoder and RPC-backed lookup resolution, shared by Jupiter and Titan. No wallet dependency. */
export async function inspectSolana(
  build: SolanaBuild,
  i: SwapIntent,
  signal: AbortSignal,
  quote?: SwapQuote,
): Promise<SolanaInspection> {
  if (
    build.transaction.length > 1800 ||
    (build.lastValidBlockHeight !== null &&
      !Number.isSafeInteger(build.lastValidBlockHeight))
  )
    throw new SwapError("INVALID_SCHEMA");
  let tx: VersionedTransaction;
  try {
    const bytes = Buffer.from(build.transaction, "base64");
    if (bytes.toString("base64") !== build.transaction || bytes.length > 1232)
      throw Error();
    tx = VersionedTransaction.deserialize(bytes);
    if (Buffer.from(tx.serialize()).compare(bytes) !== 0) throw Error();
  } catch {
    throw new SwapError("INVALID_SCHEMA");
  }
  if (tx.version !== 0 || tx.signatures.some((s) => s.some((b) => b !== 0)))
    throw new SwapError("REVIEW_REQUIRED");
  const signers = tx.message.staticAccountKeys
    .slice(0, tx.message.header.numRequiredSignatures)
    .map((k) => k.toBase58());
  if (
    signers.length !== 1 ||
    signers[0] !== i.taker ||
    tx.message.staticAccountKeys[0].toBase58() !== i.taker
  )
    throw new SwapError("REVIEW_REQUIRED");
  const height = await rpc(
    "solana",
    "getBlockHeight",
    [{ commitment: "confirmed" }],
    signal,
  );
  if (
    typeof height !== "number" ||
    (build.lastValidBlockHeight !== null &&
      height >= build.lastValidBlockHeight)
  )
    throw new SwapError("QUOTE_STALE");
  const valid = (await rpc(
    "solana",
    "isBlockhashValid",
    [tx.message.recentBlockhash, { commitment: "confirmed" }],
    signal,
  )) as { value?: boolean };
  if (valid?.value !== true) throw new SwapError("QUOTE_STALE");
  const tables: AddressLookupTableAccount[] = [],
    lookups: SolanaInspection["lookups"] = [];
  for (const lookup of tx.message.addressTableLookups) {
    const raw = (await rpc(
      "solana",
      "getAccountInfo",
      [
        lookup.accountKey.toBase58(),
        { encoding: "base64", commitment: "confirmed" },
      ],
      signal,
    )) as { value?: { owner?: string; data?: [string, string] } };
    if (
      raw.value?.owner !== "AddressLookupTab1e1111111111111111111111111" ||
      !raw.value.data
    )
      throw new SwapError("REVIEW_REQUIRED");
    const bytes = Buffer.from(raw.value.data[0], "base64"),
      state = AddressLookupTableAccount.deserialize(bytes);
    if (state.deactivationSlot !== 2n ** 64n - 1n)
      throw new SwapError("REVIEW_REQUIRED");
    for (const index of [...lookup.writableIndexes, ...lookup.readonlyIndexes])
      if (index >= state.addresses.length)
        throw new SwapError("REVIEW_REQUIRED");
    tables.push(
      new AddressLookupTableAccount({
        key: new PublicKey(lookup.accountKey),
        state,
      }),
    );
    lookups.push({
      address: lookup.accountKey.toBase58(),
      digest: digest(bytes.toString("hex")),
    });
  }
  let message: TransactionMessage;
  try {
    message = TransactionMessage.decompile(tx.message, {
      addressLookupTableAccounts: tables,
    });
  } catch {
    throw new SwapError("REVIEW_REQUIRED");
  }
  let computeLimit = 200000,
    priorityMicroLamports = 0n,
    limitSeen = false,
    priceSeen = false;
  const instructions = message.instructions.map((ix) => {
    const program = ix.programId.toBase58(),
      data = ix.data;
    if (!Object.values(SOL_PROGRAMS).some((v) => v === program))
      throw new SwapError("REVIEW_REQUIRED");
    if (program === SOL_PROGRAMS.system && !quote)
      throw new SwapError("BUILD_REVIEW_REQUIRED"); // All SystemProgram transfers require a dedicated native-wrap proof.
    if (program === SOL_PROGRAMS.compute) {
      if (ix.keys.length) throw new SwapError("REVIEW_REQUIRED");
      if (data[0] === 2 && data.length === 5 && !limitSeen) {
        computeLimit = data.readUInt32LE(1);
        limitSeen = true;
        if (computeLimit === 0 || computeLimit > 1400000)
          throw new SwapError("REVIEW_REQUIRED");
      } else if (data[0] === 3 && data.length === 9 && !priceSeen) {
        priorityMicroLamports = data.readBigUInt64LE(1);
        priceSeen = true;
        if (priorityMicroLamports > 10000000n)
          throw new SwapError("REVIEW_REQUIRED");
      } else throw new SwapError("REVIEW_REQUIRED");
    }
    return {
      program,
      accounts: ix.keys.map((k) => ({
        address: k.pubkey.toBase58(),
        signer: k.isSigner,
        writable: k.isWritable,
      })),
      data: data.toString("hex"),
    };
  });
  const inspection: SolanaInspection = {
    payer: message.payerKey.toBase58(),
    signers,
    blockhash: message.recentBlockhash,
    lastValidBlockHeight: build.lastValidBlockHeight,
    lookups,
    accountKeys: tx.message
      .getAccountKeys({ addressLookupTableAccounts: tables })
      .keySegments()
      .flat()
      .map((k) => k.toBase58()),
    instructions,
    transactionDigest: digest(build),
    computeLimit,
    priorityMicroLamports,
    review: "BUILD_REVIEW_REQUIRED",
  };
  if (quote) {
    inspection.economics = await inspectSolanaEconomics(
      inspection,
      i,
      quote,
      signal,
    );
    inspection.review = "ECONOMICS_VERIFIED";
  }
  return inspection;
}
/** A recognized outer program is insufficient: venue instruction/account semantics need independent review. */
export function assertSolanaReviewable(inspection: SolanaInspection): void {
  if (inspection.review !== "ECONOMICS_VERIFIED" || !inspection.economics)
    throw new SwapError("BUILD_REVIEW_REQUIRED");
}
