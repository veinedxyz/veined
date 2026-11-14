// V1.6 G5: pinned-block route/reserve snapshot of both bridges (read-only eth_call/eth_getStorageAt only).
// Every value is read at one explicit block per chain from every configured RPC and compared.
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  encodeAbiParameters,
  parseAbi,
  pad,
  toHex,
} from "viem";
import { RPCS, rpc, retry, now, writeJson } from "./g5-v16-lib.mjs";

export const ONE = {
  chainId: 612055,
  proxy: "0xb81d6e000000000000000000000000000000c0de",
  impl: "0x2827865ad5330faf855af8b743c701ae9c818034",
  implHash:
    "0x8bb2e9361035520a62a806cf78ff6f325d32c578a63f35ad49263524361e04bc",
  proxyHash:
    "0x0dac1e1deb9381d1139c43a9d49d022a4786242e90744abd0f77bf85375b548b",
};
export const BSC = {
  chainId: 56,
  proxy: "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5",
  impl: "0xac7b8ffed19d670930b8caa0693189b33454e8d8",
  implHash:
    "0x47b60de2375276f3ead49ea41f35c58d068d6bd57625d3553db4257476f91f22",
  proxyHash:
    "0x25b30cfa97d56a7b846443ce92558cf31d86e95966c5afa22dacb0213c52ff9b",
};
export const CROSS = "0x6bf62ca91e397b5a7d1d6bce97d9092065d7a510";
export const NATIVE = "0x0000000000000000000000000000000000000001";
const IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export const abi = parseAbi([
  "function paused() view returns (bool)",
  "function threshold() view returns (uint8)",
  "function bridgeVerifier() view returns (address)",
  "function bridgeExecutor() view returns (address)",
  "function dev() view returns (address)",
  "function maxExtraDataLength() view returns (uint256)",
  "function postCallGasReserve() view returns (uint256)",
  "function initializedAt() view returns (uint256)",
  "function domainSeparator() view returns (bytes32)",
  "function crossSupply() view returns (uint256)",
  "function crossSupplyLimit() view returns (uint256)",
  "function allChainIDs() view returns (uint256[])",
  "function allTokenPairs(uint256) view returns ((address localToken,address remoteToken,bool isOrigin,bool paused,uint256 pendingAmount,uint256 deposited,uint256 minted)[])",
  "function getTokenPair(uint256,address) view returns ((address localToken,address remoteToken,bool isOrigin,bool paused,uint256 pendingAmount,uint256 deposited,uint256 minted))",
  "function allPendingIndex(uint256) view returns (uint256[])",
  "function getPendingArguments(uint256,uint256) view returns (((uint256 fromChainID,uint256 index,address toToken,address to,uint256 value,bytes extraData) args,uint8 status,uint256 delayExpiration))",
  "function getNextInitiateIndex(uint256) view returns (uint256)",
  "function getNextFinalizeIndex(uint256) view returns (uint256)",
  "function isTokenFinalizePaused(uint256,address) view returns (bool)",
  "function getRoleMembers(bytes32) view returns (address[])",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function getVerificationAmountThreshold() view returns (uint256)",
  "function getPeriodTotalValueThreshold() view returns (uint256)",
  "function getTimeWindow() view returns (uint256)",
  "function getMinimumTokenValue() view returns (uint256)",
  "function getTokenCurrentScore(address) view returns (uint256)",
  "function getTokenPriceWithValue(address,uint256) view returns (bool exist,uint256 price)",
  "function getTokenConfig(uint256,address) view returns (uint256 minimumValue,uint256 networkFee,uint256 exFeeRate)",
  "function calculateFee(uint256,address,uint256) view returns (uint256 minimumValue,uint256 networkFee,uint256 exFee)",
  "function priceFeed() view returns (address)",
  "function denominator() pure returns (uint256)",
  "function getGasPrice(uint256) view returns (uint256)",
  "function dollarDecimals() view returns (uint256)",
]);
const ROLES = [
  "DEFAULT_ADMIN_ROLE",
  "ADMIN_ROLE",
  "VALIDATOR_ROLE",
  "EDITOR_ROLE",
  "OPERATOR_ROLE",
  "PRICER_ROLE",
  "VERIFIER_ROLE",
  "BRIDGE_ROLE",
  "MINTER_ROLE",
  "EXECUTOR_ROLE",
  "INITIATOR_ROLE",
];
export const roleId = (r) =>
  r === "DEFAULT_ADMIN_ROLE" ? pad("0x00") : keccak256(toHex(r));

