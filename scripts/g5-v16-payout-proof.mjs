// V1.6 G5: build a canonical ONEchain -> BSC payout proof for one bridge index.
// Usage: node scripts/g5-v16-payout-proof.mjs <label> <index> <sourceBlock> <sourceTx> <destTx>
// Read-only. Binds: block hash <- recomputed header <- receiptsRoot <- receipt (MPT proof) <- logs, on both chains,
// validator EIP-712 signatures recovered from the public finalize calldata, implementation active at the destination block.
import {
  decodeFunctionData,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  keccak256,
  toHex,
} from "viem";
import { rpc, retry, now, writeJson } from "./g5-v16-lib.mjs";
import {
  receiptProof,
  headerHash,
  decodeLog,
  recoverFinalizeSigners,
  verifyStoredProof,
  MPT_VERSION,
} from "./g5-v16-proof-lib.mjs";
import { fetchSave } from "./g5-v16-fetch.mjs";

const [label, indexArg, sourceBlockArg, sourceTx, destTx] =
  process.argv.slice(2);
const INDEX = BigInt(indexArg);
const ONE_RPCS = [
  "https://mainnet.crosstoken.io:22001",
  "https://mainnet.onechain.nexus:22001",
];
const BSC_RPCS = [
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3",
];
const BSC_ARCHIVE = "https://bsc-mainnet.public.blastapi.io";
const ONE_PROXY = "0xb81d6e000000000000000000000000000000c0de",
  BSC_PROXY = "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5";
const CROSS = "0x6bf62ca91e397b5a7d1d6bce97d9092065d7a510",
  NATIVE = "0x0000000000000000000000000000000000000001";
const IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EXPECT = {
  oneImpl: "0x2827865ad5330faf855af8b743c701ae9c818034",
  bscImpl: "0xac7b8ffed19d670930b8caa0693189b33454e8d8",
  bscImplHash:
    "0x47b60de2375276f3ead49ea41f35c58d068d6bd57625d3553db4257476f91f22",
};
const LOG = `payouts/${label}-rpc.jsonl`;
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const hx = (n) => "0x" + BigInt(n).toString(16);
const ser = (x) =>
  JSON.parse(
    JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
const bridgeAbi = parseAbi([
  "function bridgeToken(uint256 toChainID,address fromToken,address to,uint256 value,uint256 networkFee,uint256 exFee,bytes extraData) payable returns (bool)",
  "function getRoleMembers(bytes32) view returns (address[])",
  "function threshold() view returns (uint8)",
  "function domainSeparator() view returns (bytes32)",
]);
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail: ser(detail) });
  return ok;
};

