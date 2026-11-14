import {
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
  type AbiParameter,
} from "viem";
import {
  identity,
  SwapError,
  ZERO,
  type RouteLeg,
  type SwapIntent,
  type SwapQuote,
} from "../model";
import { PINS } from "./config";

export const ROUTER = "0x0000000000000000000000000000000000000002" as Address;
const BALANCE = 1n << 255n;
const v2 = parseAbiParameters("address,uint256,uint256,address[],bool");
const v3 = parseAbiParameters("address,uint256,uint256,bytes,bool");
const v2Current = parseAbiParameters(
  "address,uint256,uint256,address[],bool,uint256[]",
);
const v3Current = parseAbiParameters(
  "address,uint256,uint256,bytes,bool,uint256[]",
);
const wrap = parseAbiParameters("address,uint256");
const nested = parseAbiParameters("bytes,bytes[]");
const settle = parseAbiParameters("address,uint256,bool");
const take = parseAbiParameters("address,address,uint256");
export const v4Key = parseAbiParameters(
  "address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks",
);
export const infinityKey = parseAbiParameters(
  "address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters",
);
const v4Single = parseAbiParameters(
  "((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amount,uint128 bound,uint256 minHopPriceX36,bytes hookData)",
);
const infinitySingle = parseAbiParameters(
  "((address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters) poolKey,bool zeroForOne,uint128 amount,uint128 bound,bytes hookData)",
);
export const INFINITY = Object.freeze({
  cl: "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b",
  bin: "0xC697d2898e0D09264376196696c51D7aBbbAA4a9",
  vault: "0x238a358808379702088667322f80aC48bAd5e6c4",
});
function reject(): never {
  throw new SwapError("BUILD_REVIEW_REQUIRED");
}
const same = (a: string, b: string) => identity(a) === identity(b);
const address = (a: string): Address => {
  if (!/^0x[0-9a-f]{40}$/i.test(a)) reject();
  return a as Address;
};
const encode = (p: readonly AbiParameter[], v: readonly unknown[]) =>
  encodeAbiParameters(p, v);
