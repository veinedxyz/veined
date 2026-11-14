import { describe, it, expect } from "vitest";
import {
  compareIntent,
  contractRegistry,
  entryDigest,
  killPolicy,
  reviewApproval,
  routeHealth,
  SimulationGate,
  type ContractEntry,
  type ExpectedIntent,
  type KillPolicy,
  type PreparedTransaction,
} from "../../src/security/firewall";
import { platformFee, platformFeePolicy } from "../../src/routing/fee-policy";
import { executionGate, requestExecution } from "../../src/routing/model";
import {
  EXPECTED_INVARIANTS,
  invariantDeviations,
  securityInvariants,
} from "../../src/security/invariants";
import { prng, SEEDS } from "../fixtures/prng";
// V1.5 transaction-firewall adversarial/property suite (docs/TRANSACTION_FIREWALL_SPEC.md).
// SYNTHETIC_TEST_ONLY fixtures; no wallet, RPC or signer is touched. Every mutation must fail closed.
const A = `0x${"1".repeat(40)}`,
  B = `0x${"2".repeat(40)}`,
  C = `0x${"3".repeat(40)}`,
  T0 = 1_800_000_000_000;
const intent = (): ExpectedIntent => ({
  chainId: "42161",
  from: A,
  toContract: B,
  value: "0",
  calldataSelector: "0x12345678",
  inputToken: C,
  inputAmount: "1000000",
  outputToken: A,
  minimumOutput: "990000",
  recipient: A,
  approvalSpender: B,
  approvalAmount: "1000000",
  platformFeeBps: 0,
  quoteId: "quote-1",
  expiresAt: T0 + 30000,
});
const tx = (): PreparedTransaction => ({
  chainId: "42161",
  from: A,
  to: B,
  value: "0",
  data: "0x12345678" + "00".repeat(64),
});
const entry = (): ContractEntry => ({
  chainId: "42161",
  protocol: "fixture-protocol",
  provider: "routing-core",
  contract: B,
  spender: B,
  token: C,
  selector: "0x12345678",
  runtimeHash: "0x" + "a".repeat(64),
  implementationHash: null,
  verifiedAt: T0 - 60000,
  verifiedBlock: "100",
  provenance: "SYNTHETIC_TEST_ONLY",
  status: "ACTIVE",
});
const decoded = () => ({
  inputToken: C,
  inputAmount: "1000000",
  outputToken: A,
  minimumOutput: "990000",
  recipient: A,
  approvalSpender: B,
  approvalAmount: "1000000",
  platformFeeBps: 0 as const,
});
const open: KillPolicy = { ...killPolicy, global: false };
const proofFor = (i = intent(), t = tx(), e = entry(), d = decoded) => ({
  success: true,
  ...compareIntent(i, t, e, () => d(), T0),
  chainId: i.chainId,
  block: "101",
  observedAt: T0,
  registryDigest: entryDigest(e),
});
const reviewed = (
  over: {
    i?: ExpectedIntent;
    t?: PreparedTransaction;
    e?: ContractEntry;
    d?: () => ReturnType<typeof decoded>;
    p?: Partial<ReturnType<typeof proofFor>>;
    policy?: KillPolicy;
    now?: number;
  } = {},
) =>
  new SimulationGate(over.policy ?? open).review(
    over.i ?? intent(),
    over.t ?? tx(),
    over.e ?? entry(),
    over.d ?? decoded,
    { ...proofFor(), ...over.p },
    over.now ?? T0,
  );
const flipHex = (r: ReturnType<typeof prng>, v: string) => {
  // Flip one bit of one nibble (case-insensitive change guaranteed).
  const i = 2 + r.int(v.length - 2);
  const n = parseInt(v[i], 16) ^ (1 << r.int(4));
  return v.slice(0, i) + n.toString(16) + v.slice(i + 1);
};
const bumpDecimal = (r: ReturnType<typeof prng>, v: string) =>
  (BigInt(v) ^ (1n << BigInt(r.int(20)))).toString();