// ---------------- SOURCE (ONEchain) ----------------
const src = {
  chainId: 612055,
  proxy: ONE_PROXY,
  block: Number(sourceBlockArg),
  tx: sourceTx,
  sources: [],
};
for (const u of ONE_RPCS) {
  const b = await retry(() =>
    rpc(u, "eth_getBlockByNumber", [hx(src.block), true], { log: LOG }),
  );
  const rcs = await retry(() =>
    rpc(u, "eth_getBlockReceipts", [hx(src.block)], { log: LOG }),
  );
  const head = Number(
    BigInt(await retry(() => rpc(u, "eth_blockNumber", [], { log: LOG }))),
  );
  const chainId = Number(
    BigInt(await retry(() => rpc(u, "eth_chainId", [], { log: LOG }))),
  );
  src.sources.push({ url: u, chainId, head, block: b, receipts: rcs });
}
const s0 = src.sources[0];
const sblk = s0.block;
src.blockHash = sblk.hash;
src.timestamp = Number(BigInt(sblk.timestamp));
src.receiptsRoot = sblk.receiptsRoot;
check(
  "source.chainId",
  src.sources.every((s) => s.chainId === 612055),
  src.sources.map((s) => s.chainId),
);
check(
  "source.blockHashAgreesAcrossRpcs",
  src.sources.every((s) => eq(s.block.hash, sblk.hash)),
  src.sources.map((s) => s.block.hash),
);
check(
  "source.receiptsIdenticalAcrossRpcs",
  src.sources.every(
    (s) => JSON.stringify(s.receipts) === JSON.stringify(s0.receipts),
  ),
  null,
);
src.recomputedHeaderHash = headerHash(sblk);
check("source.headerHashRecomputed", eq(src.recomputedHeaderHash, sblk.hash), {
  recomputed: src.recomputedHeaderHash,
  reported: sblk.hash,
});
const stx = sblk.transactions.find((t) => eq(t.hash, sourceTx));
check("source.txInBlock", stx, { txIndex: stx?.transactionIndex });
const srcRcpt = s0.receipts.find((r) => eq(r.transactionHash, sourceTx));
check(
  "source.receiptStatusSuccess",
  srcRcpt && BigInt(srcRcpt.status) === 1n,
  srcRcpt?.status,
);
src.receiptProof = await receiptProof(
  s0.receipts,
  srcRcpt.transactionIndex,
  sblk.receiptsRoot,
);
check("source.receiptsRootRecomputed", src.receiptProof.ROOT_MATCH, {
  computed: src.receiptProof.computedRoot,
  header: sblk.receiptsRoot,
});
check(
  "source.receiptMerkleProofVerifies",
  src.receiptProof.PROOF_VERIFIES &&
    (await verifyStoredProof(src.receiptProof)),
  null,
);
const sInit = srcRcpt.logs
  .map((l) => ({ l, d: decodeLog(l) }))
  .filter(
    (x) => x.d?.event === "BridgeInitiated" && eq(x.l.address, ONE_PROXY),
  );
check(
  "source.exactlyOneBridgeInitiatedFromProxy",
  sInit.length === 1,
  sInit.length,
);
const si = sInit[0]?.d.args;
src.event = { logIndex: Number(BigInt(sInit[0].l.logIndex)), ...ser(si) };
check("source.toChainID=56", si.toChainID === 56n, si.toChainID);
check("source.index", si.index === INDEX, si.index);
check(
  "source.fromToken=nativeSentinel",
  eq(si.fromToken, NATIVE),
  si.fromToken,
);
check("source.toToken=CROSS", eq(si.toToken, CROSS), si.toToken);
check("source.txTo=proxy", eq(stx.to, ONE_PROXY), stx.to);
const call = decodeFunctionData({ abi: bridgeAbi, data: stx.input });
src.call = {
  functionName: call.functionName,
  args: ser(call.args),
  msgValue: BigInt(stx.value).toString(),
};
check(
  "source.calldata=bridgeToken(56,native,to,value,fees)",
  call.functionName === "bridgeToken" &&
    call.args[0] === 56n &&
    eq(call.args[1], NATIVE) &&
    eq(call.args[2], si.to) &&
    call.args[3] === si.value,
  src.call,
);
check(
  "source.msgValue=value+networkFee+exFee",
  BigInt(stx.value) === si.value + si.networkFee + si.exFee,
  {
    msgValue: stx.value,
    value: si.value,
    networkFee: si.networkFee,
    exFee: si.exFee,
  },
);
check("source.eventFrom=txFrom", eq(si.from, stx.from), {
  eventFrom: si.from,
  txFrom: stx.from,
});
src.confirmations = Math.min(...src.sources.map((s) => s.head)) - src.block;
check("source.confirmations>=64", src.confirmations >= 64, src.confirmations);
// Official explorer index cross-check of the same block hash (separate trust class).
const cs = await fetchSave(
  "OFFICIAL_EXPLORER_INDEX",
  `payouts/${label}-crossscan-block.json`,
  `https://www.crossscan.io/api/v2/blocks/${src.block}`,
);
let csHash = null;
try {
  csHash = JSON.parse(cs.body.toString()).hash;
} catch {
  /* recorded */
}
check("source.explorerBlockHashAgrees", eq(csHash, sblk.hash), {
  explorer: csHash,
});
// Implementation active at source block: ONE state is pruned; use the complete Upgraded history (evidence chain-pins/one-proxy-upgrade-history.json).
src.implementationAtBlock = {
  method: "EIP-1967 Upgraded event history (state pruned on public ONE nodes)",
  expected: EXPECT.oneImpl,
};

