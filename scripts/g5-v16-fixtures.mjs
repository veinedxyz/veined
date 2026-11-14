// V1.6 G5: derive small offline test fixtures from the evidence root (no network).
// Tests re-verify these cryptographically (receipt-trie proofs, header hashes, byte equality).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE, REPO, sha256 } from "./g5-v16-lib.mjs";

const OUT = join(REPO, "tests", "fixtures", "g5");
mkdirSync(OUT, { recursive: true });
const read = (rel) => JSON.parse(readFileSync(join(EVIDENCE, rel), "utf8"));
const headerKeys = [
  "parentHash",
  "sha3Uncles",
  "miner",
  "stateRoot",
  "transactionsRoot",
  "receiptsRoot",
  "logsBloom",
  "difficulty",
  "number",
  "gasLimit",
  "gasUsed",
  "timestamp",
  "extraData",
  "mixHash",
  "nonce",
  "baseFeePerGas",
  "withdrawalsRoot",
  "blobGasUsed",
  "excessBlobGas",
  "parentBeaconBlockRoot",
  "requestsHash",
  "hash",
];
const header = (h) =>
  Object.fromEntries(
    headerKeys.filter((k) => h[k] !== undefined).map((k) => [k, h[k]]),
  );

const proofs = [];
for (const n of [1, 2, 3]) {
  const p = read(`payouts/payout-proof-${n}.json`);
  if (p.result !== "PASS") throw new Error(`proof ${n} not PASS`);
  proofs.push({
    label: n,
    index: p.index,
    source: {
      chainId: 612055,
      emitter: p.source.proxy,
      receiptStatus: Number(BigInt(p.source.receipt.status)),
      blockHash: p.source.blockHash,
      header: header(p.source.header),
      event: p.source.event,
      tx: p.summary.source.tx,
      receiptProof: {
        expectedRoot: p.source.receiptProof.expectedRoot,
        key: p.source.receiptProof.key,
        proofNodes: p.source.receiptProof.proofNodes,
        encodedReceipt: p.source.receiptProof.encodedReceipt,
      },
    },
    destination: {
      chainId: 56,
      emitter: p.destination.proxy,
      receiptStatus: Number(BigInt(p.destination.receipt.status)),
      blockHash: p.destination.blockHash,
      header: header(p.destination.header),
      event: p.destination.event,
      tx: p.summary.destination.tx,
      transfer: p.destination.transfer,
      finalizedLogIndex: p.destination.event.logIndex,
      implementationAtBlock: p.destination.implementationAtBlock.implementation,
      receiptProof: {
        expectedRoot: p.destination.receiptProof.expectedRoot,
        key: p.destination.receiptProof.key,
        proofNodes: p.destination.receiptProof.proofNodes,
        encodedReceipt: p.destination.receiptProof.encodedReceipt,
      },
      signers: p.destination.validatorSignatures.signers,
      digest: p.destination.validatorSignatures.digest,
      txInput: p.destination.tx.input,
      validatorsAtBlock: p.destination.validatorSignatures.validatorsAtBlock,
      thresholdAtBlock: p.destination.validatorSignatures.thresholdAtBlock,
    },
  });
}
writeFileSync(
  join(OUT, "payout-proofs.json"),
  JSON.stringify(
    { derivedFrom: "evidence payouts/payout-proof-{1,2,3}.json", proofs },
    null,
    1,
  ) + "\n",
);

for (const chain of ["one", "bsc"]) {
  const rep = read(`build/${chain}/reproduction.json`);
  const out = JSON.parse(
    readFileSync(
      join(EVIDENCE, "build", chain, "standard-json-output-native.json"),
      "utf8",
    ),
  );
  const [[path, name]] = Object.entries(rep.compilationTarget);
  const c = out.contracts[path][name];
  const live = readFileSync(
    join(EVIDENCE, "chain-pins", `${chain}-implementation-runtime.hex`),
    "utf8",
  ).trim();
  const creation = readFileSync(
    join(EVIDENCE, "chain-pins", `${chain}-impl-creation-input.hex`),
    "utf8",
  ).trim();
  const metadata = readFileSync(
    join(EVIDENCE, "build", chain, "metadata.json"),
    "utf8",
  );
  writeFileSync(
    join(OUT, `build-${chain}.json`),
    JSON.stringify({
      target: `${path}:${name}`,
      standardJsonInputSha256: rep.standardJsonInputSha256,
      deployed: {
        object: c.evm.deployedBytecode.object,
        immutableReferences: c.evm.deployedBytecode.immutableReferences,
        linkReferences: c.evm.deployedBytecode.linkReferences,
      },
      creation: c.evm.bytecode.object,
      liveRuntime: live,
      creationInput: creation,
      metadata,
      metadataSha256: sha256(metadata),
      expectedCid: rep.metadata.liveCborIpfsCidV0,
    }) + "\n",
  );
}
console.log("fixtures written to", OUT);
