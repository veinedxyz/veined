import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { identity, SwapError, type SwapIntent, type SwapQuote } from "../model";
import { rpc } from "./transport";
import { digest } from "./digest";
import type { EvmBuild } from "./provider";
const balanceAbi = parseAbi([
  "function balanceOf(address) view returns(uint256)",
]);
const TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
type Log = { address: string; topics: string[]; data: string };
type CallResult = {
  status: string;
  returnData: string;
  gasUsed: string;
  logs: Log[];
  error?: unknown;
};
function fail(): never {
  throw new SwapError("SIMULATION_FAILED");
}
/** One read-only stateful simulation, with balance reads before/after the exact reviewed calldata. No state overrides. */
export async function simulateEvmEconomic(
  build: EvmBuild,
  i: SwapIntent,
  q: SwapQuote,
  signal: AbortSignal,
  verifiedBlock?: string,
) {
  const chain = await rpc(i.chain, "eth_chainId", [], signal);
  if (typeof chain !== "string" || BigInt(chain) !== BigInt(i.chain)) fail();
  const block =
    verifiedBlock ?? (await rpc(i.chain, "eth_blockNumber", [], signal));
  if (typeof block !== "string" || !/^0x[0-9a-f]{1,16}$/i.test(block)) fail();
  const balances = [
    ...[
      i.tokenIn.native ? null : { token: i.tokenIn.address, owner: i.taker },
      i.tokenOut.native
        ? null
        : { token: i.tokenOut.address, owner: i.recipient },
    ].filter((x) => x !== null),
  ];
  const reads = balances.map((b) => ({
    from: i.taker,
    to: b.token,
    data: encodeFunctionData({
      abi: balanceAbi,
      functionName: "balanceOf",
      args: [b.owner as Hex],
    }),
    gas: "0x186a0",
    gasPrice: "0x0",
  }));
  const calls = [
    ...reads,
    {
      from: build.from,
      to: build.to,
      data: build.data,
      value: `0x${BigInt(build.value).toString(16)}`,
      gas: "0xe4e1c0",
      gasPrice: "0x0",
    },
    ...reads,
  ];
  const result = (await rpc(
    i.chain,
    "eth_simulateV1",
    [
      {
        blockStateCalls: [{ calls }],
        traceTransfers: true,
        validation: false,
        returnFullTransactions: false,
      },
      block,
    ],
    signal,
  )) as { number?: string; calls?: CallResult[] }[];
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    !result[0].calls ||
    result[0].calls.length !== calls.length
  )
    fail();
  const out = result[0].calls;
  if (
    out.some(
      (c) =>
        c.status !== "0x1" ||
        c.error ||
        !Array.isArray(c.logs) ||
        c.logs.length > 2048 ||
        !/^0x[0-9a-f]*$/i.test(c.returnData),
    )
  )
    fail();
  const swap = out[reads.length],
    delta = (token: string) => {
      const n = balances.findIndex(
        (b) => identity(b.token) === identity(token),
      );
      if (
        n < 0 ||
        !/^0x[0-9a-f]{64}$/i.test(out[n].returnData) ||
        !/^0x[0-9a-f]{64}$/i.test(out[reads.length + 1 + n].returnData)
      )
        fail();
      return (
        BigInt(out[reads.length + 1 + n].returnData) - BigInt(out[n].returnData)
      );
    };
  let nativeIn = 0n,
    nativeOut = 0n;
  for (const log of swap.logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER) continue;
    if (
      log.topics.length !== 3 ||
      !/^0x[0-9a-f]{64}$/i.test(log.data) ||
      log.topics.slice(1).some((t) => !/^0x0{24}[0-9a-f]{40}$/i.test(t))
    )
      fail();
    const from = identity(`0x${log.topics[1].slice(-40)}`),
      to = identity(`0x${log.topics[2].slice(-40)}`),
      token = identity(log.address),
      amount = BigInt(log.data);
    if (token === NATIVE) {
      if (from === identity(i.taker)) nativeIn += amount;
      if (to === identity(i.taker)) nativeIn -= amount;
      if (to === identity(i.recipient)) nativeOut += amount;
      if (from === identity(i.recipient)) nativeOut -= amount;
    } else if (from === identity(i.taker) || from === identity(i.recipient)) {
      if (token !== identity(i.tokenIn.address) || from !== identity(i.taker))
        fail();
    }
  }
  const input = i.tokenIn.native ? nativeIn : -delta(i.tokenIn.address),
    output = i.tokenOut.native ? nativeOut : delta(i.tokenOut.address);
  if (
    input <= 0n ||
    input > q.maxAmountIn ||
    output < q.minAmountOut ||
    (i.kind === "EXACT_IN" && input !== i.amount) ||
    (i.kind === "EXACT_OUT" && output !== i.amount) ||
    (!i.tokenIn.native &&
      !i.tokenOut.native &&
      (nativeIn !== 0n || nativeOut !== 0n))
  )
    fail();
  if (!/^0x[0-9a-f]+$/i.test(swap.gasUsed) || BigInt(swap.gasUsed) === 0n)
    fail();
  return {
    status: "PASSED" as const,
    transactionDigest: digest(build),
    chain: i.chain,
    source: BigInt(block).toString(),
    at: Date.now(),
    gasOrCompute: BigInt(swap.gasUsed).toString(),
    logs: [],
    tokenDeltas: {
      input: input.toString(),
      output: output.toString(),
      networkFee: "ESTIMATE_REQUIRED",
      signatureValidity: "NOT_ASSERTED" as const,
    },
    method: "eth_simulateV1",
    stateOverrides: false,
  };
}