// ---------------- DESTINATION (BSC) ----------------
const dst = { chainId: 56, proxy: BSC_PROXY, tx: destTx, sources: [] };
for (const u of BSC_RPCS) {
  const rc = await retry(() =>
    rpc(u, "eth_getTransactionReceipt", [destTx], { log: LOG }),
  );
  const tx = await retry(() =>
    rpc(u, "eth_getTransactionByHash", [destTx], { log: LOG }),
  );
  const b = await retry(() =>
    rpc(u, "eth_getBlockByNumber", [rc.blockNumber, false], { log: LOG }),
  );
  const fin = await retry(() =>
    rpc(u, "eth_getBlockByNumber", ["finalized", false], { log: LOG }),
  );
  const chainId = Number(
    BigInt(await retry(() => rpc(u, "eth_chainId", [], { log: LOG }))),
  );
  dst.sources.push({
    url: u,
    chainId,
    receipt: rc,
    tx,
    block: b,
    finalizedBlock: Number(BigInt(fin.number)),
  });
}
const d0 = dst.sources[0];
const dblk = d0.block,
  drc = d0.receipt,
  dtx = d0.tx;
dst.block = Number(BigInt(dblk.number));
dst.blockHash = dblk.hash;
dst.timestamp = Number(BigInt(dblk.timestamp));
check(
  "dest.chainId",
  dst.sources.every((s) => s.chainId === 56),
  null,
);
check(
  "dest.blockHashAgreesAcrossRpcs",
  dst.sources.every(
    (s) => eq(s.block.hash, dblk.hash) && eq(s.receipt.blockHash, dblk.hash),
  ),
  dst.sources.map((s) => s.block.hash),
);
check(
  "dest.receiptIdenticalAcrossRpcs",
  dst.sources.every(
    (s) =>
      JSON.stringify(s.receipt.logs) === JSON.stringify(drc.logs) &&
      s.receipt.status === drc.status,
  ),
  null,
);
dst.recomputedHeaderHash = headerHash(dblk);
check("dest.headerHashRecomputed", eq(dst.recomputedHeaderHash, dblk.hash), {
  recomputed: dst.recomputedHeaderHash,
});
const blockReceipts = await retry(() =>
  rpc(BSC_RPCS[0], "eth_getBlockReceipts", [drc.blockNumber], { log: LOG }),
);
dst.receiptProof = await receiptProof(
  blockReceipts,
  drc.transactionIndex,
  dblk.receiptsRoot,
);
check("dest.receiptsRootRecomputed", dst.receiptProof.ROOT_MATCH, {
  computed: dst.receiptProof.computedRoot,
  header: dblk.receiptsRoot,
});
check(
  "dest.receiptMerkleProofVerifies",
  dst.receiptProof.PROOF_VERIFIES &&
    (await verifyStoredProof(dst.receiptProof)),
  null,
);
check("dest.receiptStatusSuccess", BigInt(drc.status) === 1n, drc.status);
check("dest.txTo=proxy", eq(dtx.to, BSC_PROXY), dtx.to);
const dl = drc.logs.map((l) => ({ l, d: decodeLog(l) }));
const fins = dl.filter(
  (x) =>
    x.d?.event === "BridgeFinalized" &&
    eq(x.l.address, BSC_PROXY) &&
    x.d.args.index === INDEX,
);
check("dest.exactlyOneBridgeFinalizedForIndex", fins.length === 1, fins.length);
const fe = fins[0].d.args,
  finLogIndex = Number(BigInt(fins[0].l.logIndex));
