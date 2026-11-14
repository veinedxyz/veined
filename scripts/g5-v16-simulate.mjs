// V1.6 G5: fresh READ-ONLY positive simulation + negative controls on ONEchain (no signing, no broadcast,
// no state override). Every call uses one explicit pinned block on BOTH official ONE endpoints.
import { readFileSync } from "node:fs";
import {
  encodeFunctionData,
  decodeFunctionResult,
  decodeErrorResult,
  parseAbi,
  keccak256,
} from "viem";
import { rpc, rpcRaw, retry, now, writeJson, EVIDENCE } from "./g5-v16-lib.mjs";

const ONE_RPCS = [
  "https://mainnet.crosstoken.io:22001",
  "https://mainnet.onechain.nexus:22001",
];
const PROXY = "0xb81d6e000000000000000000000000000000c0de";
const IMPL = "0x2827865ad5330faf855af8b743c701ae9c818034",
  IMPL_HASH =
    "0x8bb2e9361035520a62a806cf78ff6f325d32c578a63f35ad49263524361e04bc";
const PROXY_HASH =
  "0x0dac1e1deb9381d1139c43a9d49d022a4786242e90744abd0f77bf85375b548b";
const NATIVE = "0x0000000000000000000000000000000000000001",
  CROSS = "0x6bf62ca91e397b5a7d1d6bce97d9092065d7a510";
const ACCOUNT = "0x28136a77ec8ba3d918114712a588b4095ba12a6b"; // operator-provided public address (read-only observation only)
const SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const abi = parseAbi([
  "function bridgeToken(uint256 toChainID,address fromToken,address to,uint256 value,uint256 networkFee,uint256 exFee,bytes extraData) payable returns (bool)",
  "function bridgeVerifier() view returns (address)",
  "function paused() view returns (bool)",
  "function getTokenPair(uint256,address) view returns ((address localToken,address remoteToken,bool isOrigin,bool paused,uint256 pendingAmount,uint256 deposited,uint256 minted))",
  "function calculateFee(uint256,address,uint256) view returns (uint256 minimumValue,uint256 networkFee,uint256 exFee)",
  "function isTokenFinalizePaused(uint256,address) view returns (bool)",
]);
// Error ABI of the exact live build (src/CrossBridge.sol @ b3b0258, reproduced byte-for-byte).
const built = JSON.parse(
  readFileSync(
    `${EVIDENCE}/build/one/standard-json-output-native.json`,
    "utf8",
  ),
);
const liveAbi = built.contracts["src/CrossBridge.sol"].CrossBridge.abi;
const decodeErr = (data) => {
  try {
    const e = decodeErrorResult({ abi: liveAbi, data });
    return `${e.errorName}(${(e.args ?? []).map(String).join(",")})`;
  } catch {
    return "UNDECODED";
  }
};
const label = process.argv[2] ?? "final";

const out = { at: now(), label, account: ACCOUNT, perRpc: [] };
const head = await retry(() =>
  rpc(ONE_RPCS[0], "eth_getBlockByNumber", ["latest", false]),
);
const block = head.number;
out.pinnedBlock = Number(BigInt(block));
out.pinnedBlockHash = head.hash;
out.pinnedTimestamp = new Date(
  Number(BigInt(head.timestamp)) * 1000,
).toISOString();