const mapSlot = (key, slot) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [BigInt(key), BigInt(slot)],
    ),
  );
const addrMapSlot = (addr, base) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [addr, base],
    ),
  );
const plus = (h, n) => toHex(BigInt(h) + BigInt(n), { size: 32 });

export async function call(url, to, fn, args, block) {
  const data = encodeFunctionData({ abi, functionName: fn, args });
  const raw = await retry(() =>
    rpc(url, "eth_call", [{ to, data }, block], {
      log: "reserve/snapshot-rpc.jsonl",
    }),
  );
  return decodeFunctionResult({ abi, functionName: fn, data: raw });
}

async function readSide(url, side, block, remoteChainId, token) {
  const c = (to, fn, args = []) => call(url, to, fn, args, block);
  const s = {};
  s.implementationSlot = await retry(() =>
    rpc(url, "eth_getStorageAt", [side.proxy, IMPL_SLOT, block]),
  );
  s.implementationCodeHash = keccak256(
    await retry(() =>
      rpc(url, "eth_getCode", ["0x" + s.implementationSlot.slice(-40), block]),
    ),
  );
  s.proxyCodeHash = keccak256(
    await retry(() => rpc(url, "eth_getCode", [side.proxy, block])),
  );
  for (const fn of [
    "paused",
    "threshold",
    "bridgeVerifier",
    "bridgeExecutor",
    "dev",
    "maxExtraDataLength",
    "postCallGasReserve",
    "initializedAt",
    "domainSeparator",
  ])
    s[fn] = await c(side.proxy, fn);
  if (side === ONE) {
    s.crossSupply = await c(side.proxy, "crossSupply");
    s.crossSupplyLimit = await c(side.proxy, "crossSupplyLimit");
  }
  s.chains = {};
  for (const ch of await c(side.proxy, "allChainIDs")) {
    const pairs = await c(side.proxy, "allTokenPairs", [ch]);
    const pending = [];
    const idx = await c(side.proxy, "allPendingIndex", [ch]);
    for (const i of idx)
      pending.push({
        index: i,
        ...(await c(side.proxy, "getPendingArguments", [ch, i])),
      });
    // chain paused: _chainData slot 4, struct field +3
    const chainBase = mapSlot(ch, 4);
    const chainPausedRaw = await retry(() =>
      rpc(url, "eth_getStorageAt", [side.proxy, plus(chainBase, 3), block]),
    );
    s.chains[ch.toString()] = {
      pairs,
      nextInitiateIndex: await c(side.proxy, "getNextInitiateIndex", [ch]),
      nextFinalizeIndex: await c(side.proxy, "getNextFinalizeIndex", [ch]),
      pendingIndexCount: idx.length,
      pending,
      chainPaused: BigInt(chainPausedRaw) !== 0n,
      chainPausedRawSlot: plus(chainBase, 3),
      finalizePaused: Object.fromEntries(
        await Promise.all(
          pairs.map(async (p) => [
            p.localToken,
            await c(side.proxy, "isTokenFinalizePaused", [ch, p.localToken]),
          ]),
        ),
      ),
    };
  }
  // raw storage cross-check of the route pair: _tokenPairs slot 6
  const pairBase = addrMapSlot(token, mapSlot(remoteChainId, 6));
  const raw = [];
  for (let k = 0; k < 5; k++)
    raw.push(
      await retry(() =>
        rpc(url, "eth_getStorageAt", [side.proxy, plus(pairBase, k), block]),
      ),
    );
  s.routePairRawStorage = {
    base: pairBase,
    slots: raw,
    decoded: {
      localToken: "0x" + raw[0].slice(-40),
      remoteToken: "0x" + raw[1].slice(-40),
      isOrigin: BigInt("0x" + raw[1].slice(-42, -40)) === 1n,
      paused: BigInt("0x" + raw[1].slice(-44, -42)) === 1n,
      pendingAmount: BigInt(raw[2]),
      deposited: BigInt(raw[3]),
      minted: BigInt(raw[4]),
    },
  };
  s.roles = {};
  for (const r of ROLES)
    s.roles[r] = await c(side.proxy, "getRoleMembers", [roleId(r)]);
  // verifier
  const v = s.bridgeVerifier,
    vt = side === ONE ? NATIVE : CROSS;
  s.verifier = {
    address: v,
    codeHash: keccak256(await retry(() => rpc(url, "eth_getCode", [v, block]))),
    roles: {},
  };
  for (const fn of [
    "getVerificationAmountThreshold",
    "getPeriodTotalValueThreshold",
    "getTimeWindow",
    "getMinimumTokenValue",
    "priceFeed",
    "denominator",
    "dollarDecimals",
  ])
    s.verifier[fn] = await c(v, fn);
  s.verifier.tokenCurrentScore = await c(v, "getTokenCurrentScore", [vt]);
  s.verifier.priceOfOneToken = await c(v, "getTokenPriceWithValue", [
    vt,
    10n ** 18n,
  ]);
  s.verifier.tokenConfigToRemote = await c(v, "getTokenConfig", [
    remoteChainId,
    vt,
  ]);
  s.verifier.gasPriceRemote = await c(v, "getGasPrice", [remoteChainId]);
  for (const r of ROLES) {
    try {
      s.verifier.roles[r] = await c(v, "getRoleMembers", [roleId(r)]);
    } catch {
      s.verifier.roles[r] = "UNAVAILABLE";
    }
  }
  return s;
}

