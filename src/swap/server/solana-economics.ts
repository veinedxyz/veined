import { verifySolanaPrograms } from "./solana-programs";
import { verifySolanaPools } from "./solana-pools";
import { PublicKey } from "../../../swap-providers/runtime";
import { SwapError, SOL, type SwapIntent, type SwapQuote } from "../model";
import { decodeJupiterInstruction } from "./jupiter-decoder";
import {
  SPL,
  TOKEN_2022,
  decodeSolMint,
  decodeSolTokenAccount,
  type RawSolAccount,
} from "./solana-accounts";
import { rpc } from "./transport";
import type { SolanaInspection } from "./solana";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  SYSTEM = "11111111111111111111111111111111",
  COMPUTE = "ComputeBudget111111111111111111111111111111";
function reject(): never {
  throw new SwapError("BUILD_REVIEW_REQUIRED");
}
function ata(owner: string, mint: string, program: string) {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBytes(),
      new PublicKey(program).toBytes(),
      new PublicKey(mint).toBytes(),
    ],
    new PublicKey(ATA),
  )[0].toBase58();
}
export type SolanaEconomics = {
  slot: number;
  accountKeys: string[];
  topLevelPrograms: string[];
  swapInstructionIndex: number;
  eventAuthority: string;
  programProof: Awaited<ReturnType<typeof verifySolanaPrograms>>;
  inputAccount: string;
  outputAccount: string;
  inputMint: string;
  outputMint: string;
  amountIn: bigint;
  minimumOut: bigint;
  platformFee: bigint;
  tips: bigint;
  rentMaximum: bigint;
  priorityFeeMaximum: bigint;
  nativeWrap: bigint;
  nativeClose: string[];
  accounts: string[];
  before: (RawSolAccount | null)[];
  route: ReturnType<typeof decodeJupiterInstruction>;
  poolProof: ReturnType<typeof verifySolanaPools>;
};
/** Independent economics: quote text never establishes mint/account ownership, instruction amounts or recipients. */
export async function inspectSolanaEconomics(
  s: SolanaInspection,
  i: SwapIntent,
  q: SwapQuote,
  signal: AbortSignal,
): Promise<SolanaEconomics> {
  if (i.kind !== "EXACT_IN") reject();
  const swaps = s.instructions.filter((x) => x.program === JUP);
  if (swaps.length !== 1) reject();
  const swap = swaps[0],
    route = decodeJupiterInstruction(Buffer.from(swap.data, "hex"));
  if (
    ![
      "route",
      "shared_accounts_route",
      "route_v2",
      "shared_accounts_route_v2",
    ].includes(route.name) ||
    swap.accounts.length < route.accounts.length
  )
    reject();
  const named = new Map(
    route.accounts.map((a, n) => [a.name, swap.accounts[n]]),
  );
  for (const [n, a] of route.accounts.entries()) {
    const k = swap.accounts[n];
    if (
      (a.signer && !k.signer) ||
      (a.writable && !k.writable && !(a.optional && k.address === JUP)) ||
      (a.address && a.address !== k.address) ||
      (!a.signer && k.signer)
    )
      reject();
  }
  const name = (n: string) => named.get(n)?.address;
  if (
    name("user_transfer_authority") !== i.taker ||
    name("program") !== JUP ||
    (name("source_mint") && name("source_mint") !== i.tokenIn.address) ||
    name("destination_mint") !== i.tokenOut.address
  )
    reject();
  const source =
      name("user_source_token_account") ?? name("source_token_account"),
    destination =
      name("user_destination_token_account") ??
      name("destination_token_account");
  if (!source || !destination || source === destination) reject();
  const args = route.args;
  if (
    args.in_amount !== i.amount ||
    args.quoted_out_amount !== q.amountOut ||
    typeof args.slippage_bps !== "number" ||
    args.slippage_bps < 0 ||
    args.slippage_bps > i.slippage.bps ||
    args.platform_fee_bps !== 0 ||
    (args.positive_slippage_bps !== undefined &&
      args.positive_slippage_bps !== 0)
  )
    reject();
  if (name("platform_fee_account") && name("platform_fee_account") !== JUP)
    reject();
  if (
    name("user_destination_token_account") &&
    name("destination_token_account") &&
    name("destination_token_account") !== JUP &&
    name("destination_token_account") !== destination
  )
    reject();
  const plan = args.route_plan as {
    swap: { variant: string; a_to_b?: boolean };
    input_index: number;
    output_index: number;
    percent?: number;
    bps?: number;
  }[];
  if (
    !Array.isArray(plan) ||
    !plan.length ||
    plan.length > 32 ||
    plan.some(
      (l) =>
        l.input_index === l.output_index ||
        l.input_index > 31 ||
        l.output_index > 31 ||
        (l.bps ?? (l.percent ?? 0) * 100) <= 0 ||
        (l.bps ?? (l.percent ?? 0) * 100) > 10000,
    )
  )
    reject();
  // Topological route graph: every consumed node is produced, each allocation sums to 100%, one final sink.
  const produced = new Set([0]),
    weights = new Map<number, number>(),
    outputs = new Set<number>();
  for (const leg of plan) {
    if (!produced.has(leg.input_index) || leg.output_index <= leg.input_index)
      reject();
    produced.add(leg.output_index);
    outputs.add(leg.output_index);
    weights.set(
      leg.input_index,
      (weights.get(leg.input_index) ?? 0) + (leg.bps ?? leg.percent! * 100),
    );
  }
  if (
    [...weights.values()].some((n) => n !== 10000) ||
    [...outputs].filter((n) => !weights.has(n)).length !== 1
  )
    reject();
  // Dynamic arbitrage/ledger/stake/claim variants require their own economic proof; supported swap AMMs only.
  const venues = new Set([
    "Raydium",
    "RaydiumClmm",
    "RaydiumClmmV2",
    "RaydiumCP",
    "Whirlpool",
    "WhirlpoolSwapV2",
    "Meteora",
    "MeteoraDlmm",
    "MeteoraDlmmSwapV2",
    "MeteoraDammV2",
    "Lifinity",
    "LifinityV2",
    "TokenSwap",
    "TokenSwapV2",
  ]);
  if (plan.some((l) => !venues.has(l.swap.variant))) reject();
  const minimumOut = (q.amountOut * BigInt(10000 - args.slippage_bps)) / 10000n;
  if (minimumOut < q.minAmountOut) reject();
  const tracked = [
    ...new Set([
      i.taker,
      i.recipient,
      i.tokenIn.address,
      i.tokenOut.address,
      source,
      destination,
      ...s.instructions.flatMap((x) =>
        x.accounts.filter((a) => a.writable).map((a) => a.address),
      ),
    ]),
  ];
  const accounts = [...new Set([...tracked, ...s.accountKeys])];
  if (accounts.length > 64) reject();
  const raw = (await rpc(
    "solana",
    "getMultipleAccounts",
    [accounts, { encoding: "base64", commitment: "confirmed" }],
    signal,
  )) as { context?: { slot: number }; value?: (RawSolAccount | null)[] };
  if (
    !Number.isSafeInteger(raw.context?.slot) ||
    !raw.value ||
    raw.value.length !== accounts.length
  )
    reject();
  const programProof = await verifySolanaPrograms(accounts, raw.value, signal);
  const lookup = (a: string) => raw.value![accounts.indexOf(a)];
  const poolProof = verifySolanaPools(
    q,
    plan,
    swap.accounts.map((a) => a.address),
    lookup,
    i,
  );
  const inMint = decodeSolMint(lookup(i.tokenIn.address)!),
    outMint = decodeSolMint(lookup(i.tokenOut.address)!);
  if (
    inMint.decimals !== i.tokenIn.decimals ||
    outMint.decimals !== i.tokenOut.decimals
  )
    reject();
  if (
    source !== ata(i.taker, i.tokenIn.address, inMint.program) ||
    destination !== ata(i.recipient, i.tokenOut.address, outMint.program)
  )
    reject();
  if (
    (name("source_token_program") &&
      name("source_token_program") !== inMint.program) ||
    (name("destination_token_program") &&
      name("destination_token_program") !== outMint.program) ||
    (name("token_program") && name("token_program") !== SPL) ||
    (name("token_2022_program") &&
      ![TOKEN_2022, JUP].includes(name("token_2022_program")!))
  )
    reject();
  for (const [n, a] of raw.value.entries())
    if (
      a &&
      [SPL, TOKEN_2022].includes(a.owner) &&
      ![i.tokenIn.address, i.tokenOut.address].includes(accounts[n])
    ) {
      const token = decodeSolTokenAccount(a);
      if (
        [i.taker, i.recipient].includes(token.owner) &&
        ![source, destination].includes(accounts[n])
      )
        reject();
      if (
        accounts[n] === source &&
        (token.mint !== i.tokenIn.address ||
          token.owner !== i.taker ||
          token.program !== inMint.program ||
          token.delegate ||
          (token.closeAuthority && token.closeAuthority !== i.taker))
      )
        reject();
      if (
        accounts[n] === destination &&
        (token.mint !== i.tokenOut.address ||
          token.owner !== i.recipient ||
          token.program !== outMint.program)
      )
        reject();
    }
  let nativeWrap = 0n,
    rentMaximum = 0n;
  const created = new Set<string>(),
    nativeClose: string[] = [];
  let seenSwap = false,
    synced = false;
  for (const ix of s.instructions) {
    const data = Buffer.from(ix.data, "hex"),
      keys = ix.accounts.map((a) => a.address);
    if (ix.program === COMPUTE) continue;
    if (ix.program === JUP) {
      seenSwap = true;
      continue;
    }
    if (ix.program === ATA) {
      if (
        seenSwap ||
        !(data.length === 0 || (data.length === 1 && data[0] === 1)) ||
        keys.length < 6 ||
        keys.length > 7 ||
        keys[0] !== i.taker ||
        keys[4] !== SYSTEM ||
        ![source, destination].includes(keys[1]) ||
        created.has(keys[1])
      )
        reject();
      const input = keys[1] === source;
      if (
        keys[2] !== (input ? i.taker : i.recipient) ||
        keys[3] !== (input ? i.tokenIn.address : i.tokenOut.address) ||
        keys[5] !== (input ? inMint.program : outMint.program)
      )
        reject();
      created.add(keys[1]);
      if (!lookup(keys[1])) {
        const rent = await rpc(
          "solana",
          "getMinimumBalanceForRentExemption",
          [
            (input ? inMint.program : outMint.program) === TOKEN_2022
              ? 170
              : 165,
            { commitment: "confirmed" },
          ],
          signal,
        );
        if (
          typeof rent !== "number" ||
          !Number.isSafeInteger(rent) ||
          rent < 0 ||
          rent > 10000000
        )
          reject();
        rentMaximum += BigInt(rent);
      }
      continue;
    }
    if (ix.program === SYSTEM) {
      if (
        seenSwap ||
        !i.tokenIn.native ||
        i.tokenIn.address !== SOL ||
        data.length !== 12 ||
        data.readUInt32LE(0) !== 2 ||
        keys.length !== 2 ||
        keys[0] !== i.taker ||
        keys[1] !== source ||
        nativeWrap !== 0n
      )
        reject();
      nativeWrap = data.readBigUInt64LE(4);
      if (nativeWrap !== i.amount) reject();
      continue;
    }
    if ([SPL, TOKEN_2022].includes(ix.program)) {
      if (data.length !== 1) reject();
      if (data[0] === 17) {
        if (
          seenSwap ||
          keys.length !== 1 ||
          keys[0] !== source ||
          nativeWrap !== i.amount ||
          synced ||
          ix.program !== SPL
        )
          reject();
        synced = true;
        continue;
      }
      if (data[0] === 9) {
        const input = keys[0] === source,
          output = keys[0] === destination;
        if (
          !seenSwap ||
          keys.length !== 3 ||
          !((input && i.tokenIn.native) || (output && i.tokenOut.native)) ||
          keys[1] !== i.taker ||
          keys[2] !== i.taker ||
          i.recipient !== i.taker ||
          nativeClose.includes(keys[0]) ||
          ix.program !== SPL
        )
          reject();
        nativeClose.push(keys[0]);
        continue;
      }
      reject();
    }
    reject();
  }
  if (
    (!lookup(source) && !created.has(source)) ||
    (!lookup(destination) && !created.has(destination)) ||
    (i.tokenIn.native && (nativeWrap !== i.amount || !synced)) ||
    (i.tokenOut.native && !nativeClose.includes(destination))
  )
    reject();
  return {
    slot: raw.context!.slot,
    programProof,
    poolProof,
    accountKeys: s.accountKeys,
    topLevelPrograms: s.instructions.map((instruction) => instruction.program),
    swapInstructionIndex: s.instructions.indexOf(swap),
    eventAuthority: name("event_authority") ?? reject(),
    inputAccount: source,
    outputAccount: destination,
    inputMint: i.tokenIn.address,
    outputMint: i.tokenOut.address,
    amountIn: i.amount,
    minimumOut,
    platformFee: 0n,
    tips: 0n,
    rentMaximum,
    priorityFeeMaximum:
      (BigInt(s.computeLimit) * s.priorityMicroLamports + 999999n) / 1000000n,
    nativeWrap,
    nativeClose,
    accounts: tracked,
    before: tracked.map(lookup),
    route,
  };
}
