// G13 Phase 3: simulation of owner-signed plans in an isolated in-memory EVM (@ethereumjs/vm + solc, the accepted
// test environment of tests/integration/evm.test.ts). SYNTHETIC_TEST_ONLY contracts (tests/fixtures/G13Execution.sol)
// and synthetic accounts; nothing is signed, nothing leaves the process, and every simulation runs inside a state
// checkpoint that is reverted (like eth_call: it never commits).
import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import solc from "solc";
import { createVM } from "@ethereumjs/vm";
import { createCustomCommon, Mainnet, Hardfork } from "@ethereumjs/common";
import {
  createAddressFromString,
  hexToBytes,
  bytesToHex,
} from "@ethereumjs/util";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import { preflight, type PreflightFacts } from "../../src/execution/preflight";
import { approvalTransaction, MAX_UINT256 } from "../../src/execution/erc20";
import {
  EXECUTION_POLICY,
  type ExecutionPlan,
} from "../../src/execution/model";

const ACCOUNT = "0x3333333333333333333333333333333333333333";
const BANK = "0x2222222222222222222222222222222222222222";
const DEPLOYER = "0x1111111111111111111111111111111111111111";
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);
const routerAbi = parseAbi([
  "function swap(address,address,uint256,uint256,address)",
]);
const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
type Compiled = Record<string, { evm: { bytecode: { object: string } } }>;
let compiled: Compiled;
beforeAll(async () => {
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: {
          "g13.sol": {
            content: await readFile("tests/fixtures/G13Execution.sol", "utf8"),
          },
        },
        settings: {
          evmVersion: "shanghai",
          outputSelection: { "*": { "*": ["evm.bytecode.object"] } },
        },
      }),
    ),
  );
  expect(
    (out.errors ?? []).filter(
      (e: { severity: string }) => e.severity === "error",
    ),
  ).toEqual([]);
  compiled = out.contracts["g13.sol"];
});