export async function snapshot(label = "snapshot") {
  const out = { at: now(), label, chains: {} };
  for (const [name, side, remote, token] of [
    ["bsc", BSC, 612055n, CROSS],
    ["one", ONE, 56n, NATIVE],
  ]) {
    const primary = RPCS[name][0].url;
    const head = await retry(() =>
      rpc(primary, "eth_getBlockByNumber", ["latest", false]),
    );
    const block = head.number;
    const per = [];
    for (const { url, operator } of RPCS[name]) {
      try {
        const s = await readSide(url, side, block, remote, token);
        if (name === "bsc") {
          s.cross = {
            balanceOfBridge: await call(
              url,
              CROSS,
              "balanceOf",
              [BSC.proxy],
              block,
            ),
            totalSupply: await call(url, CROSS, "totalSupply", [], block),
            decimals: await call(url, CROSS, "decimals", [], block),
            symbol: await call(url, CROSS, "symbol", [], block),
            name: await call(url, CROSS, "name", [], block),
            codeHash: keccak256(
              await retry(() => rpc(url, "eth_getCode", [CROSS, block])),
            ),
          };
        } else {
          s.nativeBalanceOfBridge = BigInt(
            await retry(() => rpc(url, "eth_getBalance", [ONE.proxy, block])),
          );
        }
        const bh = await retry(() =>
          rpc(url, "eth_getBlockByNumber", [block, false]),
        );
        per.push({ url, operator, blockHash: bh.hash, state: s });
      } catch (e) {
        per.push({
          url,
          operator,
          error: String(e.message ?? e).slice(0, 300),
        });
      }
    }
    const ok = per.filter((p) => !p.error);
    const ser = (x) =>
      JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    out.chains[name] = {
      chainId: side.chainId,
      block: Number(BigInt(block)),
      blockHex: block,
      blockHash: head.hash,
      timestamp: Number(BigInt(head.timestamp)),
      sources: per,
      consensus: {
        ok: ok.length,
        identicalState:
          ok.length > 0 && ok.every((p) => ser(p.state) === ser(ok[0].state)),
        blockHashAgrees: ok.every((p) => p.blockHash === head.hash),
      },
    };
  }
  return out;
}

if (process.argv[1]?.endsWith("g5-v16-snapshot.mjs")) {
  const label = process.argv[2] ?? "snapshot";
  const out = await snapshot(label);
  const w = writeJson(`reserve/route-snapshot-${label}.json`, out);
  const b = out.chains.bsc,
    s = b.sources.find((p) => !p.error)?.state;
  console.log(
    JSON.stringify(
      {
        w,
        bsc: {
          block: b.block,
          consensus: b.consensus,
          pair: s?.chains?.["612055"]?.pairs,
          balance: s?.cross?.balanceOfBridge,
          pending: s?.chains?.["612055"]?.pendingIndexCount,
        },
        one: {
          block: out.chains.one.block,
          consensus: out.chains.one.consensus,
        },
      },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      1,
    ),
  );
}
