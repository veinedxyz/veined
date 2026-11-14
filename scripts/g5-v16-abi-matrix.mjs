// V1.6 G5 §22-§23: selector matrix — live dispatcher selectors vs exact-build ABI, mutability, role guard
// (from the exact sources), and a read-only probe of every zero-argument view on the live proxy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  toFunctionSelector,
  toEventSelector,
  toFunctionSignature,
  encodeFunctionData,
  decodeFunctionResult,
} from "viem";
import { EVIDENCE, rpc, retry, now, writeJson } from "./g5-v16-lib.mjs";

const SIDES = {
  one: {
    url: "https://mainnet.crosstoken.io:22001",
    proxy: "0xb81d6e000000000000000000000000000000c0de",
  },
  bsc: {
    url: "https://bsc-dataseed.bnbchain.org",
    proxy: "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5",
  },
};
// Walk the runtime, skipping PUSH immediates; collect PUSH4 values that are followed by EQ (dispatcher compares).
function dispatcherSelectors(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  const out = new Set();
  for (let i = 0; i < b.length; i++) {
    const op = b[i];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n === 4 && b[i + 5] === 0x14)
        out.add("0x" + b.subarray(i + 1, i + 5).toString("hex"));
      i += n;
    }
  }
  return out;
}
const result = { at: now(), chains: {} };
for (const [chain, side] of Object.entries(SIDES)) {
  const rep = JSON.parse(
    readFileSync(join(EVIDENCE, "build", chain, "reproduction.json"), "utf8"),
  );
  const [[path, name]] = Object.entries(rep.compilationTarget);
  const out = JSON.parse(
    readFileSync(
      join(EVIDENCE, "build", chain, "standard-json-output-native.json"),
      "utf8",
    ),
  );
  const abi = out.contracts[path][name].abi;
  const std = JSON.parse(
    readFileSync(
      join(EVIDENCE, "build", chain, "standard-json-input.json"),
      "utf8",
    ),
  );
  const srcText = Object.entries(std.sources)
    .filter(([p]) => p.startsWith("src/"))
    .map(([, v]) => v.content)
    .join("\n");
  const live = readFileSync(
    join(EVIDENCE, "chain-pins", `${chain}-implementation-runtime.hex`),
    "utf8",
  ).trim();
  const liveSel = dispatcherSelectors(live);
  const pinBlock = await retry(() =>
    rpc(side.url, "eth_blockNumber", [], {
      log: "security/abi-matrix-rpc.jsonl",
    }),
  );
  const rows = [];
  for (const item of abi.filter((x) => x.type === "function")) {
    const sig = toFunctionSignature(item),
      sel = toFunctionSelector(item);
    const m = srcText.match(
      new RegExp(`function\\s+${item.name}\\s*\\([^)]*\\)[^{;]*`, "m"),
    );
    const guard = m
      ? (
          m[0].match(/only(Role\([^)]*\)|Initializing|Proxy|[A-Z]\w*)/g) ?? []
        ).join(" ")
      : "(inherited from OpenZeppelin)";
    const row = {
      selector: sel,
      signature: sig,
      stateMutability: item.stateMutability,
      guard:
        guard ||
        (item.stateMutability === "view" || item.stateMutability === "pure"
          ? "read-only"
          : "PUBLIC"),
      inLiveDispatcher: liveSel.has(sel),
    };
    if (
      (item.stateMutability === "view" || item.stateMutability === "pure") &&
      item.inputs.length === 0
    ) {
      try {
        const data = encodeFunctionData({
          abi: [item],
          functionName: item.name,
        });
        const raw = await retry(() =>
          rpc(side.url, "eth_call", [{ to: side.proxy, data }, pinBlock], {
            log: "security/abi-matrix-rpc.jsonl",
          }),
        );
        row.liveProbe = JSON.parse(
          JSON.stringify(
            decodeFunctionResult({
              abi: [item],
              functionName: item.name,
              data: raw,
            }),
            (_, v) => (typeof v === "bigint" ? v.toString() : v),
          ),
        );
      } catch (e) {
        row.liveProbe = `ERROR ${String(e.message).slice(0, 80)}`;
      }
    }
    rows.push(row);
  }
  const abiSel = new Set(rows.map((r) => r.selector));
  result.chains[chain] = {
    target: `${path}:${name}`,
    pinnedBlock: Number(BigInt(pinBlock)),
    functions: rows.length,
    liveDispatcherSelectors: liveSel.size,
    liveSelectorsAbsentFromAbi: [...liveSel].filter((s) => !abiSel.has(s)),
    abiSelectorsAbsentFromLive: rows
      .filter((r) => !r.inLiveDispatcher)
      .map((r) => r.signature),
    events: abi
      .filter((x) => x.type === "event")
      .map((e) => ({
        topic0: toEventSelector(e),
        signature: toFunctionSignature({ ...e, type: "function" }).replace(
          /^function /,
          "",
        ),
      })),
    errors: abi
      .filter((x) => x.type === "error")
      .map((e) => ({
        selector: toFunctionSelector({
          ...e,
          type: "function",
          outputs: [],
          stateMutability: "pure",
        }),
        name: e.name,
      })),
    publicStateChanging: rows
      .filter(
        (r) =>
          r.guard === "PUBLIC" && !["view", "pure"].includes(r.stateMutability),
      )
      .map((r) => r.signature),
    rows,
  };
}
const w = writeJson("security/abi-selector-matrix.json", result);
for (const [c, r] of Object.entries(result.chains))
  console.log(
    c,
    r.functions,
    "fns;",
    r.liveDispatcherSelectors,
    "live sel;",
    "liveNotInAbi",
    r.liveSelectorsAbsentFromAbi,
    "abiNotLive",
    r.abiSelectorsAbsentFromLive.length,
    "public writes:",
    r.publicStateChanging,
  );
console.log(w);