async function world() {
  const vm = await createVM({
    common: createCustomCommon({ chainId: 31337 }, Mainnet, {
      hardfork: Hardfork.Shanghai,
    }),
  });
  const run = async (from: string, to: string | null, data: Hex) => {
    const r = await vm.evm.runCall({
      caller: createAddressFromString(from),
      ...(to ? { to: createAddressFromString(to) } : {}),
      data: hexToBytes(data),
      gasLimit: 5_000_000n,
    });
    return r;
  };
  const deploy = async (name: string, args: Hex = "0x") => {
    const r = await run(
      DEPLOYER,
      null,
      `0x${compiled[name].evm.bytecode.object}${args.slice(2)}` as Hex,
    );
    expect(r.execResult.exceptionError).toBeUndefined();
    return r.createdAddress!.toString();
  };
  const routers = {
    fair: await deploy("FairRouter"),
    greedy: await deploy("GreedyRouter"),
    redirect: await deploy("RedirectRouter"),
  };
  const holder = (who: string, amount: bigint) =>
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [who as Hex, amount],
    );
  const tokenIn = await deploy("TestToken", holder(ACCOUNT, 9_000_000n));
  const tokenOut = await deploy("TestToken", holder(BANK, 10_000n));
  for (const r of Object.values(routers))
    expect(
      (
        await run(
          BANK,
          tokenOut,
          encodeFunctionData({
            abi: tokenAbi,
            functionName: "transfer",
            args: [r as Hex, 3000n],
          }),
        )
      ).execResult.exceptionError,
    ).toBeUndefined();
  const read = async (
    token: string,
    fn: "balanceOf" | "allowance",
    args: Hex[],
  ) => {
    const r = await run(
      DEPLOYER,
      token,
      encodeFunctionData({
        abi: tokenAbi,
        functionName: fn,
        args: args as never,
      }),
    );
    return decodeFunctionResult({
      abi: tokenAbi,
      functionName: fn,
      data: bytesToHex(r.execResult.returnValue) as Hex,
    }) as bigint;
  };
  /** eth_call-like simulation of (approval?, main call) from ACCOUNT: deltas and transfers, then the state is reverted. */
  const simulate = async (plan: ExecutionPlan, approvalData?: Hex) => {
    const payBefore = await read(tokenIn, "balanceOf", [ACCOUNT]);
    const recvBefore = await read(tokenOut, "balanceOf", [
      plan.recipient as Hex,
    ]);
    await vm.stateManager.checkpoint();
    try {
      let success = true;
      const logs: Uint8Array[][] = [];
      const ap = approvalData
        ? { to: plan.pay.address, data: approvalData }
        : approvalTransaction(plan);
      for (const step of [ap, plan.transaction].filter(Boolean) as {
        to: string;
        data: string;
      }[]) {
        const r = await run(ACCOUNT, step.to, step.data as Hex);
        if (r.execResult.exceptionError) success = false;
        for (const l of r.execResult.logs ?? [])
          logs.push([l[0], ...(l[1] as Uint8Array[]), l[2]]);
      }
      const payAfter = await read(tokenIn, "balanceOf", [ACCOUNT]);
      const recvAfter = await read(tokenOut, "balanceOf", [
        plan.recipient as Hex,
      ]);
      // Read for the plan's own token spender, with or without an approval in the plan (review round 4, S3).
      const allowanceAfter = plan.spender
        ? await read(tokenIn, "allowance", [ACCOUNT, plan.spender as Hex])
        : 0n;
      const outflows = logs.filter(
        (l) =>
          bytesToHex(l[1]) === TRANSFER &&
          bytesToHex(l[2]) === pad(ACCOUNT as Hex).toLowerCase(),
      );
      const planned = outflows.some(
        (l) => BigInt(bytesToHex(l[l.length - 1])) === BigInt(plan.amountIn),
      )
        ? 1
        : 0;
      return {
        success,
        block: "1",
        payDelta: String(payAfter - payBefore),
        receiveDelta: String(recvAfter - recvBefore),
        unexpectedOutflows: outflows.length - planned,
        allowanceAfter: String(allowanceAfter),
      };
    } finally {
      await vm.stateManager.revert();
    }
  };
  return { routers, tokenIn, tokenOut, read, simulate };
}
type World = Awaited<ReturnType<typeof world>>;
function swapPlan(
  w: World,
  router: string,
  over: Partial<ExecutionPlan> = {},
): ExecutionPlan {
  const now = 1_800_000_000_000;
  return {
    version: EXECUTION_POLICY.version,
    kind: "EVM_SWAP",
    provider: "aerodrome",
    tool: "synthetic-router",
    quoteId: "q-evm",
    quotedAt: now - 1000,
    expiresAt: now + 25000,
    executable: true,
    account: ACCOUNT,
    sourceChainId: "31337",
    destinationChainId: "31337",
    pay: {
      chainId: "31337",
      address: w.tokenIn,
      symbol: "TIN",
      decimals: 6,
      native: false,
    },
    receive: {
      chainId: "31337",
      address: w.tokenOut,
      symbol: "TOUT",
      decimals: 18,
      native: false,
    },
    amountIn: "5000000",
    expectedOut: "1000",
    minimumOut: "990",
    recipient: ACCOUNT,
    refundTo: null,
    slippageBps: 100,
    platformFeeBps: 0,
    fees: [],
    spender: router,
    approval: { token: w.tokenIn, spender: router, amount: "5000000" },
    transaction: {
      chainId: "31337",
      from: ACCOUNT,
      to: router,
      value: "0",
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: "swap",
        args: [w.tokenIn as Hex, w.tokenOut as Hex, 5_000_000n, 1000n, ACCOUNT],
      }),
    },
    ...over,
  };
}
const facts = (simulation: PreflightFacts["simulation"]): PreflightFacts => ({
  now: 1_800_000_000_000,
  wallet: { account: ACCOUNT, chainId: "31337", proven: true },
  evidence: { pay: null, receive: null },
  balances: { pay: "9000000", native: "1", agreement: "AGREE" },
  allowance: "0",
  allowanceSpender: null,
  gas: { limit: null, maxFeePerGas: null },
  inputUsd: null,
  simulation,
  guardian: null,
  supportedDestinations: [],
});
// The harness reads both allowances for the plan's own spender (simulate() above), so the facts name that spender.
const check = (p: ExecutionPlan, f: PreflightFacts, id: string) =>
  preflight(p, {
    ...f,
    allowanceSpender: f.allowanceSpender ?? p.spender,
  }).checks.find((c) => c.id === id)!;