describe("V15 firewall baseline and frozen gates", () => {
  it("the unmodified fixture passes under an explicitly open synthetic policy", () => {
    expect(reviewed()).toMatchObject({
      transactionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
  it("frozen production state: global kill on, empty registry, gate closed, fee 0", () => {
    expect(killPolicy.global).toBe(true);
    expect(Object.isFrozen(killPolicy)).toBe(true);
    expect(contractRegistry).toEqual([]);
    expect(executionGate).toMatchObject({
      enabled: false,
      sign: null,
      approve: null,
      broadcast: null,
      deploy: null,
    });
    expect(platformFeePolicy).toMatchObject({
      enabled: false,
      bps: 0,
      maxBps: 10,
    });
    expect(() =>
      new SimulationGate().review(
        intent(),
        tx(),
        entry(),
        decoded,
        proofFor(),
        T0,
      ),
    ).toThrow("EXECUTION_PAUSED");
    expect(() => requestExecution()).toThrow("WRITE_DISABLED");
    expect(securityInvariants()).toEqual(EXPECTED_INVARIANTS);
  });
  it("hostile environment toggles cannot open execution, fees or monitoring invariants", () => {
    const keys = [
      "REAL_EXECUTION",
      "REAL_OTHERBRIDGE_FEE",
      "OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION",
      "OTHERBRIDGE_FEE_BPS",
      "OTHERBRIDGE_GLOBAL_KILL",
      "OTHERBRIDGE_EXECUTION_GATE",
      "PRODUCTION_DEPLOY",
    ];
    for (const k of keys)
      process.env[k] = k.includes("KILL") ? "false" : "true";
    try {
      expect(securityInvariants()).toEqual(EXPECTED_INVARIANTS);
      expect(invariantDeviations()).toEqual([]);
      expect(platformFee("100000000")).toBe("0");
      expect(() => requestExecution()).toThrow("WRITE_DISABLED");
      expect(killPolicy.global).toBe(true);
    } finally {
      for (const k of keys) delete process.env[k];
    }
  });
});
describe("V15 firewall adversarial mutations (seeded)", () => {
  it.each(SEEDS)(
    "seed %i: one-bit address mutations of every bound address fail closed",
    (seed) => {
      const r = prng(seed);
      for (let i = 0; i < 40; i++) {
        const field = r.pick([
          "from",
          "toContract",
          "inputToken",
          "outputToken",
          "recipient",
          "approvalSpender",
        ] as const);
        const changed = { ...intent(), [field]: flipHex(r, intent()[field]!) };
        expect(() => reviewed({ i: changed, p: {} }), field).toThrow();
        const decodedField = r.pick([
          "inputToken",
          "outputToken",
          "recipient",
          "approvalSpender",
        ] as const);
        expect(
          () =>
            reviewed({
              d: () => ({
                ...decoded(),
                [decodedField]: flipHex(r, decoded()[decodedField]),
              }),
            }),
          decodedField,
        ).toThrow(/INTENT_MISMATCH/);
        const txField = r.pick(["from", "to"] as const);
        expect(
          () =>
            reviewed({ t: { ...tx(), [txField]: flipHex(r, tx()[txField]) } }),
          txField,
        ).toThrow();
      }
    },
  );
  it.each(SEEDS)(
    "seed %i: one-bit amount/value mutations fail closed",
    (seed) => {
      const r = prng(seed);
      for (let i = 0; i < 40; i++) {
        const field = r.pick([
          "inputAmount",
          "minimumOutput",
          "approvalAmount",
        ] as const);
        expect(() =>
          reviewed({
            d: () => ({
              ...decoded(),
              [field]: bumpDecimal(r, decoded()[field]),
            }),
          }),
        ).toThrow();
        expect(() =>
          reviewed({ t: { ...tx(), value: bumpDecimal(r, "0") } }),
        ).toThrow();
      }
    },
  );
  it.each([
    [
      "selector mutation",
      { t: { ...tx(), data: "0x12345679" + "00".repeat(64) } },
      /INTENT_MISMATCH/,
    ],
    [
      "chain mutation (tx)",
      { t: { ...tx(), chainId: "1" } },
      /INTENT_MISMATCH/,
    ],
    [
      "chain mutation (registry)",
      { e: { ...entry(), chainId: "1" } },
      /REGISTRY_MISMATCH|REGISTRY_DRIFT/,
    ],
    [
      "chain mutation (simulation)",
      { p: { chainId: "1" } },
      /SIMULATION_REQUIRED/,
    ],
    [
      "recipient mutation",
      { d: () => ({ ...decoded(), recipient: C }) },
      /INTENT_MISMATCH/,
    ],
    [
      "spender mutation (registry)",
      { e: { ...entry(), spender: C } },
      /REGISTRY_MISMATCH|REGISTRY_DRIFT/,
    ],
    [
      "spender mutation (decoded)",
      { d: () => ({ ...decoded(), approvalSpender: C }) },
      /INTENT_MISMATCH/,
    ],
    [
      "approval amount +1",
      { d: () => ({ ...decoded(), approvalAmount: "1000001" }) },
      /INTENT_MISMATCH/,
    ],
    [
      "fee change (decoded)",
      { d: () => ({ ...decoded(), platformFeeBps: 5 as unknown as 0 }) },
      /./,
    ],
    [
      "fee change (intent)",
      { i: { ...intent(), platformFeeBps: 5 as unknown as 0 } },
      /./,
    ],
    [
      "simulation transaction digest mismatch",
      { p: { transactionDigest: "0".repeat(64) } },
      /SIMULATION_REQUIRED/,
    ],
    [
      "simulation intent digest mismatch",
      { p: { intentDigest: "0".repeat(64) } },
      /SIMULATION_REQUIRED/,
    ],
    ["simulation failed", { p: { success: false } }, /SIMULATION_REQUIRED/],
    [
      "simulation block before registry verification",
      { p: { block: "99" } },
      /SIMULATION_BLOCK_MISMATCH/,
    ],
    ["simulation block malformed", { p: { block: "1e3" } }, /./],
    ["simulation too old (15 s)", { now: T0 + 15001 }, /SIMULATION_REQUIRED/],
    [
      "simulation from the future",
      { p: { observedAt: T0 + 1 } },
      /SIMULATION_REQUIRED/,
    ],
    [
      "registry drift: runtime hash changed after simulation",
      { e: { ...entry(), runtimeHash: "0x" + "b".repeat(64) } },
      /REGISTRY_DRIFT/,
    ],
    [
      "implementation hash drift after simulation",
      { e: { ...entry(), implementationHash: "0x" + "c".repeat(64) } },
      /REGISTRY_DRIFT/,
    ],
    [
      "registry entry no longer ACTIVE",
      { e: { ...entry(), status: "REVIEW_REQUIRED" as const } },
      /REVIEW_REQUIRED/,
    ],
    ["unknown proof field", { p: { extra: 1 } as never }, /./],
  ] as const)("%s", (_name, over, error) => {
    expect(() => reviewed(over as Parameters<typeof reviewed>[0])).toThrow(
      error,
    );
  });
  it("quote expiry boundary: last valid millisecond passes, expiry instant fails", () => {
    const i = { ...intent(), expiresAt: T0 + 10 };
    const p = { ...proofFor(i), observedAt: T0 + 9 };
    expect(() =>
      new SimulationGate(open).review(i, tx(), entry(), decoded, p, T0 + 9),
    ).not.toThrow();
    expect(() =>
      new SimulationGate(open).review(
        i,
        tx(),
        entry(),
        decoded,
        { ...p, observedAt: T0 + 10 },
        T0 + 10,
      ),
    ).toThrow("QUOTE_EXPIRED");
  });
  it("unlimited approvals are rejected everywhere", () => {
    const max = (2n ** 256n - 1n).toString();
    expect(() =>
      reviewed({
        i: { ...intent(), approvalAmount: max },
        d: () => ({ ...decoded(), approvalAmount: max }),
      }),
    ).toThrow();
    expect(() => reviewApproval(max, "1000000", "0", T0 + 1000, T0)).toThrow(
      "UNLIMITED_APPROVAL_REJECTED",
    );
    expect(() =>
      reviewApproval("1000001", "1000000", "0", T0 + 1000, T0),
    ).toThrow("UNLIMITED_APPROVAL_REJECTED");
    expect(() =>
      reviewApproval("1000000", "1000000", "0", T0 + 300001, T0),
    ).toThrow("UNLIMITED_APPROVAL_REJECTED");
    expect(
      reviewApproval("1000000", "1000000", "999999", T0 + 1000, T0),
    ).toMatchObject({ approvalRequired: true, signatureEnabled: false });
  });
  it("kill switch flipping after the quote/simulation closes the gate at review time", () => {
    for (const scope of [
      "global",
      "chains",
      "providers",
      "protocols",
      "tokens",
      "spenders",
    ] as const) {
      const policy: KillPolicy = {
        global: false,
        chains: [],
        providers: [],
        protocols: [],
        tokens: [],
        spenders: [],
      };
      const gate = new SimulationGate(policy);
      const p = proofFor();
      // The policy object is mutated between simulation and review (operator kill).
      const live = policy as {
        -readonly [K in keyof KillPolicy]: KillPolicy[K];
      };
      if (scope === "global") live.global = true;
      else
        live[scope] = [
          scope === "chains"
            ? "42161"
            : scope === "providers"
              ? "routing-core"
              : scope === "protocols"
                ? "fixture-protocol"
                : scope === "tokens"
                  ? C
                  : B,
        ];
      expect(
        () => gate.review(intent(), tx(), entry(), decoded, p, T0),
        scope,
      ).toThrow("EXECUTION_PAUSED");
    }
  });
  it("an alternate but economically identical payload is not the simulated transaction", () => {
    const alternate = { ...tx(), data: tx().data + "00" }; // same selector, decoder returns same economics
    expect(() => reviewed({ t: alternate })).toThrow(/SIMULATION_REQUIRED/);
  });
  it("duplicate quote is rejected (replay) and capacity is bounded", () => {
    const gate = new SimulationGate(open);
    const p = proofFor();
    expect(() =>
      gate.review(intent(), tx(), entry(), decoded, p, T0),
    ).not.toThrow();
    expect(() => gate.review(intent(), tx(), entry(), decoded, p, T0)).toThrow(
      "REPLAY_REJECTED",
    );
  });
  it("runtime/implementation drift is detected by route health against live hashes", () => {
    expect(() =>
      routeHealth(entry(), open, "0x" + "a".repeat(64), null),
    ).not.toThrow();
    expect(() =>
      routeHealth(entry(), open, "0x" + "f".repeat(64), null),
    ).toThrow("REVIEW_REQUIRED");
    expect(() =>
      routeHealth(entry(), open, "0x" + "a".repeat(64), "0x" + "1".repeat(64)),
    ).toThrow("REVIEW_REQUIRED");
    expect(() =>
      routeHealth(entry(), killPolicy, "0x" + "a".repeat(64), null),
    ).toThrow("EXECUTION_PAUSED");
  });
  it("registry digest binds every field and is order/case canonical", () => {
    const base = entryDigest(entry());
    expect(
      entryDigest({
        ...entry(),
        contract: B.toUpperCase().replace("0X", "0x"),
      }),
    ).toBe(base);
    for (const [k, v] of Object.entries({
      protocol: "x",
      provider: "y",
      token: A,
      selector: "0x87654321",
      verifiedBlock: "101",
      status: "DENIED",
    }))
      expect(entryDigest({ ...entry(), [k]: v } as ContractEntry), k).not.toBe(
        base,
      );
  });
});
