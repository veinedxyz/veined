import { z } from "zod";
import { SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM } from "../rpc/methods";
import type { RpcPool } from "../rpc/pool";
const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const accounts = z
  .object({
    context: z.object({ slot: z.number().int().nonnegative() }).passthrough(),
    value: z
      .array(
        z
          .object({
            pubkey: base58,
            account: z
              .object({
                data: z
                  .object({
                    parsed: z
                      .object({
                        info: z
                          .object({
                            mint: base58,
                            owner: base58,
                            tokenAmount: z
                              .object({
                                amount: z.string().regex(/^(0|[1-9]\d{0,38})$/),
                                decimals: z.number().int().min(0).max(36),
                              })
                              .passthrough(),
                          })
                          .passthrough(),
                      })
                      .passthrough(),
                  })
                  .passthrough(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .max(5000),
  })
  .passthrough();
export interface SplHolding {
  mint: string;
  amount: bigint;
  decimals: number;
  program: "spl-token" | "spl-token-2022";
}
// Native lamports plus every SPL token account owned by the address at finalized commitment.
// Token names/symbols stay unknown without trusted metadata evidence.
export async function readSolana(
  pool: RpcPool,
  owner: string,
  signal?: AbortSignal,
) {
  const options = { signal, timeoutMs: 8000, maxBytes: 4000000 };
  const balance = z
    .object({
      context: z.object({ slot: z.number().int().nonnegative() }).passthrough(),
      value: z.number().int().nonnegative().safe(),
    })
    .passthrough()
    .parse(
      (
        await pool.call(
          {
            method: "getBalance",
            params: [owner, { commitment: "finalized" }],
          },
          options,
        )
      ).value,
    );
  const holdings = new Map<string, SplHolding>();
  let slot = balance.context.slot;
  for (const [programId, program] of [
    [SPL_TOKEN_PROGRAM, "spl-token"],
    [SPL_TOKEN_2022_PROGRAM, "spl-token-2022"],
  ] as const) {
    const result = accounts.parse(
      (
        await pool.call(
          {
            method: "getTokenAccountsByOwner",
            params: [
              owner,
              { programId },
              { encoding: "jsonParsed", commitment: "finalized" },
            ],
          },
          options,
        )
      ).value,
    );
    slot = Math.max(slot, result.context.slot);
    for (const row of result.value) {
      const info = row.account.data.parsed.info;
      if (info.owner !== owner) throw Error("SPL_OWNER_MISMATCH");
      const previous = holdings.get(info.mint);
      if (previous && previous.decimals !== info.tokenAmount.decimals)
        throw Error("SPL_DECIMALS_CONFLICT");
      holdings.set(info.mint, {
        mint: info.mint,
        amount: (previous?.amount ?? 0n) + BigInt(info.tokenAmount.amount),
        decimals: info.tokenAmount.decimals,
        program,
      });
    }
  }
  return {
    lamports: BigInt(balance.value),
    slot: BigInt(slot),
    tokens: [...holdings.values()],
    observedAt: Date.now(),
  };
}