describe("G13-EVM simulation of the exact calldata in an isolated EVM", () => {
  it("E1 a fair router with an exact approval: the simulated deltas match the plan, the state is never committed", async () => {
    const w = await world();
    const p = swapPlan(w, w.routers.fair);
    const sim = await w.simulate(p);
    expect(sim).toMatchObject({
      success: true,
      payDelta: "-5000000",
      receiveDelta: "1000",
      unexpectedOutflows: 0,
      allowanceAfter: "0",
    });
    expect(check(p, facts(sim), "SIMULATION")).toMatchObject({
      status: "PASS",
    });
    expect(check(p, facts(sim), "RECIPIENT")).toMatchObject({ status: "PASS" });
    // Review F03: the router's own on-chain minimum is not decoded yet, so the amounts are never PASS for a swap.
    expect(check(p, facts(sim), "AMOUNTS")).toMatchObject({
      status: "UNKNOWN",
      code: "SWAP_MINIMUM_NOT_DECODED",
    });
    // Unknown contract: identity fails even though the simulation looks fine (a working contract is not a reviewed one).
    expect(check(p, facts(sim), "PROVIDER")).toMatchObject({
      status: "FAIL",
      code: "UNEXPECTED_TARGET_CONTRACT",
    });
    expect(await w.read(w.tokenIn, "balanceOf", [ACCOUNT])).toBe(9_000_000n);
    expect(
      await w.read(w.tokenIn, "allowance", [ACCOUNT, w.routers.fair as Hex]),
    ).toBe(0n);
  });
  it("E2 a greedy router is held to the exact approval; with an unlimited approval it drains the balance and is refused", async () => {
    const w = await world();
    const p = swapPlan(w, w.routers.greedy);
    const exact = await w.simulate(p);
    expect(exact.payDelta).toBe("-5000000");
    expect(check(p, facts(exact), "SIMULATION").status).toBe("PASS");
    const unlimited = await w.simulate(
      { ...p, approval: { ...p.approval!, amount: MAX_UINT256.toString() } },
      encodeFunctionData({
        abi: tokenAbi,
        functionName: "approve",
        args: [w.routers.greedy as Hex, MAX_UINT256],
      }),
    );
    expect(unlimited.payDelta).toBe("-9000000");
    const pu = {
      ...p,
      approval: { ...p.approval!, amount: MAX_UINT256.toString() },
    };
    expect(check(pu, facts(unlimited), "SIMULATION")).toMatchObject({
      status: "FAIL",
      code: "SIMULATED_INPUT_MISMATCH",
    });
    expect(check(pu, facts(unlimited), "APPROVAL")).toMatchObject({
      status: "FAIL",
      // The in-memory router is not a reviewed spender either; unit test X4 covers UNLIMITED_APPROVAL for a reviewed one.
      code: "UNEXPECTED_SPENDER",
    });
  });
  it("E3 a router that keeps the output: wrong recipient and output below minimum", async () => {
    const w = await world();
    const p = swapPlan(w, w.routers.redirect);
    const sim = await w.simulate(p);
    expect(sim.receiveDelta).toBe("0");
    expect(check(p, facts(sim), "RECIPIENT")).toMatchObject({
      status: "FAIL",
      code: "WRONG_RECIPIENT",
    });
    expect(check(p, facts(sim), "SIMULATION")).toMatchObject({
      status: "FAIL",
      code: "SIMULATED_OUTPUT_BELOW_MINIMUM",
    });
  });
  it("E4 an approval one unit short makes the call revert: SIMULATION_REVERTED, nothing moved", async () => {
    const w = await world();
    const p = swapPlan(w, w.routers.fair);
    const sim = await w.simulate(
      p,
      encodeFunctionData({
        abi: tokenAbi,
        functionName: "approve",
        args: [w.routers.fair as Hex, 4_999_999n],
      }),
    );
    expect(sim.success).toBe(false);
    expect(check(p, facts(sim), "SIMULATION")).toMatchObject({
      status: "FAIL",
      code: "SIMULATION_REVERTED",
    });
    expect(await w.read(w.tokenIn, "balanceOf", [ACCOUNT])).toBe(9_000_000n);
  });
});
