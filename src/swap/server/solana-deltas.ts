import { SwapError, type SwapIntent } from "../model";
import { decodeSolTokenAccount, type RawSolAccount } from "./solana-accounts";
import type { SolanaEconomics } from "./solana-economics";
type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
};
export type EconomicSimulation = {
  innerInstructions?: Parameters<
    typeof import("./solana-cpi").verifySolanaCpis
  >[0]["innerInstructions"];
  accounts?: (RawSolAccount | null)[];
  fee?: number;
  preBalances?: number[];
  postBalances?: number[];
  preTokenBalances?: TokenBalance[];
  postTokenBalances?: TokenBalance[];
  loadedAddresses?: { readonly: string[]; writable: string[] };
};
function fail(): never {
  throw new SwapError("SIMULATION_FAILED");
}
/** Current Agave simulation returns pre/post balances and fee from one bank. Never subtract different RPC snapshots. */
export function verifySolanaDeltas(
  v: EconomicSimulation,
  e: SolanaEconomics,
  i: SwapIntent,
) {
  const keys = e.accountKeys,
    pre = v.preBalances,
    post = v.postBalances,
    pt = v.preTokenBalances,
    ot = v.postTokenBalances,
    after = v.accounts;
  if (
    !pre ||
    !post ||
    !pt ||
    !ot ||
    !after ||
    pre.length !== keys.length ||
    post.length !== keys.length ||
    after.length !== e.accounts.length ||
    pre.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    post.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    !Number.isSafeInteger(v.fee) ||
    v.fee! < 0 ||
    v.fee! > 20000 + Number(e.priorityFeeMaximum)
  )
    fail();
  const networkFee = BigInt(v.fee!);
  for (const balances of [pt, ot]) {
    const seen = new Set<number>();
    for (const t of balances) {
      if (
        !Number.isInteger(t.accountIndex) ||
        t.accountIndex < 0 ||
        t.accountIndex >= keys.length ||
        seen.has(t.accountIndex) ||
        !/^\d{1,20}$/.test(t.uiTokenAmount.amount) ||
        BigInt(t.uiTokenAmount.amount) >= 1n << 64n
      )
        fail();
      seen.add(t.accountIndex);
      if (
        [i.taker, i.recipient].includes(t.owner ?? "") &&
        ![e.inputAccount, e.outputAccount].includes(keys[t.accountIndex])
      )
        fail();
      const input = keys[t.accountIndex] === e.inputAccount,
        output = keys[t.accountIndex] === e.outputAccount;
      if (input || output) {
        const expected = input ? i.tokenIn : i.tokenOut,
          raw = e.before[e.accounts.indexOf(expected.address)];
        if (
          t.owner !== (input ? i.taker : i.recipient) ||
          t.mint !== expected.address ||
          t.uiTokenAmount.decimals !== expected.decimals ||
          t.programId !== raw?.owner
        )
          fail();
      }
    }
  }
  const amount = (rows: TokenBalance[], a: string) =>
    BigInt(
      rows.find((t) => keys[t.accountIndex] === a)?.uiTokenAmount.amount ?? "0",
    );
  for (const [index, a] of after.entries()) {
    const address = e.accounts[index];
    if (![e.inputAccount, e.outputAccount].includes(address)) continue;
    if (!a) {
      if (!e.nativeClose.includes(address)) fail();
      continue;
    }
    if (
      e.nativeClose.includes(address) &&
      a.owner === "11111111111111111111111111111111" &&
      a.lamports === 0 &&
      !a.executable &&
      a.data[0] === ""
    )
      continue;
    const t = decodeSolTokenAccount(a),
      input = address === e.inputAccount;
    if (
      t.owner !== (input ? i.taker : i.recipient) ||
      t.mint !== (input ? e.inputMint : e.outputMint) ||
      t.delegate ||
      (t.closeAuthority && t.closeAuthority !== t.owner) ||
      t.amount !== amount(ot, address)
    )
      fail();
  }
  const controlled = new Set([
    i.taker,
    i.recipient,
    e.inputAccount,
    e.outputAccount,
  ]);
  const nativeDelta = keys.reduce(
    (sum, k, n) =>
      sum + (controlled.has(k) ? BigInt(post[n]) - BigInt(pre[n]) : 0n),
    0n,
  );
  const input = i.tokenIn.native
    ? -nativeDelta - networkFee
    : amount(pt, e.inputAccount) - amount(ot, e.inputAccount);
  const output = i.tokenOut.native
    ? nativeDelta + networkFee
    : amount(ot, e.outputAccount) - amount(pt, e.outputAccount);
  if (
    input !== i.amount ||
    output < e.minimumOut ||
    (!i.tokenIn.native && !i.tokenOut.native && nativeDelta !== -networkFee)
  )
    fail();
  return {
    input: input.toString(),
    output: output.toString(),
    networkFee: networkFee.toString(),
    signatureValidity: "NOT_ASSERTED" as const,
  };
}
