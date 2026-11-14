// V1.6 G5 proof primitives: receipt RLP, receipts-trie root + Merkle proof (tested @ethereumjs/mpt),
// header RLP -> block hash recomputation, EIP-712 finalize signature recovery. Pure functions over RPC JSON.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  keccak256,
  toRlp,
  fromRlp,
  concatHex,
  encodeAbiParameters,
  recoverAddress,
  hexToBytes,
  bytesToHex,
  toHex,
  decodeFunctionData,
  parseAbi,
  decodeEventLog,
} from "viem";

const req = createRequire(
  createRequire(import.meta.url).resolve("@ethereumjs/vm"),
);
const mpt = await import(pathToFileURL(req.resolve("@ethereumjs/mpt")).href);
export const MPT_VERSION = "@ethereumjs/mpt@10.1.3";

// Minimal big-endian byte string for an RLP integer ("0x0" -> empty string).
export const q = (v) => {
  const n = BigInt(v);
  if (n < 0n) throw new Error("NEGATIVE_QUANTITY");
  return n === 0n ? "0x" : toHex(n);
};
const hexBytes = (h) => {
  if (typeof h !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(h))
    throw new Error(`BAD_HEX ${String(h).slice(0, 20)}`);
  return h.toLowerCase();
};

export function encodeReceipt(r) {
  const status =
    r.status !== undefined && r.status !== null
      ? BigInt(r.status) === 1n
        ? "0x01"
        : "0x"
      : hexBytes(r.root);
  const body = toRlp([
    status,
    q(r.cumulativeGasUsed),
    hexBytes(r.logsBloom),
    r.logs.map((l) => [
      hexBytes(l.address),
      l.topics.map(hexBytes),
      hexBytes(l.data),
    ]),
  ]);
  const type = BigInt(r.type ?? "0x0");
  if (type === 0n) return body;
  if (type > 0x7fn) throw new Error("BAD_TX_TYPE");
  return concatHex([toHex(Number(type), { size: 1 }), body]);
}

const keyFor = (i) => hexToBytes(toRlp(q(i)));

export async function receiptsTrie(receipts) {
  const sorted = [...receipts].sort((a, b) =>
    Number(BigInt(a.transactionIndex) - BigInt(b.transactionIndex)),
  );
  sorted.forEach((r, i) => {
    if (BigInt(r.transactionIndex) !== BigInt(i))
      throw new Error("NON_CONTIGUOUS_RECEIPTS");
  });
  const trie = await mpt.createMPT();
  for (const r of sorted)
    await trie.put(keyFor(r.transactionIndex), hexToBytes(encodeReceipt(r)));
  return { trie, root: bytesToHex(trie.root()), count: sorted.length };
}

export async function receiptProof(receipts, txIndex, expectedRoot) {
  const { trie, root, count } = await receiptsTrie(receipts);
  const key = keyFor(txIndex);
  const proof = await mpt.createMerkleProof(trie, key);
  // verifyMerkleProof(key, proof, { root }) rebuilds a trie from the proof, requires hash(firstNode) == root, then reads key.
  const value = await mpt.verifyMerkleProof(key, proof, {
    root: hexToBytes(expectedRoot),
  });
  const target = receipts.find(
    (r) => BigInt(r.transactionIndex) === BigInt(txIndex),
  );
  const encoded = encodeReceipt(target);
  return {
    computedRoot: root,
    expectedRoot: expectedRoot.toLowerCase(),
    ROOT_MATCH: root === expectedRoot.toLowerCase(),
    receiptCount: count,
    key: bytesToHex(key),
    proofNodes: proof.map(bytesToHex),
    encodedReceipt: encoded,
    PROOF_VERIFIES:
      value !== null && bytesToHex(value) === encoded.toLowerCase(),
  };
}

// Verify a stored proof without the other receipts (what an independent reviewer re-runs).
export async function verifyStoredProof(p) {
  try {
    const value = await mpt.verifyMerkleProof(
      hexToBytes(p.key),
      p.proofNodes.map(hexToBytes),
      { root: hexToBytes(p.expectedRoot) },
    );
    return (
      value !== null && bytesToHex(value) === p.encodedReceipt.toLowerCase()
    );
  } catch {
    return false;
  }
}

const HEADER_FIELDS = [
  ["parentHash", "h"],
  ["sha3Uncles", "h"],
  ["miner", "h"],
  ["stateRoot", "h"],
  ["transactionsRoot", "h"],
  ["receiptsRoot", "h"],
  ["logsBloom", "h"],
  ["difficulty", "q"],
  ["number", "q"],
  ["gasLimit", "q"],
  ["gasUsed", "q"],
  ["timestamp", "q"],
  ["extraData", "h"],
  ["mixHash", "h"],
  ["nonce", "h"],
];
const OPTIONAL = [
  ["baseFeePerGas", "q"],
  ["withdrawalsRoot", "h"],
  ["blobGasUsed", "q"],
  ["excessBlobGas", "q"],
  ["parentBeaconBlockRoot", "h"],
  ["requestsHash", "h"],
];

