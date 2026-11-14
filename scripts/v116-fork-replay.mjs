// Deterministic, no-egress local execution of accepted pinned-fork calldata and cached public state.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createVM } from "@ethereumjs/vm";
import { createCustomCommon, Mainnet, Hardfork } from "@ethereumjs/common";
import {
  createAccount,
  createAddressFromString,
  hexToBytes,
  bytesToHex,
} from "@ethereumjs/util";
import {
  keccak256,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
} from "viem";
import { buildEvm, decodeEvm } from "../src/swap/server/evm.ts";
import { routerPin } from "../src/swap/server/config.ts";
import { digest } from "../src/swap/server/digest.ts";
const require = createRequire(import.meta.url),
  r = createRequire(require.resolve("@ethereumjs/vm")),
  { RPCStateManager } = r("@ethereumjs/statemanager"),
  { createBlock } = r("@ethereumjs/block");
const root = "tests/fixtures/v116-fork",
  out = process.argv[2];
if (!out) throw Error("NEW_EVIDENCE_ROOT_REQUIRED");
mkdirSync(out, { recursive: true });
const manifest = JSON.parse(readFileSync(root + "/manifest.json"));
const { createHash } = await import("node:crypto");
for (const [p, h] of Object.entries(manifest.hashes))
  if (
    createHash("sha256")
      .update(readFileSync(root + "/" + p))
      .digest("hex") !== h
  )
    throw Error("FIXTURE_DRIFT");
let cache,
  tag,
  cacheMisses = 0,
  reads = 0;
const rpc = async (method, params) => {
  const key = JSON.stringify([method, params]),
    v = cache[key];
  reads++;
  if (!v) {
    cacheMisses++;
    throw Error("OFFLINE_STATE_MISSING:" + method);
  }
  if (v.error) throw Error("RECORDED_RPC_ERROR");
  return v.result;
};
globalThis.fetch = async (_url, init) => {
  const b = JSON.parse(init.body),
    v = await rpc(b.method, b.params);
  return Response.json({ jsonrpc: "2.0", id: b.id, result: v });
};
class State extends RPCStateManager {
  async getAccountFromProvider(address) {
    const a = address.toString(),
      [balance, nonce, code] = await Promise.all([
        rpc("eth_getBalance", [a, tag]),
        rpc("eth_getTransactionCount", [a, tag]),
        rpc("eth_getCode", [a, tag]),
      ]);
    return createAccount({
      balance: BigInt(balance),
      nonce: BigInt(nonce),
      codeHash: hexToBytes(keccak256(code)),
    });
  }
}
const abi = parseAbi([
  "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
]);
const sets = [
    "nativeout16",
    "standard18",
    "exactout17",
    "matrix13",
    "matrix15",
    "matrix12",
    "slipmulti19",
    "slipnativeexact20",
    "aerostable21",
    "ethereum22",
    "mixedv423",
  ],
  results = [];