dst.event = { logIndex: finLogIndex, ...ser(fe) };
check("dest.fromChainID=612055", fe.fromChainID === 612055n, fe.fromChainID);
check("dest.toToken=CROSS", eq(fe.toToken, CROSS), fe.toToken);
const tr = dl.filter(
  (x) =>
    x.d?.event === "Transfer" &&
    eq(x.l.address, CROSS) &&
    eq(x.d.args.from, BSC_PROXY) &&
    eq(x.d.args.to, fe.to) &&
    x.d.args.value === fe.value,
);
check(
  "dest.canonicalCrossTransferBridgeToRecipient",
  tr.length >= 1,
  tr.length,
);
const trBefore = tr.filter((x) => Number(BigInt(x.l.logIndex)) < finLogIndex);
dst.transfer = tr[0]
  ? { logIndex: Number(BigInt(tr[0].l.logIndex)), ...ser(tr[0].d.args) }
  : null;
check("dest.transferPrecedesFinalized", trBefore.length >= 1, dst.transfer);
check(
  "dest.noPendingEventForIndex",
  !dl.some((x) => x.d?.event === "BridgePending" && x.d.args.index === INDEX),
  null,
);
dst.finalizedTagBlock = Math.min(...dst.sources.map((s) => s.finalizedBlock));
check(
  "dest.blockFinalized(finalized tag)",
  dst.finalizedTagBlock >= dst.block,
  { finalizedTag: dst.finalizedTagBlock, block: dst.block },
);
// implementation active at destination block (archive state)
const slotAt = await retry(() =>
  rpc(BSC_ARCHIVE, "eth_getStorageAt", [BSC_PROXY, IMPL_SLOT, hx(dst.block)], {
    log: LOG,
  }),
);
const implAt = "0x" + slotAt.slice(-40);
const implCodeAt = await retry(() =>
  rpc(BSC_ARCHIVE, "eth_getCode", [implAt, hx(dst.block)], { log: LOG }),
);
dst.implementationAtBlock = {
  slot: slotAt,
  implementation: implAt,
  codeKeccak256: keccak256(implCodeAt),
  rpc: BSC_ARCHIVE,
};
check(
  "dest.implementationAtBlock=exactBuildImpl",
  eq(implAt, EXPECT.bscImpl) && eq(keccak256(implCodeAt), EXPECT.bscImplHash),
  dst.implementationAtBlock,
);
// validator signatures from public finalize calldata
const sig = await recoverFinalizeSigners(dtx.input, 56, BSC_PROXY, INDEX);
const at = hx(dst.block);
const ec = async (fn, args = []) =>
  decodeFunctionResult({
    abi: bridgeAbi,
    functionName: fn,
    data: await retry(() =>
      rpc(
        BSC_ARCHIVE,
        "eth_call",
        [
          {
            to: BSC_PROXY,
            data: encodeFunctionData({
              abi: bridgeAbi,
              functionName: fn,
              args,
            }),
          },
          at,
        ],
        { log: LOG },
      ),
    ),
  });
const validators = await ec("getRoleMembers", [
  keccak256(toHex("VALIDATOR_ROLE")),
]);
const threshold = await ec("threshold");
const liveDomain = await ec("domainSeparator");
const uniqueValid = [
  ...new Set(sig.signers.map((x) => x.toLowerCase())),
].filter((x) => validators.some((v) => eq(v, x)));
dst.validatorSignatures = {
  ...ser(sig),
  validatorsAtBlock: validators,
  thresholdAtBlock: Number(threshold),
  liveDomainSeparatorAtBlock: liveDomain,
  uniqueValidSigners: uniqueValid,
};
check("dest.domainSeparatorMatchesLive", eq(sig.domainSeparator, liveDomain), {
  computed: sig.domainSeparator,
  live: liveDomain,
});
check(
  "dest.signedArgsMatchEvent",
  sig.args.fromChainID === 612055n &&
    sig.args.index === INDEX &&
    eq(sig.args.toToken, CROSS) &&
    eq(sig.args.to, fe.to) &&
    sig.args.value === fe.value,
  ser(sig.args),
);
check(
  "dest.signersAscendingUnique",
  sig.signers.every(
    (x, i) => i === 0 || BigInt(x) > BigInt(sig.signers[i - 1]),
  ),
  sig.signers,
);
check(
  "dest.validSignatures>=threshold",
  uniqueValid.length >= Number(threshold),
  { valid: uniqueValid.length, threshold: Number(threshold) },
);

