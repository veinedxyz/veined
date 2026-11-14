// V1.6 G5 forensic unit tests: runtime-drift policy, exact reserve model, payout-proof correlation,
// offline cryptographic re-verification of the recorded proofs and the exact-build byte equality.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  G5_ROUTE_PINS,
  GLOBAL_EXECUTION_ENABLED,
  evaluateRouteDrift,
  isBridgeContract,
  type ObservedRoute,
} from "../../src/g5/route-pins";
import {
  deriveSpendableReserve,
  type ReserveInput,
} from "../../src/g5/reserve";
import {
  verifyPayoutCorrelation,
  type DestinationSide,
  type SourceSide,
} from "../../src/g5/payout-proof";
import { READ_ONLY_DEPLOYMENT } from "../../src/adapters/deployment";
import { CROSS, NATIVE } from "../../src/core/model";
// Forensic helpers are plain ESM scripts (also used to produce the evidence).
import {
  decodeCbor,
  parseCborFooter,
  base58,
} from "../../scripts/g5-v16-lib.mjs";
import {
  compareRuntime,
  extractConstructorArgs,
  firstMismatch,
  implementationAt,
  splitCbor,
  substituteImmutables,
} from "../../scripts/g5-v16-bytecode.mjs";
import {
  headerHash,
  verifyStoredProof,
  encodeReceipt,
  istanbulFilteredExtra,
  recoverFinalizeSigners,
} from "../../scripts/g5-v16-proof-lib.mjs";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/g5/${name}`, import.meta.url), "utf8"),
  );

function observedBaseline(): ObservedRoute {
  const s = G5_ROUTE_PINS.source,
    d = G5_ROUTE_PINS.destination;
  return {
    source: {
      chainId: s.chainId,
      trust: {
        threshold: s.settlement.threshold,
        validators: [...s.settlement.validators],
        admins: [...s.settlement.admins],
        verifierRole: [...s.settlement.verifierRole],
      },
      proxyCodeHash: s.proxyCodeHash,
      implementation: s.implementation,
      implementationCodeHash: s.implementationCodeHash,
      verifier: s.verifier,
      verifierCodeHash: s.verifierCodeHash,
      pair: { ...s.pair, paused: false },
      paused: false,
      finalizePaused: false,
    },
    destination: {
      chainId: d.chainId,
      trust: {
        threshold: d.settlement.threshold,
        validators: [...d.settlement.validators].reverse(),
        admins: [...d.settlement.admins],
        verifierRole: [...d.settlement.verifierRole],
      },
      proxyCodeHash: d.proxyCodeHash,
      implementation: d.implementation,
      implementationCodeHash: d.implementationCodeHash,
      verifier: d.verifier,
      verifierCodeHash: d.verifierCodeHash,
      pair: { ...d.pair, paused: false },
      paused: false,
      finalizePaused: false,
      tokenCodeHash: d.tokenCodeHash,
    },
  };
}
const H = (c: string) => `0x${c.repeat(64)}`;

describe("V1.6 route runtime-drift policy (§59, §84)", () => {
  it("baseline pins are read-only verified and never executable", () => {
    const r = evaluateRouteDrift(observedBaseline());
    expect(r).toEqual({
      state: "VERIFIED_READ_ONLY",
      reasons: [],
      executable: false,
    });
    expect(GLOBAL_EXECUTION_ENABLED).toBe(false);
  });
  it("adapter deployment registry equals the G5 evidence pins", () => {
    expect(READ_ONLY_DEPLOYMENT.sourceImplementation).toBe(
      G5_ROUTE_PINS.source.implementation,
    );
    expect(READ_ONLY_DEPLOYMENT.destinationImplementation).toBe(
      G5_ROUTE_PINS.destination.implementation,
    );
    expect(READ_ONLY_DEPLOYMENT.sourceCodeHash).toBe(
      G5_ROUTE_PINS.source.implementationCodeHash,
    );
    expect(READ_ONLY_DEPLOYMENT.destinationCodeHash).toBe(
      G5_ROUTE_PINS.destination.implementationCodeHash,
    );
    expect(READ_ONLY_DEPLOYMENT.sourceProxyCodeHash).toBe(
      G5_ROUTE_PINS.source.proxyCodeHash,
    );
    expect(READ_ONLY_DEPLOYMENT.destinationProxyCodeHash).toBe(
      G5_ROUTE_PINS.destination.proxyCodeHash,
    );
    expect(READ_ONLY_DEPLOYMENT.sourceVerifier).toBe(
      G5_ROUTE_PINS.source.verifier,
    );
    expect(READ_ONLY_DEPLOYMENT.destinationVerifier).toBe(
      G5_ROUTE_PINS.destination.verifier,
    );
  });
  const mutations: [string, (o: ObservedRoute) => void, string][] = [
    [
      "source implementation",
      (o) => {
        o.source.implementation = "0x" + "1".repeat(40);
      },
      "SOURCE_IMPLEMENTATION_CHANGED",
    ],
    [
      "source implementation code",
      (o) => {
        o.source.implementationCodeHash = H("a");
      },
      "SOURCE_IMPLEMENTATION_CODE_CHANGED",
    ],
    [
      "destination implementation",
      (o) => {
        o.destination.implementation = "0x" + "2".repeat(40);
      },
      "DESTINATION_IMPLEMENTATION_CHANGED",
    ],
    [
      "destination implementation code",
      (o) => {
        o.destination.implementationCodeHash = H("b");
      },
      "DESTINATION_IMPLEMENTATION_CODE_CHANGED",
    ],
    [
      "source proxy hash",
      (o) => {
        o.source.proxyCodeHash = H("c");
      },
      "SOURCE_PROXY_CODE_CHANGED",
    ],
    [
      "destination proxy hash",
      (o) => {
        o.destination.proxyCodeHash = H("d");
      },
      "DESTINATION_PROXY_CODE_CHANGED",
    ],
    [
      "source verifier",
      (o) => {
        o.source.verifier = "0x" + "3".repeat(40);
      },
      "SOURCE_VERIFIER_CHANGED",
    ],
    [
      "destination verifier code",
      (o) => {
        o.destination.verifierCodeHash = H("e");
      },
      "DESTINATION_VERIFIER_CODE_CHANGED",
    ],
    [
      "destination token pair",
      (o) => {
        o.destination.pair.isOrigin = false;
      },
      "DESTINATION_PAIR_CHANGED",
    ],
    [
      "source token pair",
      (o) => {
        o.source.pair.remoteToken = "0x" + "4".repeat(40);
      },
      "SOURCE_PAIR_CHANGED",
    ],
    [
      "token code",
      (o) => {
        o.destination.tokenCodeHash = H("f");
      },
      "DESTINATION_TOKEN_CODE_CHANGED",
    ],
    [
      "chain id",
      (o) => {
        o.destination.chainId = 97;
      },
      "DESTINATION_CHAIN_MISMATCH",
    ],
    [
      "destination threshold lowered",
      (o) => {
        o.destination.trust.threshold = 1;
      },
      "DESTINATION_THRESHOLD_CHANGED",
    ],
    [
      "destination validator added",
      (o) => {
        o.destination.trust.validators.push("0x" + "6".repeat(40));
      },
      "DESTINATION_VALIDATORS_CHANGED",
    ],
    [
      "source validator replaced",
      (o) => {
        o.source.trust.validators[0] = "0x" + "7".repeat(40);
      },
      "SOURCE_VALIDATORS_CHANGED",
    ],
    [
      "destination admin changed",
      (o) => {
        o.destination.trust.admins = ["0x" + "8".repeat(40)];
      },
      "DESTINATION_ADMINS_CHANGED",
    ],
    [
      "destination VERIFIER_ROLE added",
      (o) => {
        o.destination.trust.verifierRole.push("0x" + "9".repeat(40));
      },
      "DESTINATION_VERIFIER_ROLE_CHANGED",
    ],
  ];
  for (const [name, mutate, reason] of mutations)
    it(`mutating ${name} -> REVIEW_REQUIRED`, () => {
      const o = observedBaseline();
      mutate(o);
      const r = evaluateRouteDrift(o);
      expect(r.state).toBe("REVIEW_REQUIRED");
      expect(r.reasons).toContain(reason);
      expect(r.executable).toBe(false);
    });
  it("pause states -> PAUSED (non-executable), drift wins over pause", () => {
    for (const k of [
      "source.paused",
      "source.pair.paused",
      "destination.paused",
      "destination.pair.paused",
      "destination.finalizePaused",
    ]) {
      const o = observedBaseline();
      const [a, b, c] = k.split(".");
      if (c)
        (
          o as unknown as Record<
            string,
            Record<string, Record<string, boolean>>
          >
        )[a][b][c] = true;
      else
        (o as unknown as Record<string, Record<string, boolean>>)[a][b] = true;
      expect(evaluateRouteDrift(o).state).toBe("PAUSED");
      o.destination.implementationCodeHash = H("9");
      expect(evaluateRouteDrift(o).state).toBe("REVIEW_REQUIRED");
    }
  });
  it("CBU-09 guard: bridge/token contracts are recognised (server-side quote guard)", () => {
    expect(
      isBridgeContract(
        G5_ROUTE_PINS.destination.proxy.toUpperCase().replace("0X", "0x"),
      ),
    ).toBe(true);
    expect(isBridgeContract(G5_ROUTE_PINS.source.proxy)).toBe(true);
    expect(isBridgeContract(CROSS)).toBe(true);
    expect(isBridgeContract("0x28136a77ec8ba3d918114712a588b4095ba12a6b")).toBe(
      false,
    );
  });
});

const E18 = 10n ** 18n;
function reserveInput(over: Partial<ReserveInput> = {}): ReserveInput {
  // Values observed at the V1.6 pinned BSC block 125733110 (two operators, identical state).
  return {
    token: CROSS,
    balance: 913927602480683554383750352n,
    deposited: 913927592480683554383750352n,
    pendingAmount: 0n,
    pending: [{ index: 20n, toToken: CROSS, value: 0n }],
    pendingComplete: true,
    inFlight: { enumerated: true, expectedCount: 0, values: [] },
    sourceMinted: 928704702480683554383750352n,
    minimum: 5n * E18,
    driftState: "VERIFIED_READ_ONLY",
    ...over,
  };
}

describe("V1.6 exact reserve model (§25-§30, §82)", () => {
  it("pinned snapshot: spendable = min(balance, deposited) - pending - in-flight", () => {
    const r = deriveSpendableReserve(reserveInput());
    expect(r.verified).toBe(true);
    expect(r.spendable).toBe(913927592480683554383750352n);
    expect(r.surplus).toBe(10n * E18);
    expect(r.anomalies).toEqual([
      "BALANCE_ABOVE_DEPOSITED_UNSPENDABLE_SURPLUS",
    ]);
    expect(r.effectiveMaximum).toBe(r.spendable);
    expect(r.routeMinimum).toBe(5n * E18);
  });
  it("balance below deposited bounds the reserve by the physical balance", () => {
    const r = deriveSpendableReserve(
      reserveInput({ balance: 100n * E18, deposited: 200n * E18 }),
    );
    expect(r.spendable).toBe(100n * E18);
    expect(r.anomalies).toContain("BALANCE_BELOW_DEPOSITED");
  });
  it("pending and in-flight obligations reduce spendable exactly once", () => {
    const r = deriveSpendableReserve(
      reserveInput({
        balance: 100n * E18,
        deposited: 100n * E18,
        pendingAmount: 7n * E18,
        pending: [{ index: 9n, toToken: CROSS, value: 7n * E18 }],
        inFlight: {
          enumerated: true,
          expectedCount: 2,
          values: [3n * E18, 1n * E18],
        },
      }),
    );
    expect(r.obligations).toBe(11n * E18);
    expect(r.spendable).toBe(89n * E18);
    expect(r.verified).toBe(true);
  });
  it("pending records for other tokens do not count against CROSS", () => {
    const r = deriveSpendableReserve(
      reserveInput({
        pending: [
          {
            index: 1n,
            toToken: "0x55d398326f99059fF775485246999027B3197955",
            value: 9n * E18,
          },
        ],
      }),
    );
    expect(r.verified).toBe(true);
  });
  it("fails closed on mismatched pendingAmount, duplicate index, incomplete sets, unenumerated in-flight, drift", () => {
    expect(
      deriveSpendableReserve(reserveInput({ pendingAmount: 1n })).reasons,
    ).toContain("PENDING_AMOUNT_MISMATCH");
    expect(
      deriveSpendableReserve(
        reserveInput({
          pending: [
            { index: 20n, toToken: CROSS, value: 0n },
            { index: 20n, toToken: CROSS, value: 0n },
          ],
        }),
      ).reasons,
    ).toContain("DUPLICATE_PENDING_INDEX");
    expect(
      deriveSpendableReserve(reserveInput({ pendingComplete: false })).reasons,
    ).toContain("PENDING_SET_INCOMPLETE");
    expect(
      deriveSpendableReserve(
        reserveInput({
          inFlight: { enumerated: false, expectedCount: 9, values: [] },
        }),
      ).reasons,
    ).toContain("IN_FLIGHT_UNENUMERATED");
    expect(
      deriveSpendableReserve(
        reserveInput({
          inFlight: { enumerated: true, expectedCount: 2, values: [1n] },
        }),
      ).reasons,
    ).toContain("IN_FLIGHT_UNENUMERATED");
    expect(
      deriveSpendableReserve(reserveInput({ driftState: "REVIEW_REQUIRED" }))
        .verified,
    ).toBe(false);
  });
  it("max is bounded by source minted and reserve below minimum is rejected", () => {
    expect(
      deriveSpendableReserve(reserveInput({ sourceMinted: 6n * E18 }))
        .effectiveMaximum,
    ).toBe(6n * E18);
    const r = deriveSpendableReserve(
      reserveInput({ balance: 4n * E18, deposited: 4n * E18 }),
    );
    expect(r.reasons).toContain("RESERVE_BELOW_ROUTE_MINIMUM");
    expect(() =>
      deriveSpendableReserve(reserveInput({ balance: -1n })),
    ).toThrow("NEGATIVE_INPUT");
  });
});

type ProofFixture = {
  index: string;
  source: SourceSide & {
    tx: string;
    header: Record<string, string>;
    receiptProof: {
      expectedRoot: string;
      key: string;
      proofNodes: string[];
      encodedReceipt: string;
    };
    event: Record<string, string>;
  };
  destination: DestinationSide & {
    header: Record<string, string>;
    receiptProof: {
      expectedRoot: string;
      key: string;
      proofNodes: string[];
      encodedReceipt: string;
    };
    event: Record<string, string>;
    transfer: Record<string, string | number>;
    signers: string[];
    digest: string;
    txInput: string;
    validatorsAtBlock: string[];
    thresholdAtBlock: number;
  };
};
const proofs: ProofFixture[] = fixture("payout-proofs.json").proofs;

function sides(p: ProofFixture): [SourceSide, DestinationSide] {
  const se = p.source.event,
    de = p.destination.event,
    t = p.destination.transfer;
  return [
    {
      chainId: 612055,
      emitter: p.source.emitter,
      receiptStatus: p.source.receiptStatus,
      blockHash: p.source.blockHash,
      canonicalBlockHash: p.source.blockHash,
      event: {
        toChainID: BigInt(se.toChainID),
        index: BigInt(se.index),
        fromToken: se.fromToken,
        toToken: se.toToken,
        to: se.to,
        value: BigInt(se.value),
      },
    },
    {
      chainId: 56,
      emitter: p.destination.emitter,
      receiptStatus: p.destination.receiptStatus,
      blockHash: p.destination.blockHash,
      canonicalBlockHash: p.destination.blockHash,
      implementationAtBlock: p.destination.implementationAtBlock,
      finalizationsForIndex: 1,
      finalizedLogIndex: Number(de.logIndex),
      event: {
        fromChainID: BigInt(de.fromChainID),
        index: BigInt(de.index),
        toToken: de.toToken,
        to: de.to,
        value: BigInt(de.value),
      },
      transfer: {
        token: CROSS,
        from: String(t.from),
        to: String(t.to),
        value: BigInt(t.value),
        logIndex: Number(t.logIndex),
      },
    },
  ];
}

describe("V1.6 payout proofs (§33-§36, §83)", () => {
  it("three recorded proofs (indices 98483, 98728, 98727) correlate and are distinct", () => {
    expect(proofs.map((p) => p.index)).toEqual(["98483", "98728", "98727"]);
    expect(new Set(proofs.map((p) => p.source.tx)).size).toBe(3);
    for (const p of proofs)
      expect(verifyPayoutCorrelation(...sides(p))).toEqual({
        ok: true,
        failures: [],
      });
  });
  it("receipt-trie Merkle proofs and recomputed header hashes verify offline", async () => {
    for (const p of proofs)
      for (const side of [p.source, p.destination]) {
        expect(await verifyStoredProof(side.receiptProof)).toBe(true);
        expect(side.receiptProof.expectedRoot).toBe(
          side.header.receiptsRoot.toLowerCase(),
        );
        expect(headerHash(side.header)).toBe(side.blockHash);
      }
  });
  it("tampered receipt or wrong root fails the Merkle proof", async () => {
    const rp = proofs[1].destination.receiptProof;
    expect(
      await verifyStoredProof({
        ...rp,
        encodedReceipt: rp.encodedReceipt.slice(0, -2) + "00",
      }),
    ).toBe(false);
    expect(await verifyStoredProof({ ...rp, expectedRoot: H("1") })).toBe(
      false,
    );
  });
  it("tampered header (receiptsRoot) changes the recomputed block hash", () => {
    const h = { ...proofs[0].source.header, receiptsRoot: H("2") };
    expect(headerHash(h)).not.toBe(proofs[0].source.blockHash);
  });
  it("validator EIP-712 signatures re-recovered offline from the public finalize calldata", async () => {
    for (const p of proofs) {
      const r = await recoverFinalizeSigners(
        p.destination.txInput,
        56,
        G5_ROUTE_PINS.destination.proxy,
        BigInt(p.index),
      );
      expect(r.digest).toBe(p.destination.digest);
      expect(r.signers).toEqual(p.destination.signers);
      const valid = new Set(
        r.signers
          .map((s: string) => s.toLowerCase())
          .filter((s: string) =>
            p.destination.validatorsAtBlock.some((v) => v.toLowerCase() === s),
          ),
      );
      expect(valid.size).toBeGreaterThanOrEqual(p.destination.thresholdAtBlock);
      // A signature over a different index recovers to an unrelated address (no reuse across indices).
      const other = await recoverFinalizeSigners(
        p.destination.txInput,
        97,
        G5_ROUTE_PINS.destination.proxy,
        BigInt(p.index),
      );
      expect(
        other.signers.some((s: string) =>
          p.destination.validatorsAtBlock.some(
            (v) => v.toLowerCase() === s.toLowerCase(),
          ),
        ),
      ).toBe(false);
    }
  });
  const negatives: [
    string,
    (s: SourceSide, d: DestinationSide) => void,
    string,
  ][] = [
    [
      "wrong index",
      (_, d) => {
        d.event.index += 1n;
      },
      "INDEX_MISMATCH",
    ],
    [
      "wrong recipient",
      (_, d) => {
        d.event.to = "0x" + "5".repeat(40);
      },
      "RECIPIENT_MISMATCH",
    ],
    [
      "wrong amount",
      (_, d) => {
        d.event.value -= 1n;
      },
      "AMOUNT_MISMATCH",
    ],
    [
      "wrong token",
      (s) => {
        s.event.toToken = NATIVE;
      },
      "TOKEN_MISMATCH",
    ],
    [
      "wrong block hash",
      (s) => {
        s.canonicalBlockHash = H("6");
      },
      "SOURCE_NONCANONICAL",
    ],
    [
      "failed receipt",
      (_, d) => {
        d.receiptStatus = 0;
      },
      "DESTINATION_RECEIPT_FAILED",
    ],
    [
      "noncanonical destination",
      (_, d) => {
        d.canonicalBlockHash = H("7");
      },
      "DESTINATION_NONCANONICAL",
    ],
    [
      "duplicate finalization",
      (_, d) => {
        d.finalizationsForIndex = 2;
      },
      "DUPLICATE_OR_MISSING_FINALIZATION",
    ],
    [
      "Transfer missing",
      (_, d) => {
        d.transfer = null;
      },
      "TRANSFER_MISSING",
    ],
    [
      "event order mismatch",
      (_, d) => {
        if (d.transfer) d.transfer.logIndex = d.finalizedLogIndex + 1;
      },
      "EVENT_ORDER_MISMATCH",
    ],
    [
      "implementation mismatch at historical block",
      (_, d) => {
        d.implementationAtBlock = "0x71f6901b99d4b50c81b1a9c5a405dcf57f162e54";
      },
      "DESTINATION_IMPLEMENTATION_MISMATCH",
    ],
    [
      "wrong emitter",
      (s) => {
        s.emitter = "0x" + "8".repeat(40);
      },
      "SOURCE_EMITTER",
    ],
  ];
  for (const [name, mutate, failure] of negatives)
    it(`rejects ${name}`, () => {
      const [s, d] = sides(proofs[1]);
      mutate(s, d);
      const r = verifyPayoutCorrelation(s, d);
      expect(r.ok).toBe(false);
      expect(r.failures).toContain(failure);
    });
});

describe("V1.6 build forensics (§13, §17-§19, §81)", () => {
  for (const chain of ["one", "bsc"] as const) {
    const b = fixture(`build-${chain}.json`);
    it(`${chain}: full deployed runtime equals live after immutable substitution only`, () => {
      const r = compareRuntime(b.deployed, b.liveRuntime);
      expect(r.FULL_RUNTIME_EQUAL).toBe(true);
      expect(r.cborEqual).toBe(true);
      expect(r.liveKeccak256).toBe(
        chain === "one"
          ? G5_ROUTE_PINS.source.implementationCodeHash
          : G5_ROUTE_PINS.destination.implementationCodeHash,
      );
      // the only immutable is UUPS __self = the implementation's own address
      const impl =
        chain === "one"
          ? G5_ROUTE_PINS.source.implementation
          : G5_ROUTE_PINS.destination.implementation;
      expect(r.substitutions.length).toBe(2);
      for (const s of r.substitutions)
        expect(s.live).toBe(impl.slice(2).padStart(64, "0"));
    });
    it(`${chain}: creation code equals the on-chain creation input exactly (no constructor args)`, () => {
      expect(extractConstructorArgs(b.creation, b.creationInput)).toEqual({
        prefixEqual: true,
        args: "0x",
        firstMismatchOffset: null,
      });
    });
    it(`${chain}: metadata IPFS CIDv0 equals the live CBOR hash`, () => {
      const meta = Buffer.from(b.metadata, "utf8");
      const varint = (n: number) => {
        const o: number[] = [];
        do {
          let x = n & 0x7f;
          n >>>= 7;
          if (n) x |= 0x80;
          o.push(x);
        } while (n);
        return Buffer.from(o);
      };
      const unixfs = Buffer.concat([
        Buffer.from([8, 2, 0x12]),
        varint(meta.length),
        meta,
        Buffer.from([0x18]),
        varint(meta.length),
      ]);
      const node = Buffer.concat([
        Buffer.from([0x0a]),
        varint(unixfs.length),
        unixfs,
      ]);
      const cid = base58(
        Buffer.concat([
          Buffer.from([0x12, 0x20]),
          createHash("sha256").update(node).digest(),
        ]),
      );
      expect(cid).toBe(b.expectedCid);
      expect(parseCborFooter(b.liveRuntime).ipfs).toBe(b.expectedCid);
      expect(parseCborFooter(b.liveRuntime).solc).toBe("0.8.28");
      expect(JSON.parse(b.metadata).settings).toMatchObject({
        evmVersion: "prague",
        optimizer: { enabled: true, runs: 1 },
        viaIR: true,
        metadata: { bytecodeHash: "ipfs" },
      });
    });
    it(`${chain}: a single flipped byte is detected with its offset`, () => {
      const live = b.liveRuntime.slice(2);
      const tampered =
        "0x" +
        live.slice(0, 200) +
        (live.slice(200, 202) === "00" ? "01" : "00") +
        live.slice(202);
      const r = compareRuntime(b.deployed, tampered);
      expect(r.FULL_RUNTIME_EQUAL).toBe(false);
      expect(r.firstMismatchOffset).toBe(100);
    });
  }
  it("CBOR parser: decodes solc footer, rejects malformed input", () => {
    expect(
      decodeCbor(
        Uint8Array.from([0xa1, 0x64, 0x73, 0x6f, 0x6c, 0x63, 0x43, 0, 8, 28]),
      ),
    ).toEqual({ solc: Buffer.from([0, 8, 28]) });
    expect(() => decodeCbor(Uint8Array.from([0xa1, 0x64, 0x73]))).toThrow();
    expect(() => parseCborFooter("0x6080")).toThrow();
    expect(splitCbor("0x6080aabbcc0003").cbor).toBe("aabbcc0003");
  });
  it("immutable substitution only touches declared ranges and rejects bad refs", () => {
    const r = substituteImmutables(
      "0x00000000ff",
      { "1": [{ start: 1, length: 2 }] },
      "0x0011220000",
    );
    expect(r.hex).toBe("00112200ff");
    expect(() =>
      substituteImmutables("0x00", { "1": [{ start: 0, length: 9 }] }, "0x00"),
    ).toThrow("BAD_IMMUTABLE_REF");
    expect(firstMismatch("0x0102", "0x0103")).toBe(1);
    expect(
      compareRuntime(
        { object: "__$abc$__", immutableReferences: {}, linkReferences: {} },
        "0x00",
      ),
    ).toEqual({ result: "UNLINKED_LIBRARIES" });
  });
  it("upgrade timeline resolves the implementation active at a block", () => {
    const t = [
      {
        block: 63167335,
        implementation: "0x68ceaecff1074121c19027b92a13f36ba62e6c36",
      },
      {
        block: 74593919,
        implementation: "0x71f6901b99d4b50c81b1a9c5a405dcf57f162e54",
      },
      {
        block: 92498159,
        implementation: "0xac7b8ffed19d670930b8caa0693189b33454e8d8",
      },
    ];
    expect(
      implementationAt(
        t,
        125163152,
        "0xd9a946f7f0624fe1a414fb5b3c6455bd6155680a",
      ),
    ).toBe(G5_ROUTE_PINS.destination.implementation);
    expect(implementationAt(t, 80000000, "0xd9")).toBe(
      "0x71f6901b99d4b50c81b1a9c5a405dcf57f162e54",
    );
    expect(implementationAt(t, 50000000, "0xd9")).toBe("0xd9");
  });
  it("receipt encoding and Istanbul header filter reject malformed input", () => {
    expect(() =>
      encodeReceipt({
        status: "0x1",
        cumulativeGasUsed: "0x1",
        logsBloom: "0xzz",
        logs: [],
      }),
    ).toThrow("BAD_HEX");
    expect(() => istanbulFilteredExtra("0xc0")).toThrow("BAD_ISTANBUL_EXTRA");
  });
});