const hex = (xs: number[]) =>
  `0x${xs.map((x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
function packedPath(legs: RouteLeg[], reverse: boolean) {
  const tokens = [legs[0].tokenIn, ...legs.map((l) => l.tokenOut)],
    fees = legs.map((l) => {
      if (!Number.isInteger(l.fee) || l.fee! <= 0 || l.fee! >= 1_000_000)
        reject();
      return l.fee!;
    });
  if (reverse) {
    tokens.reverse();
    fees.reverse();
  }
  return `0x${tokens.map((t, n) => address(t).slice(2).toLowerCase() + (n < fees.length ? fees[n].toString(16).padStart(6, "0") : "")).join("")}` as Hex;
}
/** Keys are semantic identities, not provider-selected arbitrary contracts. Unknown hook/dynamic-fee behavior is closed. */
export function reviewedPoolKey(
  l: RouteLeg,
  mode: SwapQuote["mode"],
  chain: string,
) {
  const [currency0, currency1] = [address(l.tokenIn), address(l.tokenOut)].sort(
    (a, b) => a.toLowerCase().localeCompare(b.toLowerCase()),
  );
  if (
    same(currency0, currency1) ||
    !Number.isInteger(l.fee) ||
    l.fee! < 0 ||
    l.fee! >= 1_000_000 ||
    !l.hook ||
    !same(l.hook, ZERO)
  )
    reject();
  if (l.poolType === "V4" && mode === "UNISWAP") {
    if (!l.tickSpacing || l.tickSpacing > 32767) reject();
    const key = {
      currency0,
      currency1,
      fee: l.fee!,
      tickSpacing: l.tickSpacing,
      hooks: address(l.hook),
    };
    const id = keccak256(
      encodeAbiParameters(v4Key, [
        currency0,
        currency1,
        key.fee,
        key.tickSpacing,
        key.hooks,
      ]),
    );
    if (l.pool.toLowerCase() !== id) reject();
    return { kind: "V4" as const, key, id };
  }
  if (
    mode !== "PANCAKESWAP_SMART" ||
    !["56", "8453"].includes(chain) ||
    !["INFINITY_CL", "INFINITY_BIN"].includes(l.poolType) ||
    !l.parameters
  )
    reject();
  const manager = l.poolType === "INFINITY_CL" ? INFINITY.cl : INFINITY.bin;
  if (!same(l.factory ?? "", manager)) reject();
  const bits = BigInt(l.parameters),
    spacing = bits >> 16n;
  // No hook bitmap or reserved parameter bits. Only current static spacing layout.
  if (
    (bits & 65535n) !== 0n ||
    spacing <= 0n ||
    spacing > (l.poolType === "INFINITY_CL" ? 32767n : 10000n)
  )
    reject();
  const key = {
    currency0,
    currency1,
    hooks: address(l.hook),
    poolManager: address(manager),
    fee: l.fee!,
    parameters: l.parameters as Hex,
  };
  const id = keccak256(
    encodeAbiParameters(infinityKey, [
      currency0,
      currency1,
      key.hooks,
      key.poolManager,
      key.fee,
      key.parameters,
    ]),
  );
  if (l.pool.toLowerCase() !== id) reject();
  return { kind: l.poolType, key, id };
}
export function branches(q: SwapQuote, i: SwapIntent) {
  if (
    q.route.length === 0 ||
    q.route.length > 32 ||
    q.splitCount < 1 ||
    q.splitCount > 8
  )
    reject();
  const out: Array<{
    legs: RouteLeg[];
    amountIn: bigint;
    amountOut: bigint;
    minOut: bigint;
    maxIn: bigint;
  }> = [];
  let inSum = 0n,
    outSum = 0n,
    shareSum = 0,
    minSum = 0n,
    maxSum = 0n;
  const wrapToken = (side: "tokenIn" | "tokenOut") =>
    i[side].native
      ? PINS[i.chain as keyof typeof PINS].wrapper
      : i[side].address;
  for (let b = 0; b < q.splitCount; b++) {
    const legs = q.route.filter(
      (l) => (l.branch ?? (q.splitCount === 1 ? 0 : -1)) === b,
    );
    if (!legs.length || legs.length > 4) reject();
    const first = legs[0],
      last = legs.at(-1)!;
    const inputOK =
      same(first.tokenIn, wrapToken("tokenIn")) ||
      (i.tokenIn.native &&
        same(first.tokenIn, ZERO) &&
        ["V4", "INFINITY_CL", "INFINITY_BIN"].includes(first.poolType));
    const outputOK =
      same(last.tokenOut, wrapToken("tokenOut")) ||
      (i.tokenOut.native &&
        same(last.tokenOut, ZERO) &&
        ["V4", "INFINITY_CL", "INFINITY_BIN"].includes(last.poolType));
    if (
      !inputOK ||
      !outputOK ||
      legs.some((l) => l.shareBps !== first.shareBps) ||
      legs.some((l, n) => n > 0 && !same(legs[n - 1].tokenOut, l.tokenIn))
    )
      reject();
    const tokens = [first.tokenIn, ...legs.map((l) => l.tokenOut)];
    if (new Set(tokens.map(identity)).size !== tokens.length) reject();
    const amountIn = q.splitCount === 1 ? q.amountIn : first.amountIn,
      amountOut = q.splitCount === 1 ? q.amountOut : last.amountOut;
    if (!amountIn || !amountOut) reject();
    const minOut =
      b === q.splitCount - 1
        ? q.minAmountOut - minSum
        : (q.minAmountOut * amountOut) / q.amountOut;
    const maxIn =
      b === q.splitCount - 1
        ? q.maxAmountIn - maxSum
        : (q.maxAmountIn * amountIn) / q.amountIn;
    if (minOut <= 0n || minOut > amountOut || maxIn < amountIn) reject();
    inSum += amountIn;
    outSum += amountOut;
    shareSum += first.shareBps;
    minSum += minOut;
    maxSum += maxIn;
    out.push({ legs, amountIn, amountOut, minOut, maxIn });
  }
  if (
    out.flatMap((b) => b.legs).length !== q.route.length ||
    inSum !== q.amountIn ||
    outSum !== q.amountOut ||
    shareSum !== 10000
  )
    reject();
  return out;
}
/** Source-pinned command planner. Every branch has an explicit input allocation and aggregate output bound. */
export function planUniversal(q: SwapQuote, i: SwapIntent) {
  const commands: number[] = [],
    inputs: Hex[] = [];
  const add = (
    c: number,
    p: readonly AbiParameter[],
    v: readonly unknown[],
  ) => {
    commands.push(c);
    inputs.push(encode(p, v));
  };
  const uni = q.mode === "UNISWAP",
    exact = i.kind === "EXACT_IN";
  if (!uni && q.mode !== "PANCAKESWAP_SMART") reject();
  if (!exact && (i.tokenIn.native || i.tokenOut.native)) reject();
  for (const branch of branches(q, i)) {
    const { legs } = branch,
      first = legs[0],
      last = legs.at(-1)!;
    const nativeIn = i.tokenIn.native && same(first.tokenIn, ZERO),
      nativeOut = i.tokenOut.native && same(last.tokenOut, ZERO);
    if (i.tokenIn.native && !nativeIn) add(11, wrap, [ROUTER, branch.amountIn]);
    const groups: RouteLeg[][] = [];
    for (const l of legs) {
      const prev = groups.at(-1);
      if (prev && prev[0].poolType === l.poolType) prev.push(l);
      else groups.push([l]);
    }
    if (!exact && groups.length !== 1) reject();
    for (let g = 0; g < groups.length; g++) {
      const path = groups[g],
        type = path[0].poolType,
        initial = g === 0,
        final = g === groups.length - 1;
      const recipient =
        final && (!i.tokenOut.native || nativeOut)
          ? address(i.recipient)
          : ROUTER;
      const amount = exact
          ? initial
            ? branch.amountIn
            : BALANCE
          : branch.amountOut,
        bound = exact ? (final ? branch.minOut : 0n) : branch.maxIn;
      if (type === "V2" || type === "V3") {
        if (path.some((l) => l.hook && !same(l.hook, ZERO))) reject();
        const params =
          type === "V2" ? (uni ? v2Current : v2) : uni ? v3Current : v3;
        const encodedPath =
          type === "V2"
            ? [
                address(path[0].tokenIn),
                ...path.map((l) => address(l.tokenOut)),
              ]
            : packedPath(path, !exact);
        const values = [
          recipient,
          amount,
          bound,
          encodedPath,
          initial && !i.tokenIn.native,
        ];
        if (uni) values.push([] as never);
        add(type === "V2" ? (exact ? 8 : 9) : exact ? 0 : 1, params, values);
      } else {
        const actions: number[] = [],
          params: Hex[] = [];
        const act = (
          c: number,
          p: readonly AbiParameter[],
          v: readonly unknown[],
        ) => {
          actions.push(c);
          params.push(encode(p, v));
        };
        // Pay before exact-input swaps: OPEN_DELTA then consumes only this unlock's credit.
        if (exact)
          act(11, settle, [
            address(path[0].tokenIn),
            initial ? branch.amountIn : BALANCE,
            initial && !i.tokenIn.native,
          ]);
        const ordered = exact ? path : [...path].reverse();
        for (let n = 0; n < ordered.length; n++) {
          const l = ordered[n],
            k = reviewedPoolKey(l, q.mode, i.chain);
          const amt = exact ? 0n : n === 0 ? branch.amountOut : 0n,
            limit = exact
              ? n === ordered.length - 1
                ? bound
                : 0n
              : n === ordered.length - 1
                ? bound
                : (1n << 128n) - 1n;
          if (amt >= 1n << 128n || limit >= 1n << 128n) reject();
          const values = {
            poolKey: k.key,
            zeroForOne: same(l.tokenIn, k.key.currency0),
            amount: amt,
            bound: limit,
            hookData: "0x",
            ...(k.kind === "V4" ? { minHopPriceX36: 0n } : {}),
          };
          act(
            k.kind === "INFINITY_BIN" ? (exact ? 28 : 30) : exact ? 6 : 8,
            k.kind === "V4" ? v4Single : infinitySingle,
            [values],
          );
        }
        if (!exact) act(11, settle, [address(path[0].tokenIn), 0n, true]);
        act(14, take, [address(path.at(-1)!.tokenOut), recipient, 0n]);
        add(16, nested, [hex(actions), params]);
      }
    }
    if (i.tokenOut.native && !nativeOut)
      add(12, wrap, [address(i.recipient), branch.minOut]);
  }
  if (commands.length > 64) reject();
  return { commands: hex(commands), inputs };
}
/** Decode every nested action before canonical route/build equality; reject flags/subplans/unknown actions. */
export function inspectCommands(
  cmds: Hex,
  inputs: readonly Hex[],
  q: SwapQuote,
) {
  const commands = [...Buffer.from(cmds.slice(2), "hex")];
  if (
    commands.length !== inputs.length ||
    !commands.length ||
    commands.length > 64
  )
    reject();
  const canonicalDecode = (p: readonly AbiParameter[], data: Hex) => {
    const d = decodeAbiParameters(p, data);
    if (encode(p, d) !== data.toLowerCase()) reject();
    return d;
  };
  for (let n = 0; n < commands.length; n++) {
    const c = commands[n],
      uni = q.mode === "UNISWAP";
    if (c === 16) {
      const [raw, values] = decodeAbiParameters(nested, inputs[n]);
      canonicalDecode(nested, inputs[n]);
      const acts = [...Buffer.from(raw.slice(2), "hex")];
      if (acts.length !== values.length || acts.length > 18) reject();
      for (let j = 0; j < acts.length; j++) {
        const a = acts[j],
          p =
            a === 11
              ? settle
              : a === 14
                ? take
                : [6, 8].includes(a)
                  ? uni
                    ? v4Single
                    : infinitySingle
                  : !uni && [28, 30].includes(a)
                    ? infinitySingle
                    : null;
        if (!p) reject();
        canonicalDecode(p, values[j]);
      }
    } else {
      const p =
        c === 8 || c === 9
          ? uni
            ? v2Current
            : v2
          : c === 0 || c === 1
            ? uni
              ? v3Current
              : v3
            : c === 11 || c === 12
              ? wrap
              : null;
      if (!p) reject();
      canonicalDecode(p, inputs[n]);
    }
  }
  return commands;
}
