import { describe, it, expect, vi, afterEach } from "vitest";
import fixture from "../fixtures/solana-economic-whirlpool.json";
import { inspectSolana } from "../../src/swap/server/solana";
import { simulate } from "../../src/swap/server/simulation";
import {
  verifySolanaDeltas,
  type EconomicSimulation,
} from "../../src/swap/server/solana-deltas";
import type { SolanaEconomics } from "../../src/swap/server/solana-economics";
import { type SwapIntent, type SwapQuote } from "../../src/swap/model";
import { VersionedTransaction } from "../../swap-providers/runtime";
import type { SolanaBuild } from "../../src/swap/server/provider";
import { normalizeTitan } from "../../src/swap/server/providers/titan";
import { base58 } from "@scure/base";
const raw = fixture.result,
  build = raw.build as SolanaBuild;
const intent = {
  ...raw.intent,
  amount: BigInt(raw.intent.amount),
} as SwapIntent;
const quote = {
  ...raw.quote,
  amountIn: BigInt(raw.quote.amountIn),
  amountOut: BigInt(raw.quote.amountOut),
  minAmountOut: BigInt(raw.quote.minAmountOut),
  maxAmountIn: BigInt(raw.quote.maxAmountIn),
} as unknown as SwapQuote;
const econ = {
  ...raw.inspection.economics,
  amountIn: BigInt(raw.inspection.economics.amountIn),
  minimumOut: BigInt(raw.inspection.economics.minimumOut),
  platformFee: 0n,
  tips: 0n,
  rentMaximum: BigInt(raw.inspection.economics.rentMaximum),
  priorityFeeMaximum: BigInt(raw.inspection.economics.priorityFeeMaximum),
  nativeWrap: BigInt(raw.inspection.economics.nativeWrap),
} as unknown as SolanaEconomics;
const sim = (
  fixture.rpc.find((r) => r.request.method === "simulateTransaction")!.response
    .result as { value: unknown }
).value as EconomicSimulation;
const signal = () => new AbortController().signal;
function rpc(change?: (method: string, result: unknown) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body),
        match =
          fixture.rpc.find(
            (r) =>
              r.request.method === request.method &&
              JSON.stringify(r.request.params) ===
                JSON.stringify(request.params),
          ) ?? fixture.rpc.find((r) => r.request.method === request.method);
      if (!match) throw Error("UNRECORDED_RPC");
      return Response.json({
        ...match.response,
        result: change
          ? change(request.method, structuredClone(match.response.result))
          : match.response.result,
      });
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());
describe("actual unsigned Jupiter / Whirlpool economic regression", () => {
  it("validates a framed Titan route carrying the recorded unsigned transaction through the shared economic firewall", async () => {
    rpc();
    const frame = {
      id: "RECORDED_ROUTE_TEST_ONLY_NOT_LIVE_TITAN",
      inputMint: base58.decode(intent.tokenIn.address),
      outputMint: base58.decode(intent.tokenOut.address),
      swapMode: "ExactIn" as const,
      amount: intent.amount,
      quotes: {
        recorded: {
          inAmount: intent.amount,
          outAmount: quote.amountOut,
          slippageBps: intent.slippage.bps,
          instructions: [],
          addressLookupTables: [],
          transaction: Buffer.from(build.transaction, "base64"),
          steps: quote.route.map((l) => ({
            ammKey: base58.decode(l.pool),
            label: l.venue,
            inputMint: base58.decode(l.tokenIn),
            outputMint: base58.decode(l.tokenOut),
            inAmount: intent.amount,
            outAmount: quote.amountOut,
            allocPpb: l.shareBps * 100000,
          })),
        },
      },
    };
    const normalized = normalizeTitan(frame, intent)[0];
    expect(normalized.q.mode).toBe("TITAN");
    const inspected = await inspectSolana(
      {
        ...build,
        transaction: Buffer.from(normalized.transaction!).toString("base64"),
      },
      intent,
      signal(),
      normalized.q,
    );
    expect(inspected.review).toBe("ECONOMICS_VERIFIED");
    const simulation = await simulate(
      build,
      intent,
      signal(),
      inspected.economics,
    );
    expect(simulation.tokenDeltas).toEqual(raw.simulation.tokenDeltas);
  });
  it("replays recorded public RPC evidence with exact economics and no signature assertion", async () => {
    rpc();
    const inspected = await inspectSolana(build, intent, signal(), quote);
    expect(inspected.review).toBe("ECONOMICS_VERIFIED");
    const result = await simulate(build, intent, signal(), inspected.economics);
    expect(result.tokenDeltas).toEqual(raw.simulation.tokenDeltas);
    expect(raw.broadcasts).toBe(0);
    expect(raw.evidenceType).toBe(
      "CURRENT_STATE_UNSIGNED_REPLAY_OF_PUBLIC_ROUTE",
    );
  });
  it.each([
    "recipient",
    "inputMint",
    "outputMint",
    "decimals",
    "amount",
    "slippage",
  ])("rejects changed intent %s", async (field) => {
    rpc();
    const i = structuredClone(intent);
    if (field === "recipient") i.recipient = "11111111111111111111111111111111";
    if (field === "inputMint") i.tokenIn.address = i.taker;
    if (field === "outputMint") i.tokenOut.address = i.taker;
    if (field === "decimals") i.tokenIn.decimals++;
    if (field === "amount") i.amount++;
    if (field === "slippage") i.slippage.bps = 1;
    await expect(inspectSolana(build, i, signal(), quote)).rejects.toThrow();
  });
  it.each(["pool", "venue", "mint", "direction", "allocation", "extraLeg"])(
    "rejects changed quote route %s",
    async (field) => {
      rpc();
      const q = structuredClone(quote);
      if (field === "pool") q.route[0].pool = intent.taker;
      if (field === "venue") q.route[0].venue = "UnreviewedAMM";
      if (field === "mint") q.route[0].tokenIn = q.route[0].tokenOut;
      if (field === "direction")
        [q.route[0].tokenIn, q.route[0].tokenOut] = [
          q.route[0].tokenOut,
          q.route[0].tokenIn,
        ];
      if (field === "allocation") q.route[0].shareBps = 5000;
      if (field === "extraLeg") q.route.push(q.route[0]);
      await expect(inspectSolana(build, intent, signal(), q)).rejects.toThrow();
    },
  );
  it.each([
    "pool",
    "vault",
    "direction",
    "amount",
    "authority",
    "missing",
    "extra",
    "unknownProgram",
    "parentIndex",
    "duplicateParent",
    "wrongParent",
    "stackJump",
    "eventInstruction",
    "eventAuthority",
    "eventAccountsShape",
    "oversizedEvent",
  ])("rejects same-bank CPI %s substitution", async (mutation) => {
    rpc((method, result) => {
      if (method !== "simulateTransaction") return result;
      const value = (result as { value: EconomicSimulation }).value;
      const instruction = value
        .innerInstructions!.flatMap((g) => g.instructions)
        .find(
          (ix) =>
            ix.programId === "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
        )!;
      if (mutation === "pool") instruction.accounts![2] = intent.taker;
      if (mutation === "vault") instruction.accounts![4] = intent.taker;
      if (mutation === "authority")
        instruction.accounts![1] = intent.tokenIn.address;
      if (mutation === "direction" || mutation === "amount") {
        const bytes = Buffer.from(base58.decode(instruction.data!));
        if (mutation === "direction") bytes[41] = bytes[41] === 1 ? 0 : 1;
        else bytes.writeBigUInt64LE(intent.amount + 1n, 8);
        instruction.data = base58.encode(bytes);
      }
      if (mutation === "extra")
        value.innerInstructions![0].instructions.push(instruction);
      const group = value.innerInstructions!.find((g) =>
        g.instructions.includes(instruction),
      )!;
      if (mutation === "unknownProgram")
        group.instructions.push({
          programId: intent.taker,
          accounts: [],
          data: "",
          stackHeight: 2,
        });
      if (mutation === "parentIndex") group.index = 999;
      if (mutation === "duplicateParent")
        value.innerInstructions!.push(
          structuredClone(value.innerInstructions![0]),
        );
      if (mutation === "wrongParent") group.index = 4;
      if (mutation === "stackJump") instruction.stackHeight = 4;
      const event = group.instructions.find(
        (ix) => ix.programId === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      )!;
      if (mutation === "eventInstruction") event.data = instruction.data;
      if (mutation === "eventAuthority") event.accounts![0] = intent.taker;
      if (mutation === "eventAccountsShape")
        Object.assign(event, {
          accounts: { 0: event.accounts![0], length: 1 },
        });
      if (mutation === "oversizedEvent") event.data = "1".repeat(201);
      if (mutation === "missing") delete value.innerInstructions;
      return result;
    });
    const inspected = await inspectSolana(build, intent, signal(), quote);
    await expect(
      simulate(build, intent, signal(), inspected.economics),
    ).rejects.toThrow("SIMULATION_FAILED");
  });
  it.each([
    "fee",
    "input",
    "output",
    "owner",
    "mint",
    "extraAccount",
    "missingBalances",
    "unsafeNumber",
    "closedAccount",
  ])("rejects simulated %s mutation", (field) => {
    const v = structuredClone(sim),
      source = econ.accountKeys.indexOf(econ.inputAccount),
      dest = econ.accountKeys.indexOf(econ.outputAccount);
    if (field === "fee") v.fee = 100000000;
    if (field === "input")
      v.postTokenBalances!.find(
        (t) => t.accountIndex === source,
      )!.uiTokenAmount.amount = "0";
    if (field === "output") v.postBalances![0] = v.preBalances![0];
    if (field === "owner")
      v.preTokenBalances!.find((t) => t.accountIndex === source)!.owner =
        "11111111111111111111111111111111";
    if (field === "mint")
      v.preTokenBalances!.find((t) => t.accountIndex === source)!.mint =
        intent.tokenOut.address;
    if (field === "extraAccount")
      v.preTokenBalances!.push({
        ...v.preTokenBalances![0],
        accountIndex: 1,
        owner: intent.taker,
      });
    if (field === "missingBalances") delete v.preBalances;
    if (field === "unsafeNumber")
      v.postBalances![0] = Number.MAX_SAFE_INTEGER + 1;
    if (field === "closedAccount")
      v.accounts![econ.accounts.indexOf(econ.outputAccount)]!.lamports = 1;
    expect(() => verifySolanaDeltas(v, econ, intent)).toThrow();
    expect(dest).toBeGreaterThan(0);
  });
  it("rejects a signed provider payload before RPC", async () => {
    const tx = VersionedTransaction.deserialize(
      Buffer.from(build.transaction, "base64"),
    );
    tx.signatures[0][0] = 1;
    await expect(
      inspectSolana(
        {
          ...build,
          transaction: Buffer.from(tx.serialize()).toString("base64"),
        },
        intent,
        signal(),
        quote,
      ),
    ).rejects.toThrow("REVIEW_REQUIRED");
  });
  it("rejects a program upgrade before economic review", async () => {
    rpc((method, result) => {
      if (
        method === "getAccountInfo" &&
        result &&
        typeof result === "object" &&
        "value" in result
      ) {
        const v = (result as { value: { data: [string, string] } }).value,
          b = Buffer.from(v.data[0], "base64");
        if (b.length === 45) {
          b[4] ^= 1;
          v.data[0] = b.toString("base64");
        }
      }
      return result;
    });
    await expect(inspectSolana(build, intent, signal(), quote)).rejects.toThrow(
      "BUILD_REVIEW_REQUIRED",
    );
  });
  it("rejects a changed simulation lookup resolution", async () => {
    rpc((method, result) => {
      if (method === "simulateTransaction") {
        const r = result as { value: EconomicSimulation };
        r.value.loadedAddresses!.readonly.reverse();
      }
      return result;
    });
    await expect(simulate(build, intent, signal(), econ)).rejects.toThrow(
      "SIMULATION_FAILED",
    );
  });
});