// go-cross (to-nexus/go-cross core/types/istanbul.go): blocks whose mixHash starts with the 16-byte
// "Cross Istanbul." prefix are hashed over a filtered extra: CommittedSeal=[], Round=0, SignersBitset/Signers dropped.
const ISTANBUL_PREFIX = "0x43726f737320497374616e62756c2e20";
export const isIstanbul = (b) =>
  typeof b.mixHash === "string" &&
  b.mixHash.toLowerCase().startsWith(ISTANBUL_PREFIX);
export function istanbulFilteredExtra(extraHex) {
  const x = fromRlp(hexBytes(extraHex), "hex");
  if (!Array.isArray(x) || x.length < 6 || x.length > 8)
    throw new Error("BAD_ISTANBUL_EXTRA");
  const [vanity, validators, vote, , , randomReveal] = x;
  if (
    typeof vanity !== "string" ||
    !Array.isArray(validators) ||
    typeof randomReveal !== "string"
  )
    throw new Error("BAD_ISTANBUL_EXTRA_TYPES");
  return toRlp([vanity, validators, vote, "0x", [], randomReveal]);
}
export function headerRlp(b) {
  const src = isIstanbul(b)
    ? { ...b, extraData: istanbulFilteredExtra(b.extraData) }
    : b;
  return headerRlpRaw(src);
}
function headerRlpRaw(b) {
  const items = HEADER_FIELDS.map(([k, t]) =>
    t === "q" ? q(b[k]) : hexBytes(b[k]),
  );
  let missing = false;
  for (const [k, t] of OPTIONAL) {
    if (b[k] === undefined || b[k] === null) {
      missing = true;
      continue;
    }
    if (missing) throw new Error(`OPTIONAL_FIELD_GAP before ${k}`);
    items.push(t === "q" ? q(b[k]) : hexBytes(b[k]));
  }
  return toRlp(items);
}
export const headerHash = (b) => keccak256(headerRlp(b));

// --- EIP-712 finalize signatures (exact live source: ValidatorManager + BaseBridge FINALIZE_TYPEHASH) ---
export const FINALIZE_TYPEHASH = keccak256(
  toHex(
    "FinalizeBridge(uint256 fromChainID,uint256 index,address toToken,address to,uint256 value,bytes extraData)",
  ),
);
const DOMAIN_TYPEHASH = keccak256(
  toHex(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
);
export function domainSeparator(chainId, verifyingContract) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        DOMAIN_TYPEHASH,
        keccak256(toHex("Validator")),
        keccak256(toHex("1.0.0")),
        BigInt(chainId),
        verifyingContract,
      ],
    ),
  );
}
export function finalizeDigest(a, domainSep) {
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        FINALIZE_TYPEHASH,
        BigInt(a.fromChainID),
        BigInt(a.index),
        a.toToken,
        a.to,
        BigInt(a.value),
        keccak256(a.extraData),
      ],
    ),
  );
  return {
    structHash,
    digest: keccak256(concatHex(["0x1901", domainSep, structHash])),
  };
}
export const finalizeAbi = parseAbi([
  "function finalizeBridgeBatch((uint256 fromChainID,uint256 index,address toToken,address to,uint256 value,bytes extraData)[] args,uint8[][] v,bytes32[][] r,bytes32[][] s) payable returns (bool)",
]);
export async function recoverFinalizeSigners(input, chainId, proxy, wantIndex) {
  const { args } = decodeFunctionData({ abi: finalizeAbi, data: input });
  const [list, v, r, s] = args;
  const ds = domainSeparator(chainId, proxy);
  const at = list.findIndex((a) => BigInt(a.index) === BigInt(wantIndex));
  if (at < 0) throw new Error("INDEX_NOT_IN_BATCH");
  const a = list[at];
  const { structHash, digest } = finalizeDigest(a, ds);
  const signers = [];
  for (let k = 0; k < v[at].length; k++)
    signers.push(
      await recoverAddress({
        hash: digest,
        signature: { r: r[at][k], s: s[at][k], v: BigInt(v[at][k]) },
      }),
    );
  return {
    batchSize: list.length,
    positionInBatch: at,
    args: a,
    domainSeparator: ds,
    structHash,
    digest,
    signatures: v[at].length,
    signers,
  };
}

export const eventAbi = parseAbi([
  "event BridgeInitiated(uint256 indexed toChainID,uint256 indexed index,address fromToken,address toToken,address indexed from,address to,uint256 value,uint256 networkFee,uint256 exFee,bytes extraData,uint256 time)",
  "event BridgeFinalized(uint256 indexed fromChainID,uint256 indexed index,address indexed toToken,address to,uint256 value,uint256 time)",
  "event BridgePending(uint256 indexed fromChainID,uint256 indexed index,address indexed toToken,address to,uint256 value,uint256 time,uint8 status)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event ManualReleased(uint256 indexed remoteChainID,uint256 indexed index)",
  "event PendingRemoved(uint256 indexed remoteChainID,uint256 indexed index)",
]);
export function decodeLog(l) {
  try {
    const d = decodeEventLog({
      abi: eventAbi,
      data: l.data,
      topics: l.topics,
      strict: true,
    });
    return { event: d.eventName, args: d.args };
  } catch {
    return null;
  }
}