for (const name of sets) {
  let records;
  try {
    records = JSON.parse(
      readFileSync(root + "/" + name + "/latest-results.json"),
    );
  } catch {
    throw Error("MISSING_REQUIRED_REPLAY_SET:" + name);
  }
  for (const record of records.filter((x) => x.status === "PASS")) {
    const startMiss = cacheMisses;
    try {
      tag = record.block;
      cache = JSON.parse(
        readFileSync(`${root}/${name}/${record.chain}-state.json`),
      );
      const header = JSON.parse(
        readFileSync(`${root}/${name}/${record.chain}-pin.json`),
      );
      const i = { ...record.intent, amount: BigInt(record.intent.amount) },
        q = {
          ...record.quote,
          amountIn: BigInt(record.quote.amountIn),
          amountOut: BigInt(record.quote.amountOut),
          minAmountOut: BigInt(record.quote.minAmountOut),
          maxAmountIn: BigInt(record.quote.maxAmountIn),
          costs: record.quote.costs.map((c) => ({
            ...c,
            amount: c.amount === null ? null : BigInt(c.amount),
            usdMicros: c.usdMicros === null ? null : BigInt(c.usdMicros),
          })),
          route: record.quote.route.map((l) => ({
            ...l,
            ...(l.amountIn ? { amountIn: BigInt(l.amountIn) } : {}),
            ...(l.amountOut ? { amountOut: BigInt(l.amountOut) } : {}),
          })),
        };
      const tx = buildEvm(q, i);
      if (digest(tx) !== record.transactionDigest)
        throw Error("CALLDATA_DRIFT");
      decodeEvm(tx, q, i, record.simulationTimestamp);
      const common = createCustomCommon({ chainId: Number(i.chain) }, Mainnet, {
          hardfork: Hardfork.Cancun,
        }),
        state = new State({
          provider: "https://offline.invalid",
          blockTag: BigInt(tag),
          common,
        }),
        vm = await createVM({ common, stateManager: state }),
        caller = createAddressFromString(i.taker);
      await state.putAccount(
        caller,
        createAccount({ nonce: 0n, balance: 10n ** 22n }),
      );
      const block = createBlock(
        {
          header: {
            number: BigInt(tag),
            timestamp: BigInt(Math.floor(record.simulationTimestamp / 1000)),
            gasLimit: 100000000n,
            baseFeePerGas: BigInt(header.baseFeePerGas ?? "0x0"),
          },
        },
        { common },
      );
      const call = async (to, data, value = 0n) =>
        vm.evm.runCall({
          caller,
          origin: caller,
          to: createAddressFromString(to),
          data: hexToBytes(data),
          value,
          gasLimit: 15000000n,
          block,
        });
      for (const fund of record.localFundingSteps ?? []) {
        const t = fund.transaction,
          f = await call(t.to, t.data, BigInt(t.value));
        if (f.execResult.exceptionError)
          throw Error("LOCAL_FUND_REPLAY_FAILED");
      }
      if (!i.tokenIn.native) {
        if (!record.localFundingSteps?.length)
          throw Error("FUNDING_RECEIPT_MISSING");
        const pin = routerPin(q.mode, i.chain);
        let f = await call(
          i.tokenIn.address,
          encodeFunctionData({
            abi,
            functionName: "approve",
            args: [pin.permit2 ?? pin.address, q.maxAmountIn],
          }),
        );
        if (f.execResult.exceptionError) throw Error("LOCAL_APPROVAL_FAILED");
        if (pin.permit2) {
          f = await call(
            pin.permit2,
            encodeFunctionData({
              abi: parseAbi([
                "function approve(address,address,uint160,uint48)",
              ]),
              functionName: "approve",
              args: [
                i.tokenIn.address,
                pin.address,
                q.maxAmountIn,
                Math.floor(q.expiresAt / 1000),
              ],
            }),
          );
          if (f.execResult.exceptionError) throw Error("LOCAL_PERMIT_FAILED");
        }
      }
      const balance = async (token, owner) => {
        const f = await call(
          token,
          encodeFunctionData({ abi, functionName: "balanceOf", args: [owner] }),
        );
        if (f.execResult.exceptionError) throw Error("BALANCE_FAILED");
        return decodeFunctionResult({
          abi,
          functionName: "balanceOf",
          data: bytesToHex(f.execResult.returnValue),
        });
      };
      const inputBalance = () =>
          i.tokenIn.native
            ? state.getAccount(caller).then((a) => a.balance)
            : balance(i.tokenIn.address, i.taker),
        outputBalance = () =>
          i.tokenOut.native
            ? state
                .getAccount(createAddressFromString(i.recipient))
                .then((a) => a.balance)
            : balance(i.tokenOut.address, i.recipient);
      const beforeIn = await inputBalance(),
        beforeOut = await outputBalance(),
        f = await call(tx.to, tx.data, BigInt(tx.value));
      if (f.execResult.exceptionError) throw Error("EVM_REVERT");
      const input = beforeIn - (await inputBalance()),
        output = (await outputBalance()) - beforeOut;
      if (
        input.toString() !== record.input ||
        output.toString() !== record.output ||
        output < q.minAmountOut ||
        (i.kind === "EXACT_IN" ? input !== i.amount : input > q.maxAmountIn)
      )
        throw Error("BALANCE_DRIFT");
      results.push({
        run: name,
        chain: i.chain,
        family: record.family,
        status: "PASS",
        input: input.toString(),
        output: output.toString(),
        transactionDigest: record.transactionDigest,
        sourceBlockHash: record.sourceBlockHash,
        cacheMisses: cacheMisses - startMiss,
        publicWrites: 0,
        networkRequests: 0,
      });
    } catch (e) {
      results.push({
        run: name,
        family: record.family,
        status: "FAIL",
        error: e.message,
        cacheMisses: cacheMisses - startMiss,
        networkRequests: 0,
      });
    }
  }
}
const pass =
  results.length === manifest.expected &&
  results.length > 0 &&
  cacheMisses === 0 &&
  results.every((r) => r.status === "PASS");
const report = {
  pass,
  expected: manifest.expected,
  at: new Date().toISOString(),
  method: "NO_EGRESS_PINNED_LOCAL_VM_REPLAY",
  results,
  reads,
  cacheMisses,
  publicWrites: 0,
  networkRequests: 0,
};
writeFileSync(out + "/results.json", JSON.stringify(report, null, 2));
console.log(
  results
    .map(
      (r) => `${r.run} ${r.family} ${r.status}${r.error ? " " + r.error : ""}`,
    )
    .join("\n"),
);
if (!pass) process.exitCode = 1;
