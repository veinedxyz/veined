import { describe, expect, it } from "vitest";
import {
  decodeAbiParameters,
  decodeFunctionData,
  parseAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  type Address,
} from "viem";
import { buildEvm, decodeEvm, universalAbi } from "../../src/swap/server/evm";
import { v4Key, infinityKey, INFINITY } from "../../src/swap/server/universal";
import { ZERO, type RouteLeg } from "../../src/swap/model";
import { swapIntent, swapQuote } from "../fixtures/swap";

describe("V1151 current Universal Router encoding", () => {
  it.each(["V2", "V3"] as const)(
    "includes 2.1.2 per-hop price array in %s",
    (poolType) => {
      const i = swapIntent(),
        q = swapQuote(i);
      q.route[0].poolType = poolType;
      const tx = buildEvm(q, i);
      const d = decodeFunctionData({ abi: universalAbi, data: tx.data });
      const params =
        poolType === "V2"
          ? parseAbiParameters(
              "address,uint256,uint256,address[],bool,uint256[]",
            )
          : parseAbiParameters("address,uint256,uint256,bytes,bool,uint256[]");
      expect(decodeAbiParameters(params, d.args[1][1])[5]).toEqual([]);
    },
  );
});

function pool(type: "V4" | "INFINITY_CL" | "INFINITY_BIN") {
  const i = swapIntent();
  if (type !== "V4") {
    i.chain = "56";
    i.tokenIn.chain = "56";
    i.tokenOut.chain = "56";
  }
  const q = swapQuote(i, type === "V4" ? "UNISWAP" : "PANCAKESWAP_SMART");
  const l = q.route[0];
  l.poolType = type;
  l.hook = ZERO;
  l.tickSpacing = 10;
  const [a, b] = [l.tokenIn, l.tokenOut].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  ) as [Address, Address];
  if (type === "V4")
    l.pool = keccak256(encodeAbiParameters(v4Key, [a, b, l.fee!, 10, ZERO]));
  else {
    l.factory = type === "INFINITY_CL" ? INFINITY.cl : INFINITY.bin;
    l.parameters = `0x${(10n << 16n).toString(16).padStart(64, "0")}`;
    l.pool = keccak256(
      encodeAbiParameters(infinityKey, [
        a,
        b,
        ZERO,
        l.factory as Address,
        l.fee!,
        l.parameters as `0x${string}`,
      ]),
    );
  }
  return { i, q };
}
describe("V1151 nested action and branch firewall", () => {
  it.each(["V4", "INFINITY_CL", "INFINITY_BIN"] as const)(
    "decodes exact nested %s settlement, swap and take",
    (type) => {
      const { i, q } = pool(type),
        tx = buildEvm(q, i);
      expect(decodeEvm(tx, q, i).commands).toEqual([11, 16]);
      const d = decodeFunctionData({ abi: universalAbi, data: tx.data });
      const [actions] = decodeAbiParameters(
        parseAbiParameters("bytes,bytes[]"),
        d.args[1][1],
      );
      expect(actions).toBe(type === "INFINITY_BIN" ? "0x0b1c0e" : "0x0b060e");
    },
  );
  it.each(["V4", "INFINITY_CL", "INFINITY_BIN"] as const)(
    "rejects hostile %s nested bytes",
    (type) => {
      const { i, q } = pool(type),
        tx = buildEvm(q, i),
        d = decodeFunctionData({ abi: universalAbi, data: tx.data });
      const shape = parseAbiParameters("bytes,bytes[]"),
        [actions, params] = decodeAbiParameters(shape, d.args[1][1]);
      for (const mutation of [
        "0x0bff0e",
        "0x0b0605",
        "0x0b860e",
        actions + "21",
      ]) {
        const inputs = [...d.args[1]];
        inputs[1] = encodeAbiParameters(shape, [
          mutation as `0x${string}`,
          params,
        ]);
        const data = encodeFunctionData({
          abi: universalAbi,
          functionName: "execute",
          args: [d.args[0], inputs, d.args[2]],
        });
        expect(() => decodeEvm({ ...tx, data }, q, i)).toThrow();
      }
      for (const j of [0, 1, 2]) {
        const ps = [...params];
        ps[j] = (ps[j].slice(0, -2) + "01") as `0x${string}`;
        const inputs = [...d.args[1]];
        inputs[1] = encodeAbiParameters(shape, [actions, ps]);
        const data = encodeFunctionData({
          abi: universalAbi,
          functionName: "execute",
          args: [d.args[0], inputs, d.args[2]],
        });
        expect(() => decodeEvm({ ...tx, data }, q, i)).toThrow();
      }
    },
  );
  it.each(["pool", "hook", "fee", "tokenIn", "tokenOut", "tickSpacing"])(
    "rejects mutated v4 key %s",
    (field) => {
      const { i, q } = pool("V4");
      Object.assign(q.route[0], {
        [field]: ["fee", "tickSpacing"].includes(field)
          ? 999
          : "0x1111111111111111111111111111111111111111",
      });
      expect(() => buildEvm(q, i)).toThrow();
    },
  );
  it("proves two split allocations, rejecting hidden or missing branches", () => {
    const i = swapIntent(),
      q = swapQuote(i);
    q.splitCount = 2;
    q.hops = 1;
    q.route = [0, 1].map((branch) => ({
      ...q.route[0],
      branch,
      shareBps: 5000,
      amountIn: q.amountIn / 2n,
      amountOut: q.amountOut / 2n,
    }));
    expect(decodeEvm(buildEvm(q, i), q, i).commands).toEqual([11, 0, 11, 0]);
    for (const delta of [
      { branch: 2 },
      { shareBps: 4999 },
      { amountIn: q.amountIn },
      { amountOut: q.amountOut },
    ]) {
      const bad = structuredClone(q);
      Object.assign(bad.route[1], delta);
      expect(() => buildEvm(bad, i)).toThrow();
    }
  });
  it("binds V2-to-V3 mixed continuity and final recipient", () => {
    const i = swapIntent(),
      q = swapQuote(i),
      mid = "0x1111111111111111111111111111111111111111";
    q.route = [
      { ...q.route[0], poolType: "V2", tokenOut: mid },
      { ...q.route[0], tokenIn: mid },
    ] as RouteLeg[];
    q.hops = 2;
    expect(decodeEvm(buildEvm(q, i), q, i).commands).toEqual([11, 8, 0]);
    q.route[1].tokenIn = q.route[0].tokenIn;
    expect(() => buildEvm(q, i)).toThrow();
  });
});
