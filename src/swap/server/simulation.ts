import { SwapError, type SwapIntent } from "../model";
import { digest } from "./digest";
import type { UnsignedBuild } from "./provider";
import { rpc } from "./transport";
import type { SolanaEconomics } from "./solana-economics";
import { type RawSolAccount } from "./solana-accounts";
import { verifySolanaDeltas, type EconomicSimulation } from "./solana-deltas";
import { verifySolanaCpis } from "./solana-cpi";
import { VersionedTransaction } from "../../../swap-providers/runtime";
export type Simulation = {
  status: "PASSED";
  transactionDigest: string;
  chain: string;
  source: string;
  at: number;
  gasOrCompute: string;
  logs: string[];
  tokenDeltas:
    | "UNAVAILABLE"
    | {
        input: string;
        output: string;
        networkFee: string;
        signatureValidity: "NOT_ASSERTED";
      };
};
export async function simulate(
  build: UnsignedBuild,
  i: SwapIntent,
  signal: AbortSignal,
  economics?: SolanaEconomics,
): Promise<Simulation> {
  if (build.ecosystem === "EVM") {
    const chain = await rpc(i.chain, "eth_chainId", [], signal);
    if (typeof chain !== "string" || BigInt(chain) !== BigInt(i.chain))
      throw new SwapError("REVIEW_REQUIRED");
    const block = await rpc(i.chain, "eth_blockNumber", [], signal);
    if (typeof block !== "string") throw new SwapError("INVALID_SCHEMA");
    const call = {
      from: build.from,
      to: build.to,
      value: `0x${BigInt(build.value).toString(16)}`,
      data: build.data,
    };
    const [result, gas] = await Promise.all([
      rpc(i.chain, "eth_call", [call, block], signal),
      rpc(i.chain, "eth_estimateGas", [call, block], signal),
    ]);
    if (
      typeof result !== "string" ||
      !/^0x[0-9a-f]*$/i.test(result) ||
      typeof gas !== "string" ||
      !/^0x[0-9a-f]+$/i.test(gas) ||
      BigInt(gas) <= 0n
    )
      throw new SwapError("SIMULATION_FAILED");
    return {
      status: "PASSED",
      transactionDigest: digest(build),
      chain: i.chain,
      source: BigInt(block).toString(),
      at: Date.now(),
      gasOrCompute: BigInt(gas).toString(),
      logs: [],
      tokenDeltas: "UNAVAILABLE",
    };
  }
  const r = (await rpc(
    "solana",
    "simulateTransaction",
    [
      build.transaction,
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: "confirmed",
        innerInstructions: true,
        ...(economics
          ? {
              minContextSlot: economics.slot,
              accounts: { encoding: "base64", addresses: economics.accounts },
            }
          : {}),
      },
    ],
    signal,
  )) as {
    context?: { slot: number };
    value?: EconomicSimulation & {
      err: unknown;
      logs?: string[];
      unitsConsumed?: number;
      accounts?: (RawSolAccount | null)[];
    };
  };
  if (
    !r.context ||
    !r.value ||
    r.value.err !== null ||
    !Number.isSafeInteger(r.context.slot)
  )
    throw new SwapError("SIMULATION_FAILED");
  let tokenDeltas: Simulation["tokenDeltas"] = "UNAVAILABLE";
  if (economics) {
    const message = VersionedTransaction.deserialize(
      Buffer.from(build.transaction, "base64"),
    ).message;
    const loaded = r.value.loadedAddresses;
    if (
      !loaded ||
      JSON.stringify([
        ...message.staticAccountKeys.map((k) => k.toBase58()),
        ...loaded.writable,
        ...loaded.readonly,
      ]) !== JSON.stringify(economics.accountKeys)
    )
      throw new SwapError("SIMULATION_FAILED");
    if (r.context.slot < economics.slot || r.context.slot - economics.slot > 32)
      throw new SwapError("SIMULATION_FAILED");
    verifySolanaCpis(r.value, economics, i);
    tokenDeltas = verifySolanaDeltas(r.value, economics, i);
    for (const pin of economics.programProof) {
      if (!pin.programData) continue;
      const current = (await rpc(
        "solana",
        "getAccountInfo",
        [
          pin.programData,
          {
            encoding: "base64",
            commitment: "confirmed",
            minContextSlot: r.context.slot,
            dataSlice: { offset: 0, length: 45 },
          },
        ],
        signal,
      )) as { value?: RawSolAccount };
      if (
        !current.value ||
        current.value.owner !== pin.loader ||
        current.value.executable ||
        current.value.data[0] !== pin.metadata
      )
        throw new SwapError("SIMULATION_FAILED");
    }
  }
  return {
    status: "PASSED",
    transactionDigest: digest(build),
    chain: i.chain,
    source: String(r.context.slot),
    at: Date.now(),
    gasOrCompute: String(r.value.unitsConsumed ?? 0),
    logs: (r.value.logs ?? []).slice(0, 64).map((s) => s.slice(0, 256)),
    tokenDeltas,
  };
}
