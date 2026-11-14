// V1.6 G5: fresh deployment identity pins (both chains, every configured RPC), CBOR metadata extraction.
import { writeFileSync } from "node:fs";
import {
  RPCS,
  rpc,
  retry,
  now,
  parseCborFooter,
  codeKeccak,
  codeSha256,
  writeJson,
  logPath,
} from "./g5-v16-lib.mjs";

const SLOTS = {
  implementation:
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeee9b4b1e0ae2c5d1d2c93ae",
};
const TARGETS = {
  one: {
    chainId: 612055,
    proxy: "0xb81d6e000000000000000000000000000000c0de",
    impl: "0x2827865ad5330faf855af8b743c701ae9c818034",
  },
  bsc: {
    chainId: 56,
    proxy: "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5",
    impl: "0xac7b8ffed19d670930b8caa0693189b33454e8d8",
    token: "0x6bf62ca91e397b5a7d1d6bce97d9092065d7a510",
  },
};
const label = process.argv[2] ?? "initial";

const out = { at: now(), label, chains: {} };
for (const [chain, t] of Object.entries(TARGETS)) {
  const primary = RPCS[chain][0].url;
  const chainId = Number(
    BigInt(await retry(() => rpc(primary, "eth_chainId", []))),
  );
  if (chainId !== t.chainId)
    throw new Error(`CHAIN_MISMATCH ${chain} ${chainId}`);
  const head = await retry(() =>
    rpc(primary, "eth_getBlockByNumber", ["latest", false]),
  );
  const block = head.number;
  const c = {
    chainId,
    pinnedBlock: Number(BigInt(block)),
    pinnedBlockHex: block,
    pinnedBlockHash: head.hash,
    timestamp: Number(BigInt(head.timestamp)),
    sources: [],
  };
  for (const { url, operator } of RPCS[chain]) {
    const s = { url, operator };
    try {
      s.chainId = Number(
        BigInt(await retry(() => rpc(url, "eth_chainId", []))),
      );
      const b = await retry(() =>
        rpc(url, "eth_getBlockByNumber", [block, false]),
      );
      s.blockHash = b?.hash ?? null;
      s.blockHashAgrees = s.blockHash === head.hash;
      for (const [k, slot] of Object.entries(SLOTS))
        s[`${k}Slot`] = await retry(() =>
          rpc(url, "eth_getStorageAt", [t.proxy, slot, block]),
        );
      s.implementationFromSlot = "0x" + s.implementationSlot.slice(-40);
      const pc = await retry(() => rpc(url, "eth_getCode", [t.proxy, block]));
      const ic = await retry(() =>
        rpc(url, "eth_getCode", [s.implementationFromSlot, block]),
      );
      s.proxy = {
        bytes: (pc.length - 2) / 2,
        keccak256: codeKeccak(pc),
        sha256: codeSha256(pc),
      };
      s.implementation = {
        address: s.implementationFromSlot,
        bytes: (ic.length - 2) / 2,
        keccak256: codeKeccak(ic),
        sha256: codeSha256(ic),
      };
      if (t.token) {
        const tc = await retry(() => rpc(url, "eth_getCode", [t.token, block]));
        s.token = {
          bytes: (tc.length - 2) / 2,
          keccak256: codeKeccak(tc),
          sha256: codeSha256(tc),
        };
        if (url === primary)
          writeFileSync(logPath(`chain-pins/${chain}-token-runtime.hex`), tc);
      }
      if (url === primary) {
        writeFileSync(logPath(`chain-pins/${chain}-proxy-runtime.hex`), pc);
        writeFileSync(
          logPath(`chain-pins/${chain}-implementation-runtime.hex`),
          ic,
        );
        c.proxyCbor = parseCborFooter(pc);
        c.implementationCbor = parseCborFooter(ic);
      }
    } catch (e) {
      s.error = String(e.message ?? e).slice(0, 300);
    }
    c.sources.push(s);
  }
  const ok = c.sources.filter((s) => !s.error);
  c.consensus = {
    sourcesOk: ok.length,
    implementationAgrees:
      new Set(ok.map((s) => s.implementationFromSlot)).size === 1,
    implementationHashAgrees:
      new Set(ok.map((s) => s.implementation.keccak256)).size === 1,
    proxyHashAgrees: new Set(ok.map((s) => s.proxy.keccak256)).size === 1,
    expectedImplementation: t.impl,
    implementationUnchanged: ok.every(
      (s) => s.implementationFromSlot === t.impl,
    ),
  };
  out.chains[chain] = c;
}
const w = writeJson(`chain-pins/deployment-identity-${label}.json`, out);
console.log(JSON.stringify(out, null, 1));
console.log(w);