// ---------------- CROSS-CHAIN BINDING ----------------
check("bind.sameIndex", si.index === fe.index, null);
check("bind.sameRecipient", eq(si.to, fe.to), { src: si.to, dst: fe.to });
check("bind.samePrincipal", si.value === fe.value, {
  src: si.value,
  dst: fe.value,
});
check("bind.sameToken", eq(si.toToken, fe.toToken), null);
check(
  "bind.routeDirection",
  si.toChainID === 56n && fe.fromChainID === 612055n,
  null,
);
check("bind.sourceBeforeDestination", src.timestamp <= dst.timestamp, {
  source: src.timestamp,
  destination: dst.timestamp,
});
check(
  "bind.signedValueEqualsSourceValue",
  sig.args.value === si.value && eq(sig.args.to, si.to),
  null,
);

const pass = checks.every((c) => c.ok);
const proof = {
  label,
  at: now(),
  result: pass ? "PASS" : "FAIL",
  index: INDEX.toString(),
  mptLibrary: MPT_VERSION,
  trust: {
    source:
      "ONCHAIN_RPC x2 (to-nexus official endpoints) + OFFICIAL_EXPLORER_INDEX block hash + header/receipt-trie recomputation (DERIVED)",
    destination:
      "ONCHAIN_RPC x2 operators (BNB Chain official, NodeReal) + archive state (BlastAPI) + header/receipt-trie recomputation (DERIVED)",
  },
  summary: {
    source: {
      tx: sourceTx,
      block: src.block,
      blockHash: src.blockHash,
      timestamp: new Date(src.timestamp * 1000).toISOString(),
      proxy: ONE_PROXY,
      logIndex: src.event.logIndex,
      from: si.from,
      to: si.to,
      value: si.value.toString(),
      networkFee: si.networkFee.toString(),
      exFee: si.exFee.toString(),
      confirmations: src.confirmations,
    },
    destination: {
      tx: destTx,
      block: dst.block,
      blockHash: dst.blockHash,
      timestamp: new Date(dst.timestamp * 1000).toISOString(),
      proxy: BSC_PROXY,
      transferLogIndex: dst.transfer?.logIndex,
      finalizedLogIndex: finLogIndex,
      to: fe.to,
      value: fe.value.toString(),
      finalizedTagBlock: dst.finalizedTagBlock,
      implementation: implAt,
      validSigners: uniqueValid.length,
      threshold: Number(threshold),
    },
  },
  checks,
  source: {
    ...src,
    sources: src.sources.map((s) => ({
      url: s.url,
      chainId: s.chainId,
      head: s.head,
      blockHash: s.block.hash,
      receiptCount: s.receipts.length,
    })),
    header: { ...sblk, transactions: undefined },
    tx: stx,
    receipt: srcRcpt,
  },
  destination: {
    ...dst,
    sources: dst.sources.map((s) => ({
      url: s.url,
      chainId: s.chainId,
      blockHash: s.block.hash,
      finalizedBlock: s.finalizedBlock,
    })),
    header: { ...dblk, transactions: undefined },
    tx: dtx,
    receipt: drc,
  },
};
const w = writeJson(`payouts/payout-proof-${label}.json`, proof);
console.log(
  JSON.stringify(
    {
      result: proof.result,
      failed: checks.filter((c) => !c.ok),
      summary: proof.summary,
      w,
    },
    null,
    1,
  ),
);
