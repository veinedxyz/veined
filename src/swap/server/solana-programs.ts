import { createHash } from "node:crypto";
import { base58 } from "@scure/base";
import pins from "./solana-program-pins.generated.json" with { type: "json" };
import { SwapError } from "../model";
import { rpc } from "./transport";
import type { RawSolAccount } from "./solana-accounts";
const builtin = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
]);
function fail(): never {
  throw new SwapError("BUILD_REVIEW_REQUIRED");
}
/** Loader-owned program-data headers bind deployment slot and upgrade authority. Every upgrade requires a new review. */
export async function verifySolanaPrograms(
  accounts: string[],
  values: (RawSolAccount | null)[],
  signal: AbortSignal,
) {
  const proofs = [];
  for (const [n, a] of values.entries()) {
    if (!a?.executable) continue;
    const address = accounts[n];
    if (builtin.has(address)) {
      if (a.owner !== "NativeLoader1111111111111111111111111111111") fail();
      continue;
    }
    const pin = pins.find((p) => p.address === address);
    if (!pin || pin.loader !== a.owner || a.data[1] !== "base64") fail();
    const bytes = Buffer.from(a.data[0], "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== pin.codeSha256)
      fail();
    if (pin.programData) {
      if (
        bytes.length !== 36 ||
        bytes.readUInt32LE() !== 2 ||
        base58.encode(bytes.subarray(4)) !== pin.programData
      )
        fail();
      const raw = (await rpc(
        "solana",
        "getAccountInfo",
        [
          pin.programData,
          {
            encoding: "base64",
            commitment: "confirmed",
            dataSlice: { offset: 0, length: 45 },
          },
        ],
        signal,
      )) as { value?: RawSolAccount };
      if (
        !raw.value ||
        raw.value.executable ||
        raw.value.owner !== pin.loader ||
        raw.value.data[0] !== pin.metadata
      )
        fail();
    }
    proofs.push({
      address,
      loader: pin.loader,
      programData: pin.programData,
      metadata: pin.metadata,
      codeSha256: pin.codeSha256,
    });
  }
  if (
    !proofs.some(
      (p) => p.address === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    )
  )
    fail();
  return proofs;
}
