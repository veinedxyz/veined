import { createHash } from "node:crypto";
import { base58 } from "@scure/base";
import { SwapError, type SwapIntent } from "../model";
import type { SolanaEconomics } from "./solana-economics";
import { SPL, TOKEN_2022 } from "./solana-accounts";
const WHIRL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM = "11111111111111111111111111111111";
type Inner = {
  programId?: string;
  accounts?: string[];
  data?: string;
  stackHeight?: number;
  [key: string]: unknown;
};
/** Same-bank CPI evidence establishes the pool actually invoked, not mere membership in transaction accounts. */
export function verifySolanaCpis(
  value: { innerInstructions?: { index: number; instructions: Inner[] }[] },
  economics: SolanaEconomics,
  intent: SwapIntent,
) {
  const fail = (): never => {
    throw new SwapError("SIMULATION_FAILED");
  };
  const groups = value.innerInstructions;
  if (
    !Array.isArray(groups) ||
    groups.length > 32 ||
    !economics.poolProof?.length ||
    !Array.isArray(economics.topLevelPrograms) ||
    economics.topLevelPrograms.length > 32 ||
    !Number.isSafeInteger(economics.swapInstructionIndex) ||
    economics.topLevelPrograms[economics.swapInstructionIndex] !== JUP
  )
    fail();
  const instructions: Inner[] = [];
  const proven = new Set(economics.programProof.map((proof) => proof.address));
  if (economics.accountKeys.includes(SYSTEM)) proven.add(SYSTEM);
  const children = new Map<string, string[]>([
    [JUP, [WHIRL, SPL, TOKEN_2022, SYSTEM, JUP]],
    [WHIRL, [SPL, TOKEN_2022]],
    [ATA, [SPL, TOKEN_2022, SYSTEM]],
  ]);
  let previousIndex = -1,
    eventCount = 0;
  for (const group of groups!) {
    if (
      !Number.isSafeInteger(group.index) ||
      group.index <= previousIndex ||
      group.index >= economics.topLevelPrograms.length ||
      !Array.isArray(group.instructions) ||
      group.instructions.length > 128
    )
      fail();
    previousIndex = group.index;
    const stack = [economics.topLevelPrograms[group.index]];
    for (const ix of group.instructions) {
      const depth = ix.stackHeight;
      if (
        !Number.isSafeInteger(depth) ||
        depth! < 2 ||
        depth! > 8 ||
        depth! > stack.length + 1 ||
        typeof ix.programId !== "string" ||
        !proven.has(ix.programId) ||
        !economics.accountKeys.includes(ix.programId) ||
        !children.get(stack[depth! - 2])?.includes(ix.programId) ||
        (ix.programId === WHIRL &&
          group.index !== economics.swapInstructionIndex)
      )
        fail();
      if (ix.programId === JUP) {
        if (
          typeof ix.data !== "string" ||
          ix.data.length > 200 ||
          !Array.isArray(ix.accounts)
        )
          fail();
        let bytes: Buffer;
        try {
          bytes = Buffer.from(base58.decode(ix.data ?? ""));
        } catch {
          fail();
        }
        const eventDiscriminator = createHash("sha256")
          .update("event:SwapEvent")
          .digest()
          .subarray(0, 8);
        // The current Jupiter self-CPI is the Anchor event emitter, never an
        // additional route invocation. Its authority is bound by the current IDL.
        if (
          depth !== 2 ||
          group.index !== economics.swapInstructionIndex ||
          ix.accounts?.length !== 1 ||
          ix.accounts[0] !== economics.eventAuthority ||
          bytes!.length !== 128 ||
          bytes!.subarray(0, 8).toString("hex") !== "e445a52e51cb9a1d" ||
          !bytes!.subarray(8, 16).equals(eventDiscriminator) ||
          ++eventCount > economics.poolProof.length
        )
          fail();
      }
      stack.length = depth! - 1;
      stack.push(ix.programId!);
    }
    instructions.push(...group.instructions);
  }
  const swaps = instructions.filter((ix) => ix.programId === WHIRL);
  if (swaps.length !== economics.poolProof.length) fail();
  for (const [n, ix] of swaps.entries()) {
    const proof = economics.poolProof[n],
      keys = ix.accounts;
    if (
      ix.stackHeight !== 2 ||
      !Array.isArray(keys) ||
      keys.length < (proof.version === 1 ? 11 : 15) ||
      keys.length > 32 ||
      keys.some(
        (key) =>
          typeof key !== "string" || !economics.accountKeys.includes(key),
      ) ||
      typeof ix.data !== "string" ||
      ix.data.length > 800
    )
      fail();
    let data: Uint8Array;
    try {
      data = base58.decode(ix.data!);
    } catch {
      fail();
    }
    const bytes = Buffer.from(data!),
      discriminator = createHash("sha256")
        .update(proof.version === 1 ? "global:swap" : "global:swap_v2")
        .digest()
        .subarray(0, 8);
    if (
      bytes.length < 42 ||
      bytes.length > 512 ||
      (proof.version === 1 && bytes.length !== 42) ||
      !bytes.subarray(0, 8).equals(discriminator) ||
      bytes[40] !== 1 ||
      bytes[41] !== Number(proof.aToB) ||
      bytes.readBigUInt64LE(8) === 0n
    )
      fail();
    const poolIndex = proof.version === 1 ? 2 : 4,
      vaultA = proof.version === 1 ? 4 : 8,
      vaultB = proof.version === 1 ? 6 : 10;
    if (
      keys![poolIndex] !== proof.pool ||
      keys![vaultA] !== proof.vaultA ||
      keys![vaultB] !== proof.vaultB ||
      (proof.version === 1 && keys![0] !== SPL) ||
      (proof.version === 2 &&
        (keys![5] !== proof.mintA || keys![6] !== proof.mintB))
    )
      fail();
    if (economics.poolProof.length === 1) {
      const ownerA = proof.version === 1 ? 3 : 7,
        ownerB = proof.version === 1 ? 5 : 9;
      if (
        keys![proof.aToB ? ownerA : ownerB] !== economics.inputAccount ||
        keys![proof.aToB ? ownerB : ownerA] !== economics.outputAccount ||
        keys![proof.version === 1 ? 1 : 3] !== intent.taker ||
        bytes.readBigUInt64LE(8) !== intent.amount
      )
        fail();
    }
  }
}