for (const url of ONE_RPCS) {
  const r = { url };
  const call = async (to, fn, args = []) =>
    decodeFunctionResult({
      abi,
      functionName: fn,
      data: await retry(() =>
        rpc(
          url,
          "eth_call",
          [
            { to, data: encodeFunctionData({ abi, functionName: fn, args }) },
            block,
          ],
          { log: "simulations/rpc.jsonl" },
        ),
      ),
    });
  r.chainId = Number(BigInt(await retry(() => rpc(url, "eth_chainId", []))));
  r.blockHash = (
    await retry(() => rpc(url, "eth_getBlockByNumber", [block, false]))
  ).hash;
  r.implSlot = await retry(() =>
    rpc(url, "eth_getStorageAt", [PROXY, SLOT, block]),
  );
  r.implCodeHash = keccak256(
    await retry(() => rpc(url, "eth_getCode", [IMPL, block])),
  );
  r.proxyCodeHash = keccak256(
    await retry(() => rpc(url, "eth_getCode", [PROXY, block])),
  );
  r.paused = await call(PROXY, "paused");
  r.pair = await call(PROXY, "getTokenPair", [56n, NATIVE]);
  r.finalizePaused = await call(PROXY, "isTokenFinalizePaused", [56n, NATIVE]);
  r.verifier = await call(PROXY, "bridgeVerifier");
  const [minimum, networkFee] = await call(r.verifier, "calculateFee", [
    56n,
    NATIVE,
    0n,
  ]);
  const [, , exFee] = await call(r.verifier, "calculateFee", [
    56n,
    NATIVE,
    minimum,
  ]);
  r.minimum = minimum;
  r.networkFee = networkFee;
  r.exFee = exFee;
  r.exactValue = minimum + networkFee + exFee;
  r.balance = BigInt(
    await retry(() => rpc(url, "eth_getBalance", [ACCOUNT, block])),
  );
  r.accountCode = await retry(() => rpc(url, "eth_getCode", [ACCOUNT, block]));
  r.gasPrice = BigInt(await retry(() => rpc(url, "eth_gasPrice", [])));
  const data = encodeFunctionData({
    abi,
    functionName: "bridgeToken",
    args: [56n, NATIVE, ACCOUNT, minimum, networkFee, exFee, "0x"],
  });
  const tx = {
    from: ACCOUNT,
    to: PROXY,
    data,
    value: "0x" + r.exactValue.toString(16),
  };
  r.calldata = data;
  const pc = await rpcRaw(url, "eth_call", [tx, block], {
    log: "simulations/rpc.jsonl",
  });
  const pg = await rpcRaw(url, "eth_estimateGas", [tx, block], {
    log: "simulations/rpc.jsonl",
  });
  r.positive = {
    ethCall: pc.json,
    estimateGas: pg.json,
    gas: pg.json?.result ? Number(BigInt(pg.json.result)) : null,
    returnsTrue: pc.json?.result === "0x" + "0".repeat(63) + "1",
  };
  const neg = async (name, args, value) => {
    const d = encodeFunctionData({ abi, functionName: "bridgeToken", args });
    const res = await rpcRaw(
      url,
      "eth_call",
      [
        { from: ACCOUNT, to: PROXY, data: d, value: "0x" + value.toString(16) },
        block,
      ],
      { log: "simulations/rpc.jsonl" },
    );
    const errData = res.json?.error?.data;
    return {
      name,
      rejected: Boolean(res.json?.error),
      error: res.json?.error ?? null,
      selector: typeof errData === "string" ? errData.slice(0, 10) : null,
      decoded: typeof errData === "string" ? decodeErr(errData) : null,
    };
  };
  r.negative = [
    await neg(
      "belowMinimumByOneWei",
      [56n, NATIVE, ACCOUNT, minimum - 1n, networkFee, exFee, "0x"],
      minimum - 1n + networkFee + exFee,
    ),
    await neg(
      "wrongMsgValue(minus 1 wei)",
      [56n, NATIVE, ACCOUNT, minimum, networkFee, exFee, "0x"],
      r.exactValue - 1n,
    ),
    await neg(
      "networkFeeBelowRequired",
      [56n, NATIVE, ACCOUNT, minimum, networkFee - 1n, exFee, "0x"],
      minimum + networkFee - 1n + exFee,
    ),
    await neg(
      "unsupportedDestinationChain(97)",
      [97n, NATIVE, ACCOUNT, minimum, networkFee, exFee, "0x"],
      r.exactValue,
    ),
    await neg(
      "unsupportedToken(CROSS-on-ONE)",
      [56n, CROSS, ACCOUNT, minimum, networkFee, exFee, "0x"],
      r.exactValue,
    ),
    await neg(
      "zeroRecipient",
      [
        56n,
        NATIVE,
        "0x0000000000000000000000000000000000000000",
        minimum,
        networkFee,
        exFee,
        "0x",
      ],
      r.exactValue,
    ),
  ];
  r.blockHashAfter = (
    await retry(() => rpc(url, "eth_getBlockByNumber", [block, false]))
  ).hash;
  out.perRpc.push(r);
}
const a = out.perRpc[0];
const ok = (x) => out.perRpc.every(x);
out.gates = {
  runtimePinned: ok(
    (r) =>
      r.implSlot.endsWith(IMPL.slice(2)) &&
      r.implCodeHash === IMPL_HASH &&
      r.proxyCodeHash === PROXY_HASH,
  ),
  routeOpen: ok(
    (r) =>
      !r.paused &&
      !r.pair.paused &&
      !r.finalizePaused &&
      r.pair.localToken.toLowerCase() === NATIVE &&
      r.pair.remoteToken.toLowerCase() === CROSS,
  ),
  balanceCoversValuePlusGas: ok(
    (r) =>
      r.positive.gas !== null &&
      r.balance >=
        r.exactValue + (BigInt(r.positive.gas) * r.gasPrice * 12n) / 10n,
  ),
  POSITIVE_SIMULATION: ok(
    (r) =>
      r.positive.returnsTrue &&
      r.positive.gas !== null &&
      !r.positive.ethCall.error,
  ),
  NEGATIVE_CONTROL: ok((r) => r.negative.every((n) => n.rejected)),
  rpcsAgree: ok(
    (r) =>
      r.blockHash === out.pinnedBlockHash &&
      r.blockHashAfter === out.pinnedBlockHash &&
      r.exactValue === a.exactValue &&
      r.positive.gas === a.positive.gas,
  ),
  noStateOverride: true,
  signed: false,
  broadcast: false,
};
out.summary = {
  minimum: a.minimum,
  networkFee: a.networkFee,
  serviceFee: a.exFee,
  exactMsgValue: a.exactValue,
  estimateGas: a.positive.gas,
  negative: a.negative.map(
    (n) => `${n.name}: ${n.decoded ?? JSON.stringify(n.error).slice(0, 80)}`,
  ),
};
const w = writeJson(`simulations/simulation-${label}.json`, out);
console.log(
  JSON.stringify(
    { pinnedBlock: out.pinnedBlock, gates: out.gates, summary: out.summary, w },
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    1,
  ),
);
