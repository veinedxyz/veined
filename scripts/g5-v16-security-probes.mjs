// V1.6 G5 §45/§52: read-only eth_call probes of privileged/initialization paths on the live proxies and
// implementations. Every probe MUST revert; nothing is signed or broadcast (eth_call only).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeErrorResult,
  encodeFunctionData,
  parseAbi,
  keccak256,
  toHex,
} from "viem";
import { EVIDENCE, rpcRaw, rpc, retry, now, writeJson } from "./g5-v16-lib.mjs";

const SIDES = {
  one: {
    url: "https://mainnet.crosstoken.io:22001",
    proxy: "0xb81d6e000000000000000000000000000000c0de",
    impl: "0x2827865ad5330faf855af8b743c701ae9c818034",
  },
  bsc: {
    url: "https://bsc-dataseed.bnbchain.org",
    proxy: "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5",
    impl: "0xac7b8ffed19d670930b8caa0693189b33454e8d8",
  },
};
const STRANGER = "0x000000000000000000000000000000000000beef";
const abi = parseAbi([
  "function initialize(address owner,address dev_,uint8 threshold_)",
  "function upgradeToAndCall(address newImplementation,bytes data) payable",
  "function setPause(bool set)",
  "function removePending(uint256 remoteChainID,uint256 index)",
  "function manualReleasePendingWithRecipient(uint256 remoteChainID,uint256 index,address recipient)",
  "function grantRole(bytes32 role,address account)",
  "function setBridgeVerifier(address)",
  "function changeThreshold(uint8)",
  "function registerToken(uint256 remoteChainID,bool isOrigin,address localToken,address remoteToken)",
  "function paused() view returns (bool)",
]);
const out = { at: now(), from: STRANGER, chains: {} };
for (const [chain, s] of Object.entries(SIDES)) {
  const rep = JSON.parse(
    readFileSync(
      join(EVIDENCE, "build", chain, "standard-json-output-native.json"),
      "utf8",
    ),
  );
  const [[path, name]] = Object.entries(
    JSON.parse(
      readFileSync(join(EVIDENCE, "build", chain, "reproduction.json"), "utf8"),
    ).compilationTarget,
  );
  const liveAbi = rep.contracts[path][name].abi;
  const block = await retry(() => rpc(s.url, "eth_blockNumber", []));
  const probes = [
    ["re-initialize proxy", s.proxy, "initialize", [STRANGER, STRANGER, 1]],
    [
      "unauthorized upgrade via proxy",
      s.proxy,
      "upgradeToAndCall",
      [STRANGER, "0x"],
    ],
    ["unauthorized pause", s.proxy, "setPause", [true]],
    [
      "unauthorized removePending",
      s.proxy,
      "removePending",
      [chain === "one" ? 56n : 612055n, 20n],
    ],
    [
      "unauthorized manual release",
      s.proxy,
      "manualReleasePendingWithRecipient",
      [chain === "one" ? 56n : 612055n, 20n, STRANGER],
    ],
    [
      "unauthorized grantRole(VALIDATOR)",
      s.proxy,
      "grantRole",
      [keccak256(toHex("VALIDATOR_ROLE")), STRANGER],
    ],
    [
      "unauthorized setBridgeVerifier",
      s.proxy,
      "setBridgeVerifier",
      [STRANGER],
    ],
    ["unauthorized changeThreshold(1)", s.proxy, "changeThreshold", [1]],
    [
      "unauthorized registerToken",
      s.proxy,
      "registerToken",
      [1n, true, STRANGER, STRANGER],
    ],
    [
      "initialize implementation directly",
      s.impl,
      "initialize",
      [STRANGER, STRANGER, 1],
    ],
    [
      "upgrade implementation directly (UUPS onlyProxy)",
      s.impl,
      "upgradeToAndCall",
      [STRANGER, "0x"],
    ],
  ];
  const rows = [];
  for (const [label, to, fn, args] of probes) {
    const data = encodeFunctionData({ abi, functionName: fn, args });
    const r = await rpcRaw(
      s.url,
      "eth_call",
      [{ from: STRANGER, to, data }, block],
      { log: "security/probes-rpc.jsonl" },
    );
    const errData = r.json?.error?.data;
    let decoded = null;
    if (typeof errData === "string" && errData.length >= 10) {
      try {
        const e = decodeErrorResult({ abi: liveAbi, data: errData });
        decoded = `${e.errorName}(${(e.args ?? []).map(String).join(",")})`;
      } catch {
        decoded = errData.slice(0, 10);
      }
    }
    rows.push({
      label,
      to,
      fn,
      reverted: Boolean(r.json?.error),
      decoded,
      rpcError: r.json?.error?.message ?? null,
    });
  }
  out.chains[chain] = {
    block: Number(BigInt(block)),
    probes: rows,
    allReverted: rows.every((x) => x.reverted),
  };
}
out.ALL_PROBES_REVERTED = Object.values(out.chains).every((c) => c.allReverted);
const w = writeJson("security/privileged-path-probes.json", out);
for (const [c, v] of Object.entries(out.chains))
  for (const p of v.probes)
    console.log(
      c,
      p.reverted ? "REVERT" : "!!! SUCCEEDED",
      p.label,
      "->",
      p.decoded,
    );
console.log(out.ALL_PROBES_REVERTED, w);
