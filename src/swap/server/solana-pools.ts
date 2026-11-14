import { createHash } from "node:crypto";
import { PublicKey } from "../../../swap-providers/runtime";
import { SwapError, type SwapIntent, type SwapQuote } from "../model";
import { decodeSolTokenAccount, type RawSolAccount } from "./solana-accounts";

const WHIRL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const discriminator = createHash("sha256")
  .update("account:Whirlpool")
  .digest()
  .subarray(0, 8);
/** Source layout: orca-so/whirlpools@cc683ec92acb5e7606caa3d8e514d9383e9c7c11
 * programs/whirlpool/src/state/whirlpool.rs.
 * Only independently decoded pool families are reviewable; an AMM name from a quote is not evidence.
 */
export function verifySolanaPools(
  q: SwapQuote,
  plan: {
    swap: { variant: string; a_to_b?: boolean };
    input_index: number;
    output_index: number;
    percent?: number;
    bps?: number;
  }[],
  keys: string[],
  lookup: (key: string) => RawSolAccount | null | undefined,
  intent: SwapIntent,
) {
  const reject = (): never => {
    throw new SwapError("BUILD_REVIEW_REQUIRED");
  };
  if (q.route.length !== plan.length) reject();
  const nodeMints = new Map([[0, intent.tokenIn.address]]),
    consumed = new Set<number>();
  const proofs: {
    pool: string;
    version: 1 | 2;
    mintA: string;
    mintB: string;
    vaultA: string;
    vaultB: string;
    aToB: boolean;
  }[] = [];
  for (const [index, leg] of q.route.entries()) {
    const step = plan[index];
    if (
      nodeMints.get(step.input_index) !== leg.tokenIn ||
      (nodeMints.has(step.output_index) &&
        nodeMints.get(step.output_index) !== leg.tokenOut)
    )
      reject();
    nodeMints.set(step.output_index, leg.tokenOut);
    consumed.add(step.input_index);
    if (
      leg.poolType !== "SOLANA" ||
      leg.shareBps !== (step.bps ?? step.percent! * 100) ||
      !keys.includes(leg.pool)
    )
      reject();
    if (
      !["Whirlpool", "WhirlpoolSwapV2"].includes(step.swap.variant) ||
      !["Whirlpool", "WhirlpoolSwapV2", "Whirlpool V2"].includes(leg.venue)
    )
      reject();
    const raw = lookup(leg.pool);
    if (
      !raw ||
      raw.owner !== WHIRL ||
      raw.executable ||
      raw.data[1] !== "base64"
    )
      reject();
    const data = Buffer.from(raw!.data[0], "base64");
    if (data.length !== 653 || !data.subarray(0, 8).equals(discriminator))
      reject();
    const key = (offset: number) =>
      new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    const mintA = key(101),
      vaultA = key(133),
      mintB = key(181),
      vaultB = key(213);
    if (
      typeof step.swap.a_to_b !== "boolean" ||
      leg.tokenIn !== (step.swap.a_to_b ? mintA : mintB) ||
      leg.tokenOut !== (step.swap.a_to_b ? mintB : mintA)
    )
      reject();
    for (const [vault, mint] of [
      [vaultA, mintA],
      [vaultB, mintB],
    ]) {
      if (!keys.includes(vault) || !lookup(vault)) reject();
      const token = decodeSolTokenAccount(lookup(vault)!);
      if (
        token.mint !== mint ||
        token.owner !== leg.pool ||
        token.delegate ||
        token.closeAuthority
      )
        reject();
    }
    proofs.push({
      pool: leg.pool,
      version: step.swap.variant === "Whirlpool" ? 1 : 2,
      mintA,
      mintB,
      vaultA,
      vaultB,
      aToB: step.swap.a_to_b!,
    });
  }
  const sinks = [...nodeMints].filter(([node]) => !consumed.has(node));
  if (sinks.length !== 1 || sinks[0][1] !== intent.tokenOut.address) reject();
  return proofs;
}
