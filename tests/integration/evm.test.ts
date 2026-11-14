import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createVM } from "@ethereumjs/vm";
import { createCustomCommon, Mainnet, Hardfork } from "@ethereumjs/common";
import {
  createAddressFromString,
  hexToBytes,
  bytesToHex,
} from "@ethereumjs/util";
import { decodeEventLog, parseAbi } from "viem";
import solc from "solc";
import { prepare } from "../../src/adapters/onebridge";
import { NATIVE } from "../../src/core/model";
import { localQuote } from "../fixtures/local";
it("isolated unsigned in-memory EVM accepts exact native calldata and reverts padded msg.value", async () => {
  const source = await readFile("tests/fixtures/NativeBridge.sol", "utf8");
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "fixture.sol": { content: source } },
        settings: {
          evmVersion: "shanghai",
          outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } },
        },
      }),
    ),
  );
  expect(
    output.errors?.filter(
      (e: { severity: string }) => e.severity === "error",
    ) ?? [],
  ).toEqual([]);
  const code = hexToBytes(
    `0x${output.contracts["fixture.sol"].NativeBridgeFixture.evm.deployedBytecode.object}`,
  );
  const vm = await createVM({
    common: createCustomCommon({ chainId: 31337 }, Mainnet, {
      hardfork: Hardfork.Shanghai,
    }),
  });
  expect(vm.common.chainId()).toBe(31337n);
  const account = "0x3333333333333333333333333333333333333333";
  const quote = localQuote(account, "1.123456789123456789");
  const deployment = {
    mode: "local-test" as const,
    source: "0x1111111111111111111111111111111111111111",
    destination: "0x2222222222222222222222222222222222222222",
    verified: true,
    nativeSentinel: NATIVE,
    sourceChain: 31337,
    destinationChain: 31338,
    config: "1",
  };
  const unsigned = prepare(quote, deployment);
  const options = {
    code,
    data: hexToBytes(unsigned.data),
    value: unsigned.value,
    gasLimit: 1000000n,
    caller: createAddressFromString(account),
    address: createAddressFromString(deployment.source),
  };
  const result = await vm.evm.runCode(options);
  expect(result.exceptionError).toBeUndefined();
  expect(result.logs).toHaveLength(1);
  const log = result.logs![0];
  const decoded = decodeEventLog({
    abi: parseAbi([
      "event Initiated(uint256 indexed destinationChain,uint256 indexed index,address recipient,uint256 amount)",
    ]),
    data: bytesToHex(log[2]),
    topics: log[1].map(bytesToHex) as [`0x${string}`, ...`0x${string}`[]],
  });
  expect(decoded.args).toMatchObject({
    destinationChain: 31338n,
    index: 7n,
    recipient: account,
    amount: quote.amount,
  });
  const reverted = await vm.evm.runCode({
    ...options,
    value: unsigned.value + 1n,
  });
  expect(reverted.exceptionError?.error).toBe("revert");
  expect(reverted.logs ?? []).toHaveLength(0);
});
