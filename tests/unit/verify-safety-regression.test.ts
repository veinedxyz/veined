// V1.11 G7 release gate: end-to-end regression tests for scripts/verify-safety.mjs (a G7-protected static boundary
// check). Every case runs the REAL script against a temporary copy of the scanned tree with exactly one injected
// change, so a broken pattern (e.g. the former literal 0x08 instead of a `\b` word boundary) fails here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FORBIDDEN_WALLET_METHODS } from "../../src/features/wallet/adapter";

const SCRIPT = resolve("scripts/verify-safety.mjs");
const LAYER = "src/features/wallet/privy/layer.tsx";
const ADAPTER = "src/features/wallet/adapter.ts";
// The reviewed presence-only detection in the Privy layer (times Privy's own discovery; never calls the provider).
const PRESENCE_ONLY =
  '"ethereum" in window && !!(window as { ethereum?: unknown }).ethereum';
let root = "";
let runs = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ob-verify-safety-"));
  for (const p of [
    "src",
    "services",
    "packages",
    ".env.example",
    "package.json",
  ])
    cpSync(resolve(p), join(root, p), { recursive: true });
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function run() {
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    env: {
      ...process.env,
      OTHERBRIDGE_EVIDENCE_ROOT: join(root, `.out-${++runs}`),
    },
    encoding: "utf8",
    timeout: 120000,
  });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}
/** Applies ONE change to the temporary tree, runs the script, then restores the tree exactly. */
function withChange(file: string, edit: (text: string | null) => string) {
  const p = join(root, file);
  const before = existsSync(p) ? readFileSync(p, "utf8") : null;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, edit(before));
  try {
    return run();
  } finally {
    if (before === null) rmSync(p);
    else writeFileSync(p, before);
  }
}
const addFile = (file: string, text: string) => withChange(file, () => text);
/** Review 25: several files changed (or added) at once, the script run once, every file restored exactly. */
function withChanges(changes: [string, (text: string | null) => string][]) {
  const saved = changes.map(([file]) => {
    const p = join(root, file);
    return [p, existsSync(p) ? readFileSync(p, "utf8") : null] as const;
  });
  for (const [file, edit] of changes) {
    const p = join(root, file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, edit(existsSync(p) ? readFileSync(p, "utf8") : null));
  }
  try {
    return run();
  } finally {
    for (const [p, before] of saved.reverse()) {
      if (before === null) rmSync(p);
      else writeFileSync(p, before);
    }
  }
}
const replaceOnce =
  (from: string | RegExp, to: string) => (t: string | null) => {
    const text = t ?? "";
    const next = text.replace(from, to);
    if (next === text)
      throw new Error(`MUTATION_ANCHOR_MISSING ${String(from)}`);
    return next;
  };
/** Review 25 R25-1: the durable store with the canary words renamed out and its behaviour kept (SYNTHETIC_TEST_ONLY). */
const wordlessStore = (t: string | null) => {
  let s = (t ?? "").replace(/CanaryDurableStore/g, "JournalLockedStore");
  for (const k of [
    '"veined.canary.store.v2"',
    '"veined.canary.store.live-tokens"',
  ])
    s = s.split(k).join(`"veined.can" + "${k.slice('"veined.can'.length)}`);
  return s.replace(/canary/gi, "trials").replace(/durable/gi, "persist");
};
const expectFail = (r: { ok: boolean; output: string }, message: string) => {
  expect(r.ok, r.output.slice(-600)).toBe(false);
  expect(r.output).toContain(message);
};

describe("verify-safety baseline", () => {
  it("the unmodified tree passes (including the reviewed presence-only detection in the Privy layer)", () => {
    const text = readFileSync(join(root, LAYER), "utf8");
    expect(text).toContain(PRESENCE_ONLY);
    const r = run();
    expect(r.ok, r.output.slice(-600)).toBe(true);
    expect(r.output).toContain("PASS");
  }, 120000);
});

describe("raw injected provider access is refused", () => {
  const cases: [string, string][] = [
    ["window.ethereum", "export const p = () => window.ethereum;\n"],
    // The `.ethereum` word boundary (the former literal-backspace bug never matched these):
    [
      "property .ethereum on any object",
      "export const p = (g: { ethereum?: unknown }) => g.ethereum;\n",
    ],
    [
      "optional .ethereum access",
      "export const p = (g?: { ethereum?: { request?: unknown } }) => g?.ethereum?.request;\n",
    ],
    [
      "globalThis.ethereum",
      "export const p = () => (globalThis as { ethereum?: unknown }).ethereum;\n",
    ],
    ['"ethereum" in window', 'export const p = () => "ethereum" in window;\n'],
    [
      "EIP-6963 discovery",
      'export const p = () => window.addEventListener("eip6963:announceProvider", () => {});\n',
    ],
  ];
  it.each(cases)(
    "%s in a new source file fails",
    (_, code) => {
      expectFail(
        addFile("src/components/injected-probe.ts", code),
        "Raw injected EVM provider access",
      );
    },
    120000,
  );
  it("a new raw provider path inside the Privy layer itself fails", () => {
    expectFail(
      withChange(
        LAYER,
        (t) =>
          `${t}\nexport const leak = () => (window as { ethereum?: { request?: unknown } }).ethereum?.request;\n`,
      ),
      "Raw injected EVM provider access",
    );
  }, 120000);
  it("the presence-only expression is accepted ONLY in the Privy layer, ONLY once", () => {
    expectFail(
      addFile(
        "src/components/presence-copy.ts",
        `export const p = () => ${PRESENCE_ONLY};\n`,
      ),
      "Raw injected EVM provider access",
    );
    expectFail(
      withChange(
        LAYER,
        (t) => `${t}\nexport const twice = () => ${PRESENCE_ONLY};\n`,
      ),
      "Raw injected EVM provider access",
    );
  }, 240000);
  it("ethereum as a word inside other identifiers or strings is not a provider access", () => {
    const r = addFile(
      "src/components/not-a-provider.ts",
      'export const t = { walletChainType: "ethereum-only", ethereumMainnet: 1 };\nexport const n = (c: { ethereumMainnet: number }) => c.ethereumMainnet;\n',
    );
    expect(r.ok, r.output.slice(-600)).toBe(true);
  }, 120000);
});

describe("the presence-only allowlist is exact and file-bound (no wildcard)", () => {
  const script = readFileSync(SCRIPT, "utf8");
  it("the exemption regex is the exact reviewed literal", () => {
    const m = /const PRESENCE_ONLY =\s*\/(.+)\/;/.exec(script);
    expect(m?.[1]).toBe(
      String.raw`"ethereum" in window && !!\(window as \{ ethereum\?: unknown \}\)\.ethereum`,
    );
    // no wildcard constructs, no global flag (one occurrence only)
    expect(m?.[1]).not.toMatch(/\.\*|\.\+|\\w|\\S|\[\^|\|/);
  });
  it("each exemption is bound to exactly one file", () => {
    expect(script).toContain(`const ADAPTER = "${ADAPTER}";`);
    expect(script).toMatch(
      /file === "src\/features\/wallet\/privy\/layer\.tsx"\s*\?\s*text\.replace\(PRESENCE_ONLY, ""\)/,
    );
    expect((script.match(/text\.replace\(/g) ?? []).length).toBe(2);
  });
});

describe("unexpected signer / send paths are refused", () => {
  it.each([...FORBIDDEN_WALLET_METHODS])(
    "wallet method %s outside the adapter's frozen deny list fails",
    (method) => {
      expectFail(
        addFile(
          "src/components/signer-probe.ts",
          `export const call = { method: "${method}", params: [] };\n`,
        ),
        "Forbidden signer surface",
      );
    },
    120000,
  );
  it.each(["privateKeyToAccount", "mnemonicToAccount"])(
    "local key material helper %s fails",
    (helper) => {
      expectFail(
        addFile(
          "src/components/key-probe.ts",
          `import { ${helper} } from "viem/accounts";\nexport const a = ${helper};\n`,
        ),
        "Forbidden signer surface",
      );
    },
    120000,
  );
  it("a second eth_sendTransaction outside the adapter fails (single centralized send)", () => {
    expectFail(
      addFile(
        "src/components/send-probe.ts",
        'export const call = { method: "eth_sendTransaction" };\n',
      ),
      "Wallet writes must be centralized",
    );
  }, 120000);
  it("calling the canonical send outside the submission boundary fails", () => {
    expectFail(
      addFile(
        "src/components/canonical-probe.ts",
        "export const go = (w: { sendCanonicalTransaction: (x: unknown) => unknown }) => w.sendCanonicalTransaction({});\n",
      ),
      "Only the submission boundary may call the canonical send",
    );
  }, 120000);
  it.each([
    "sendTransaction",
    "signMessage",
    "signTypedData",
    "createWalletClient",
    "executeRoute",
  ])(
    "routing write call %s( fails",
    (fn) => {
      expectFail(
        addFile(
          "src/routing/write-probe.ts",
          `declare const x: Record<string, (a?: unknown) => unknown>;\nexport const go = () => x.${fn}({});\nexport const g2 = () => ${fn}(1);\ndeclare function ${fn}(a: unknown): unknown;\n`,
        ),
        "Routing write call found",
      );
    },
    120000,
  );
  it("a Privy signing hook in the wallet layer fails (connect-only imports)", () => {
    expectFail(
      withChange(LAYER, (t) =>
        t!.replace(
          '} from "@privy-io/react-auth";',
          '  useSignMessage,\n} from "@privy-io/react-auth";',
        ),
      ),
      "Privy layer imports must stay connect-only",
    );
  }, 120000);
  it("the Privy SDK imported outside the wallet layer fails", () => {
    expectFail(
      addFile(
        "src/components/privy-probe.ts",
        'export { usePrivy } from "@privy-io/react-auth";\n',
      ),
      "Privy SDK imported outside the wallet layer",
    );
  }, 120000);
  it("a signing surface in the data plane fails", () => {
    expectFail(
      addFile(
        "services/sign-probe.ts",
        'export const m = "eth_sendRawTransaction";\n',
      ),
      "Data plane write/signing surface",
    );
  }, 120000);
});

describe("script integrity (the literal-backspace regression)", () => {
  const script = readFileSync(SCRIPT, "utf8");
  it("contains no control characters", () => {
    expect(
      script.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g),
    ).toBeNull();
  });
  it("the raw-provider pattern uses a real RegExp word boundary after .ethereum", () => {
    expect(script).toContain(String.raw`\.ethereum\b`);
  });
});

// G14 closure: every ADDED canary rule of verify-safety is broken on purpose, once each, and the real script must
// fail with that rule's message. (None of the rules above is changed; these are additional negative tests.)
describe("G14 closure canary rules (mutation tests)", () => {
  const sub = (file: string, from: string | RegExp, to: string) =>
    withChange(file, (t) => {
      const text = t ?? "";
      const next = text.replace(from, to);
      if (next === text)
        throw new Error(`MUTATION_ANCHOR_MISSING ${file} ${String(from)}`);
      return next;
    });
  const subs = (file: string, pairs: [string, string][]) =>
    withChange(file, (t) => {
      let text = t ?? "";
      for (const [from, to] of pairs) {
        if (text.split(from).length !== 2)
          throw new Error(`MUTATION_ANCHOR_COUNT ${file} ${from.slice(0, 60)}`);
        text = text.replace(from, to);
      }
      return text;
    });
  const CASES: [string, () => { ok: boolean; output: string }, string][] = [
    [
      "a second canary selector in the canary entry",
      () =>
        sub(
          "src/security/firewall.ts",
          'selector: "0x1794958f",\n  // keccak256',
          'selector: "0xa1f1ce43",\n  // keccak256',
        ),
      "Exactly one canary entry",
    ],
    [
      "the out-of-scope selector anywhere in code",
      () =>
        addFile(
          "src/execution/canary/start-path.ts",
          'export const START = "0xa1f1ce43";\n',
        ),
      "Out-of-scope selector 0xa1f1ce43",
    ],
    [
      "a general ACTIVE registry entry",
      () =>
        sub(
          "src/security/firewall.ts",
          "contractRegistry: readonly ContractEntry[] = Object.freeze([])",
          "contractRegistry: readonly ContractEntry[] = Object.freeze([canaryContractEntry])",
        ),
      "Write registry must stay empty",
    ],
    [
      "an armed owner record",
      () =>
        sub(
          "src/security/canary-approval.ts",
          "null as Readonly<OwnerCanaryApproval> | null;",
          "({}) as Readonly<OwnerCanaryApproval> | null;",
        ),
      "Canary owner record must stay null",
    ],
    [
      "activation by the wiring constant",
      () =>
        sub(
          "src/execution/server/gate.ts",
          "CANARY_LIVE_WIRING = false as const;",
          "CANARY_LIVE_WIRING = true as const;",
        ),
      "CANARY_LIVE_WIRING must stay false",
    ],
    [
      "activation from the environment in the runtime",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "export function canaryArmed()",
          "const ARM = process.env.VEINED_CANARY;\nvoid ARM;\nexport function canaryArmed()",
        ),
      "Canary runtime: no environment",
    ],
    [
      "a test hook in the runtime",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "export function closeCanaryRuntime()",
          "export function setCanaryRuntimeForTests() {}\nexport function closeCanaryRuntime()",
        ),
      "Canary runtime: no environment",
    ],
    [
      "a key / send primitive next to the canary",
      () =>
        addFile(
          "src/execution/server/canary/signer.ts",
          'import { privateKeyToAccount } from "viem/accounts";\nexport const a = privateKeyToAccount;\n',
        ),
      "Forbidden signer surface",
    ],
    [
      "a fake durable journal",
      () =>
        sub(
          "src/execution/server/canary/engine.ts",
          "export class MemoryUseJournal implements CanaryUseJournal {",
          "export class MemoryUseJournal implements CanaryUseJournal {\n  readonly durable = true;",
        ),
      "claims durability outside the durable store",
    ],
    [
      "a second composition of the engine",
      () =>
        addFile(
          "src/execution/server/canary-shadow.ts",
          'import { CanaryEngine } from "./canary/engine";\nexport const e = () => new CanaryEngine({} as never);\n',
        ),
      "Canary engine constructed outside the runtime",
    ],
    [
      "the runtime imported outside the API route",
      () =>
        addFile(
          "src/components/canary-shadow.ts",
          'export * from "../execution/server/canary/runtime";\n',
        ),
      "Canary runtime imported outside the API route",
    ],
    [
      "an unlisted file in the canary directory",
      () =>
        addFile(
          "src/execution/server/canary/helper.ts",
          "export const x = 1;\n",
        ),
      "Canary file outside the inventory",
    ],
    [
      "a removed inventory entry",
      () =>
        sub(
          "src/execution/server/canary/inventory.ts",
          '  "src/execution/server/canary/rpc-pool.ts",\n',
          "",
        ),
      "Canary inventory misses src/execution/server/canary/rpc-pool.ts",
    ],
    [
      "an unlimited RPC: a write method in the canary read list",
      () =>
        sub(
          "src/swap/server/transport.ts",
          '"eth_simulateV1",\n]);',
          '"eth_simulateV1",\n  "eth_sendRawTransaction",\n]);',
        ),
      "Forbidden signer surface",
    ],
    [
      "a trace method in the canary read list",
      () =>
        sub(
          "src/swap/server/transport.ts",
          '"eth_simulateV1",\n]);',
          '"eth_simulateV1",\n  "debug_traceCall",\n]);',
        ),
      "Canary read methods are exactly the reviewed read-only list",
    ],
    [
      "a pool method list that drifts from the transport's",
      () =>
        sub(
          "src/execution/server/canary/rpc-pool.ts",
          "export const POOL_READ_METHODS: readonly string[] = CANARY_READ_METHODS;",
          'export const POOL_READ_METHODS: readonly string[] = Object.freeze(["eth_call"]);',
        ),
      "Canary pool: the transport's own method list",
    ],
    [
      "a fetch escape in the canary pool",
      () =>
        sub(
          "src/execution/server/canary/rpc-pool.ts",
          "export const UNPINNED",
          'export const leak = () => fetch("https://example.invalid");\nexport const UNPINNED',
        ),
      "Canary pool: the transport's own method list",
    ],
    [
      "the same operator twice on one chain",
      () =>
        sub(
          "src/swap/server/config.ts",
          'operator: "base-coinbase",',
          'operator: "allnodes-publicnode",',
        ),
      "two different operators per chain",
    ],
    [
      "release egress blind to the canary pool",
      () =>
        sub(
          "src/release/config.ts",
          'errors.push("CANARY_RPC_NOT_IN_RELEASE_ALLOWLIST");',
          "void 0;",
        ),
      "Release egress must see the canary RPC pool",
    ],
    [
      "a missing last-instant dispatch check",
      () =>
        sub(
          "src/features/wallet/adapter.ts",
          /: \(canaryDispatchProblem\(\s*OWNER_CANARY_APPROVAL,\s*canonical,\s*grant!\.limits,\s*clock\(cc\?\.notBefore\) \+ grant!\.offsetMs,\s*\) \?\? preparedDigestProblem\(grant!\.limits, canonical\)\);(\s*if \(problem\))/,
          ": null;$1",
        ),
      "re-checked after the last await",
    ],
    [
      "a last-instant dispatch check whose result is ignored",
      () =>
        sub(
          "src/features/wallet/adapter.ts",
          /: \(canaryDispatchProblem\(\s*OWNER_CANARY_APPROVAL,\s*canonical,\s*grant!\.limits,\s*clock\(cc\?\.notBefore\) \+ grant!\.offsetMs,\s*\) \?\? preparedDigestProblem\(grant!\.limits, canonical\)\);(\s*if \(problem\))/,
          ": (void canaryDispatchProblem(OWNER_CANARY_APPROVAL, canonical, grant!.limits, clock(cc?.notBefore) + grant!.offsetMs), null);$1",
        ),
      "re-checked after the last await",
    ],
    [
      "a durability claim spelled !0",
      () =>
        sub(
          "src/execution/server/canary/engine.ts",
          "export class MemoryUseJournal implements CanaryUseJournal {",
          "export class MemoryUseJournal implements CanaryUseJournal {\n  readonly durable = !0;",
        ),
      "claims durability outside the durable store",
    ],
    [
      "the runtime imported through the @/ alias",
      () =>
        addFile(
          "src/components/canary-alias.ts",
          'export { canaryRuntime } from "@/execution/server/canary/runtime";\n',
        ),
      "Canary runtime imported outside the API route",
    ],
    [
      "the runtime imported dynamically",
      () =>
        addFile(
          "src/components/canary-dynamic.ts",
          'export const rt = () => import("../execution/server/canary/runtime");\n',
        ),
      "Canary runtime imported outside the API route",
    ],
    [
      "the runtime re-exported from another canary file",
      () =>
        sub(
          "src/execution/server/canary/inventory.ts",
          "export const CANARY_PROTECTED_INVENTORY",
          'export { canaryRuntime } from "./runtime";\nexport const CANARY_PROTECTED_INVENTORY',
        ),
      "Canary runtime imported outside the API route",
    ],
    [
      "a decision file dropped from the inventory",
      () =>
        sub(
          "src/execution/server/canary/inventory.ts",
          '  "src/execution/lifecycle.ts",\n',
          "",
        ),
      "Canary inventory misses src/execution/lifecycle.ts",
    ],
    [
      "review 3 N12: an owner key digest in the delivered source",
      () =>
        sub(
          "src/security/canary-approval.ts",
          "export const OWNER_CANARY_KEY_SHA256 = null as string | null;",
          'export const OWNER_CANARY_KEY_SHA256 = "' +
            "ab".repeat(32) +
            '" as string | null;',
        ),
      "Canary owner key digest must stay null",
    ],
    [
      "review 2 R6: a relative runtime import from another server file",
      () =>
        sub(
          "src/execution/server/gate.ts",
          /^/,
          'export { canaryRuntime } from "./canary/runtime";\n',
        ),
      "Canary runtime imported outside the API route",
    ],
    [
      "review 2 R6: a durability claim with a quoted key",
      () =>
        sub(
          "src/execution/server/canary/engine.ts",
          "export class MemoryUseJournal implements CanaryUseJournal {",
          'export class MemoryUseJournal implements CanaryUseJournal {\n  readonly "durable" = true;',
        ),
      "claims durability outside the durable store",
    ],
    [
      "review 2 R6: a dispatch check evaluated but not assigned to `problem`",
      () =>
        sub(
          "src/features/wallet/adapter.ts",
          // G14 follow-up F2: the check runs on the authority's server limits (anchor moved with the code).
          /(const veto = cc\?\.current;\s*)const problem =[\s\S]*?\?\? preparedDigestProblem\(grant!\.limits, canonical\)\);/,
          "$1const problem = null as string | null;\n          void (canaryDispatchProblem(OWNER_CANARY_APPROVAL, canonical, grant!.limits, clock(cc?.notBefore) + grant!.offsetMs) ?? preparedDigestProblem(grant!.limits, canonical));",
        ),
      "re-checked after the last await",
    ],
    [
      "review 2 R5: a decision file of the closure dropped from the inventory",
      () =>
        sub(
          "src/execution/server/canary/inventory.ts",
          '  "src/guardian/verdict.ts",\n',
          "",
        ),
      "Canary decision file outside the inventory: src/guardian/verdict.ts",
    ],
    [
      "review 2 R5: a NEW decision file reached from the canary path but not inventoried",
      () => {
        const extra = join(root, "src/execution/canary/extra-rule.ts");
        writeFileSync(extra, "export const EXTRA_RULE = 1;\n");
        try {
          return sub(
            "src/execution/canary/settlement.ts",
            /^/,
            'import "./extra-rule";\n',
          );
        } finally {
          rmSync(extra);
        }
      },
      "Canary decision file outside the inventory: src/execution/canary/extra-rule.ts",
    ],
    [
      "an await between the last check and the wallet request",
      () =>
        sub(
          "src/features/wallet/adapter.ts",
          "      try {\n        const answer = await this.#raw.request({",
          "      await Promise.resolve();\n      try {\n        const answer = await this.#raw.request({",
        ),
      "re-checked after the last await",
    ],
    [
      // G14 follow-up F2: the durable "requested" write is the adapter's own bounded call now; the page's remaining
      // record write (the conditional clean-up) is the one made unbounded here.
      "an unbounded record write in the submission",
      () =>
        sub(
          "src/features/bridge/submission.ts",
          /const cleared = await bounded\(\s*\(\) => context\.persistNotRequested\(ref\),\s*CANARY_CONFIRM_WAIT_MS,\s*\);/,
          "const cleared = { ok: true as const, value: await context.persistNotRequested(ref) };",
        ),
      "every record write bounded",
    ],
    [
      "follow-up F2: the adapter accepts caller limits again",
      () =>
        sub(
          "src/features/wallet/adapter.ts",
          'if (cc?.limitsGiven) return "DISPATCH_LIMITS_FROM_CALLER";',
          "if (cc?.limitsGiven) return null;",
        ),
      "Canary dispatch authority",
    ],
    [
      "follow-up F2: the authority registry is exported",
      () =>
        sub(
          "src/features/wallet/adapter.ts",
          "const grants = new WeakMap<object, DispatchGrant>();",
          "export const grants = new WeakMap<object, DispatchGrant>();",
        ),
      "Canary dispatch authority",
    ],
    [
      "follow-up F2: a second way to mint an authority",
      () =>
        sub(
          "src/features/wallet/adapter.ts",
          /$/,
          "\nexport function mintAuthority(x: object) {\n  grants.set(x, null as never);\n}\n",
        ),
      "Canary dispatch authority",
    ],
    [
      "follow-up F2: an authority minted without the server's durable REQUESTED commit",
      () =>
        sub(
          "src/features/wallet/adapter.ts",
          'ans.state === "REQUESTED" &&',
          "true &&",
        ),
      "Canary dispatch authority",
    ],
    [
      "follow-up F2: the page fetch taken at call time (replaceable) instead of at load",
      () =>
        sub(
          "src/features/wallet/adapter.ts",
          "const pageFetch = PAGE_FETCH;",
          "const pageFetch = globalThis.fetch;",
        ),
      "Canary dispatch authority",
    ],
    [
      "follow-up F2: the authority obtained outside the submission boundary",
      () =>
        addFile(
          "src/components/canary-shortcut.ts",
          'import { obtainCanaryDispatchAuthority } from "../features/wallet/adapter";\nexport const go = (a: never) => obtainCanaryDispatchAuthority(a, a);\n',
        ),
      "Canary dispatch authority obtained outside the submission boundary",
    ],
    [
      "follow-up F1: an undecided search ends the record again",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          '} else if (lapsed && found.status === "NOT_FOUND") {',
          '} else if (lapsed && found.status !== "FOUND") {',
        ),
      "an undecided search never ends a record",
    ],
    [
      "follow-up F1: an undecided search no longer needs attention",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "|REPLACEMENT_SEARCH_|RECORD_STAYS_ACTIVE",
          "|RECORD_STAYS_ACTIVE",
        ),
      "an undecided search never ends a record",
    ],
    [
      "follow-up F3: an allowance read of one operator counts",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "&& v0 === v1",
          "&& (v0 === v1 || v1 === undefined)",
        ),
      "Canary allowance: two-operator read, unknown never zero",
    ],
    [
      "follow-up F4: the completed label for a record that needs attention",
      () =>
        sub(
          "src/components/execution-review.tsx",
          "view.needsAttention !== true &&",
          "",
        ),
      "Canary panel: one completed label",
    ],
    [
      "follow-up F4: a locale whose completed text reads like its attention text",
      () =>
        withChange("src/i18n/locales/tr.json", (t) => {
          const d = JSON.parse(t ?? "{}");
          d.g14.c.completed = d.g14.c.attention;
          return JSON.stringify(d, null, 2) + "\n";
        }),
      "the completed text of tr.json is not a text of its own",
    ],
    [
      "follow-up F4: the store opened from a worker thread",
      () =>
        sub(
          "src/execution/server/canary/durable-store.ts",
          'if (!isMainThread) throw new StoreError("STORE_THREAD_UNSUPPORTED");',
          "",
        ),
      "Canary store: one main thread on one local machine",
    ],
    [
      "follow-up F4: a write reported durable after its lock was lost",
      () =>
        sub(
          "src/execution/server/canary/durable-store.ts",
          /this\.#checkLock\(\);\s*this\.#entries\.push\(\.\.\.batch\);/,
          "this.#entries.push(...batch);",
        ),
      "Canary store: one main thread on one local machine",
    ],
    [
      "review 7 R7-1: a general gate reaches Base (no chain binding)",
      () =>
        sub(
          "src/features/wallet/adapter.ts",
          /if \(!canary && TRUSTED_CHAINS\[chainId\]\?\.switchable !== true\)\s*throw new BridgeError\("WALLET_CHAIN_NOT_TRUSTED"\);/,
          "",
        ),
      "Canary dispatch authority",
    ],
    [
      "review 7 R7-2: the search counts NOT_FOUND short of the nonce block",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          /if \(final < BigInt\(nonceBlock\.number\)\)\s*return \{ status: "UNKNOWN", reason: undecided\(\) \};/,
          "",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 7 R7-3: elapsed time ends an ABSENT transaction with an unused nonce again",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          /notes\.push\(\s*`TX_ABSENT_NONCE_UNUSED_FOR_MS:\$\{now - seen!\}`,\s*"RECORD_STAYS_ACTIVE_TX_MAY_STILL_BE_MINED",\s*\);/,
          'r = this.#batch(() => this.#engine.observe(record, { type: "TX_DROPPED", at: now, role, hash, unseenForMs: now - seen! }));',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 7 R7-3: elapsed time ends an unanswered prompt again",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          /notes\.push\(\s*`UNCERTAIN_NONCE_UNCHANGED_FOR_MS:\$\{now - r\.uncertainSince\}`,\s*"RECORD_STAYS_ACTIVE_PROMPT_MAY_STILL_BE_CONFIRMED",\s*\);/,
          'r = this.#batch(() => this.#engine.observe(record, { type: "UNCERTAIN_TIMEOUT", at: now, accountNonceUnchanged: true }));',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 7 R7-6: a commit that may have been written is not cleaned up",
      () =>
        sub(
          "src/features/bridge/submission.ts",
          "if (obtained.written === false) {",
          'if (obtained.written === false || obtained.written === "UNKNOWN") {',
        ),
      "every record write bounded",
    ],
    [
      "review 7 R7-7: the late check judged on the page clock again",
      () =>
        sub(
          "src/features/bridge/submission.ts",
          "const late = alive(confirmed.offsetMs) ?? stopped();",
          "const late = alive() ?? stopped();",
        ),
      "every record write bounded",
    ],
    [
      "review 8 R8-1: an UNCERTAIN step's own transaction adopted without the verified claim path",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          /a\.hash = claimed;\s*await this\.#verifyClaim\(a, signal\);/,
          "a.hash = claimed;",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 8 R8-1: the own-transaction search accepts a transaction that is not exactly the step",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "BigInt(tx.nonce) >= BigInt(a.accountNonce!) && exact(tx)",
          "BigInt(tx.nonce) >= BigInt(a.accountNonce!)",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 8 R8-2: the late check leaves the click in page time",
      () =>
        sub(
          "src/features/bridge/submission.ts",
          "at: Number(gesture.at) + offsetMs,",
          "at: Number(gesture.at),",
        ),
      "every record write bounded",
    ],
    [
      "review 8 R8-4: the negative end counts blocks that are not final",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "const final = BigInt(head.number) - depth;",
          "const final = BigInt(head.number);",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 8 R8-4: a shallow revert ends the record",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          'rc.confirmations < EXECUTION_POLICY.confirmations["8453"]',
          "rc.confirmations < 0",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 8 R8-4: a log of the attempt's own hash is skipped instead of deciding nothing",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          'mode === "REPLACEMENT" && a.hash && inRange.includes(lower(a.hash))',
          "false",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 9 R9-4: the first sighting of the consumed nonce replaced (the nonce-block bound removed)",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          /const seenConsumedAt =\s*this\.#consumedAt\.get\(mine\.attempt\) \?\? nonce\.head;/,
          'const seenConsumedAt = { number: "0", hash: "" };',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 9 R9-3: the not-final tail is not read before a negative end",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "const firstTail = await tailDecision(final + 1n, BigInt(head.number));",
          "const firstTail = null;",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 9 R9-2: a second exact own match no longer counts",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "if (known && known !== lower(tx.hash))",
          "if (false)",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 9 R9-2: the adoption no longer re-checks the record after the search's wait",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          'this.#engine.record(record)?.state !== "UNCERTAIN"',
          "false",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 9 R9-1: a claimed-but-unseen hash is left out of the own-transaction search",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          /x\.state === "HASH_CLAIMED" \|\|\s*/,
          "",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 10 R10-3 (M1): an incomplete tail read decides as if complete",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          'if (!tail.complete) return { status: "SCANNING", cursor: lo.toString() };',
          "",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 10 R10-3 (M2): a read stopped by the budget is marked complete",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          'return { kind: "READ", hits, complete: false };',
          'return { kind: "READ", hits, complete: true };',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 10 R10-3 (M3): the OWN match is not journaled (forgotten across a restart)",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          'this.#store.append("OWN_CANDIDATE", {',
          'this.#store.append("OWN_CANDIDATE_NOT_RESTORED", {',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 10 R10-3 (M4): another intent in the not-final tail decides (REPLACED on shallow blocks)",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          ': { status: "UNKNOWN", reason: "OTHER_INTENT_NOT_FINAL" };',
          ': { status: "FOUND", hash: tail.hits[0].hash, sameIntent: false };',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 10 R10-2: the decision no longer re-checks that the nonce is still consumed",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "BigInt(again.nonce) <= BigInt(a.txNonce!)",
          "false",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 10 R10-1: an UNCERTAIN record's allowance is no longer read",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "(await this.#readAllowance(record, signal)).status",
          '"NOT_READ"',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 12 R12-1 (M6): the not-final tail is not read again after the nonce re-read",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "const secondTail = await tailDecision(",
          "const secondTail = null && await tailDecision(",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 12 R12-1 (M7): a head that went back during the deciding call is accepted",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "if (BigInt(again.head.number) < BigInt(head.number))",
          "if (false)",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 12 R12-2: an adoption no longer ends the tracking call",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          /(notes\.push\(`OWN_TRANSACTION_FOUND_ON_CHAIN:\$\{claimed\}`\);)[\s\S]{0,400}?return this\.view\(record, notes\);/,
          "$1",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 13 R13-1: the nonce at the final block is no longer required before NOT_FOUND",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "BigInt(atFinal.nonce) <= BigInt(a.txNonce!)",
          "false",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 13 R13-2: tracking calls of one record no longer serialised",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "const previous = this.#tracking.get(i.record) ?? Promise.resolve();",
          "const previous = Promise.resolve();",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 13 R13-3: the checked set read once per call (re-read by the second tail)",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "const seen = this.#checked.get(a.attempt) ?? checked;",
          "const seen = checked;",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 14 R14-1: a destination fill counted at the head (no confirmation depth)",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          /const finalArb =\s*BigInt\(head\.number\) - BigInt\(EXECUTION_POLICY\.confirmations\["42161"\]\);/,
          "const finalArb = BigInt(head.number);",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 14 R14-3 (N3): an early NOT_FOUND before the premise read",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    const atFinal = await readNonceAtBlockPair(",
          '    if (Date.now() < 0) return { status: "NOT_FOUND", from, to: "0", head: "0", headHash: "", depth: "0", tailTo: "0", nonceBlock: "0", nonceBlockHash: "" };\n    const atFinal = await readNonceAtBlockPair(',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 14 R14-3 (P1): the pool helper reads the head instead of the asked block",
      () =>
        sub(
          "src/execution/server/canary/rpc-pool.ts",
          '"eth_getBlockByNumber", [tag, false]',
          '"eth_getBlockByNumber", ["latest", false]',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 14 R14-3 (N4): the tracking queue entry is not stored",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "this.#tracking.set(i.record, run);",
          "void run;",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 15 R15-2 (S1): the fill read reaches the head (the pinned definitions kept)",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          /(word\(depositId\)\],\s*fromBlock: start,\s*)toBlock: to\.toString\(\),/,
          "$1toBlock: head.number,",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 15 R15-2 (S2): the refund read reaches the head",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "toBlock: until.toString(),",
          "toBlock: baseHead!.number,",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 15 R15-2 (S3): the destination cursor jumps to the head",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "this.#cursor.set(r.id, (to + 1n).toString());",
          "this.#cursor.set(r.id, (BigInt(head.number) + 1n).toString());",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 15 R15-2 (S4): the refund cursor jumps to the head",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "const next = (until + 1n).toString();",
          "const next = (BigInt(baseHead!.number) + 1n).toString();",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 15 R15-2 (N3b): an early NOT_FOUND written without the trailing comma",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    const atFinal = await readNonceAtBlockPair(",
          '    if (Date.now() < 0) return { from, to: "0", head: "0", headHash: "", depth: "0", tailTo: "0", nonceBlock: "0", nonceBlockHash: "", status: "NOT_FOUND" };\n    const atFinal = await readNonceAtBlockPair(',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 15 R15-2 (P3): the pool helper's block-number check neutralised",
      () =>
        sub(
          "src/execution/server/canary/rpc-pool.ts",
          "const b = agreedBlock(blocks);\n  if (!b || b.number",
          "const b = agreedBlock(blocks);\n  if (b) b.number = BigInt(number).toString();\n  if (!b || b.number",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 15 R15-1: the reconciliation that ends a record reads the head again",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "baseAfter: baseAt.balances,",
          "baseAfter: base.balances,",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 15 R15-1: the reconciliation no longer waits for the deposit's and the fill's final blocks",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "if (baseFinal < BigInt(receipt.blockNumber) || arbFinal < from) {",
          "if (arbFinal < from) {",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 16 R16-1: the allowance is read only once a verdict is drawn (not while it waits)",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "const out = await this.#reconcileAtFinal(r, notes, signal, base, arb);",
          'const out = await this.#reconcileAtFinal(r, notes, signal, base, arb);\n    if (out.state === "SETTLED") return out;',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 16 (Q1): the agreed heads raised by the depth before the final-block arithmetic",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    // Review 15 R15-1: the reconciliation verdict ENDS",
          "    base.head.number = (BigInt(base.head.number) + 10n).toString();\n    // Review 15 R15-1: the reconciliation verdict ENDS",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 16 (Q6): the destination head raised by the depth before the fill's final block",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    if (!head) return r;\n    // Review 14 R14-1",
          "    if (!head) return r;\n    head.number = (BigInt(head.number) + 10n).toString();\n    // Review 14 R14-1",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 17 R17-1 (Q1b): the heads raised between the verdict helper's first lines and its head check",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    const reads = this.#reads.get(r.id)!;\n    if (!base.head || !arb.head) {",
          "    const reads = this.#reads.get(r.id)!;\n    if (base.head) base.head.number = String(BigInt(base.head.number) + 10n);\n    if (!base.head || !arb.head) {",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 17 R17-1 (Q1c): the heads raised between the head reads and the guard before the verdict helper",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    if (!base || !arb) return r;\n    const out = await this.#reconcileAtFinal(",
          "    if (base?.head) base.head.number = String(BigInt(base.head.number) + 10n);\n    if (!base || !arb) return r;\n    const out = await this.#reconcileAtFinal(",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 17 R17-1 (Q1d): the heads raised inside the reconciliation's head read",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          '      readBalancesAtHead("42161", owner.account, signal).catch(() => null),\n    ]);\n    if (!base || !arb) return r;',
          '      readBalancesAtHead("42161", owner.account, signal).catch(() => null),\n    ]).then((xs) => xs.map((x) => (x?.head && (x.head.number = String(BigInt(x.head.number) + 10n)), x)));\n    if (!base || !arb) return r;',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 17 R17-1 (Q6b): the destination head raised inside the settlement's head read",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "          () => null,\n        )\n      )?.head ?? null;\n    if (!head) return r;",
          "          () => null,\n        ).then((x) => (x?.head && (x.head.number = String(BigInt(x.head.number) + 10n)), x))\n      )?.head ?? null;\n    if (!head) return r;",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 17 (A2): the allowance notes pushed only once a verdict is drawn",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          '    if (allowance.status === "NONZERO") notes.push("ALLOWANCE_NOT_ZERO_AFTER");',
          '    if (out.state !== "SETTLED" && allowance.status === "NONZERO")\n      notes.push("ALLOWANCE_NOT_ZERO_AFTER");',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 17 (A3): the call returns after the allowance read while the verdict waits",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    const allowance = await this.#readAllowance(r.id, signal, base);\n",
          '    const allowance = await this.#readAllowance(r.id, signal, base);\n    if (out.state === "SETTLED") return out;\n',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 18 R18-1 (G1): a defaulted extra parameter of the verdict helper raises the heads",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    arb: Awaited<ReturnType<typeof readBalancesAtHead>>,\n  ): Promise<ExecutionRecord> {",
          "    arb: Awaited<ReturnType<typeof readBalancesAtHead>>,\n    _raised = (base.head && (base.head.number = String(BigInt(base.head.number) + 10n)), arb.head && (arb.head.number = String(BigInt(arb.head.number) + 10n))),\n  ): Promise<ExecutionRecord> {",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 18 R18-1 (G2): the heads raised, then the shared head check repeated",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    // Review 15 R15-1: the reconciliation verdict ENDS",
          '    base.head.number = String(BigInt(base.head.number) + 10n);\n    if (!base.head || !arb.head) {\n      notes.push("RECONCILIATION_HEAD_UNREAD");\n      return r;\n    }\n    // Review 15 R15-1: the reconciliation verdict ENDS',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 18 R18-1 (G3): the destination head raised, then the shared head-read tail repeated",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    if (!head) return r;\n    // Review 14 R14-1",
          "    if (!head) return r;\n    head.number = String(BigInt(head.number) + 10n);\n    const again = (await Promise.resolve({ head }))?.head ?? null;\n    if (!head) return r;\n    // Review 14 R14-1",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 18 R18-1 (G6): a lone CR ends a comment and the rest of the line runs",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    // Review 15 R15-1: the reconciliation verdict ENDS",
          "    // heads\r    base.head.number = String(BigInt(base.head.number) + 10n);\n    // Review 15 R15-1: the reconciliation verdict ENDS",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 18 R18-1 (G6u): a U+2028 ends a comment and the rest of the line runs",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    // Review 15 R15-1: the reconciliation verdict ENDS",
          "    // heads     base.head.number = String(BigInt(base.head.number) + 10n);\n    // Review 15 R15-1: the reconciliation verdict ENDS",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 18 R18-1 (A4): a lone CR hides a return between the allowance read and its notes",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    const allowance = await this.#readAllowance(r.id, signal, base);\n",
          '    const allowance = await this.#readAllowance(r.id, signal, base);\n    // x\r    if (out.state === "SETTLED") return out;\n',
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 19 R19-3 (N3x): a lone CR inside the premise-read comment allowance hides an early NOT_FOUND",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "    if (secondTail) return secondTail;\n",
          "    if (secondTail) return secondTail;\n    // probe\r    if (Date.now() > 0) return { status: 'NOT_FOUND' } as never;\n",
        ),
      "an undecided search never ends a record",
    ],
    [
      "review 19 R19-1 / review 20 R20-3 (J1): a dead copy of the allowance sequence lets the live call return early",
      () =>
        subs("src/execution/server/canary/runtime.ts", [
          [
            "    const out = await this.#reconcileAtFinal(r, notes, signal, base, arb);\n    // G14 follow-up F3: known zero",
            '    const out = await this.#reconcileAtFinal(r, notes, signal, base, arb);\n    if (out.state === "SETTLED") return out;\n    // G14 follow-up F3: known zero',
          ],
          [
            "  /** The reconciliation verdict at the FINAL block of each chain",
            '  async #reconcileCopy(\n    r: ExecutionRecord,\n    notes: string[],\n    signal: AbortSignal,\n    base: Awaited<ReturnType<typeof readBalancesAtHead>> | null,\n    arb: Awaited<ReturnType<typeof readBalancesAtHead>> | null,\n  ): Promise<ExecutionRecord> {\n    if (!base || !arb) return r;\n    const out = await this.#reconcileAtFinal(r, notes, signal, base, arb);\n    const allowance = await this.#readAllowance(r.id, signal, base);\n    if (allowance.status === "NONZERO") notes.push("ALLOWANCE_NOT_ZERO_AFTER");\n    else if (allowance.status === "UNKNOWN")\n      notes.push("ALLOWANCE_UNKNOWN_AFTER");\n    return out;\n  }\n  /** The reconciliation verdict at the FINAL block of each chain',
          ],
        ]),
      "an undecided search never ends a record",
    ],
    [
      "review 19 R19-1 / review 20 R20-3 (J2): a dead copy of the finalArb definition, the live one at the head",
      () =>
        subs("src/execution/server/canary/runtime.ts", [
          [
            '    const finalArb =\n      BigInt(head.number) - BigInt(EXECUTION_POLICY.confirmations["42161"]);\n',
            "    const finalArb =\n      BigInt(head.number);\n",
          ],
          [
            "  async #settle(r: ExecutionRecord, notes: string[], signal: AbortSignal) {\n",
            '  #finalArbCopy(head: { number: string }): bigint {\n    const finalArb =\n      BigInt(head.number) - BigInt(EXECUTION_POLICY.confirmations["42161"]);\n    return finalArb;\n  }\n  async #settle(r: ExecutionRecord, notes: string[], signal: AbortSignal) {\n',
          ],
        ]),
      "an undecided search never ends a record",
    ],
    [
      "review 19 R19-1 / review 20 R20-3 (J3): a dead copy of the final-block arithmetic, the live one at the heads",
      () =>
        subs("src/execution/server/canary/runtime.ts", [
          [
            '    const baseFinal =\n      BigInt(base.head.number) - BigInt(EXECUTION_POLICY.confirmations["8453"]);\n    const arbFinal =\n      BigInt(arb.head.number) - BigInt(EXECUTION_POLICY.confirmations["42161"]);\n',
            "    const baseFinal =\n      BigInt(base.head.number);\n    const arbFinal =\n      BigInt(arb.head.number);\n",
          ],
          [
            "  /** The reconciliation verdict at the FINAL block of each chain",
            '  #finalsCopy(\n    r: ExecutionRecord,\n    notes: string[],\n    reads: { arbStartBlock: string },\n    receipt: { blockNumber: string },\n    base: { head: { number: string } },\n    arb: { head: { number: string } },\n  ): ExecutionRecord | bigint {\n    const baseFinal =\n      BigInt(base.head.number) - BigInt(EXECUTION_POLICY.confirmations["8453"]);\n    const arbFinal =\n      BigInt(arb.head.number) - BigInt(EXECUTION_POLICY.confirmations["42161"]);\n    const from = BigInt(this.#cursor.get(r.id) ?? reads.arbStartBlock);\n    if (baseFinal < BigInt(receipt.blockNumber) || arbFinal < from) {\n      notes.push("RECONCILIATION_NOT_FINAL_YET");\n      return r;\n    }\n    const to = arbFinal < from + 4_999n ? arbFinal : from + 4_999n;\n    return to;\n  }\n  /** The reconciliation verdict at the FINAL block of each chain',
          ],
        ]),
      "an undecided search never ends a record",
    ],
    [
      "review 19 R19-4 (K1): a runtime call after a block comment on the same line, before the closed check",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  const armed = canaryArmed();\n  if (!armed.armed) {",
          "  /* probe */ const rt0 = canaryRuntime(); void rt0;\n  const armed = canaryArmed();\n  if (!armed.armed) {",
        ),
      "Canary API: WRITE_DISABLED before the runtime",
    ],
    [
      "review 19 R19-4 (K2): a runtime call after a U+2028 inside a line comment, before the closed check",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  const armed = canaryArmed();\n  if (!armed.armed) {",
          "  // probe\u2028const rt0 = canaryRuntime(); void rt0;\n  const armed = canaryArmed();\n  if (!armed.armed) {",
        ),
      "Canary API: WRITE_DISABLED before the runtime",
    ],
    [
      "review 19 R19-4 (K3): a second confirmation mint after a block comment on the same line",
      () =>
        sub(
          ADAPTER,
          /\n$/,
          "\n/* probe */ export const forgeConfirmation = (o: object, c: never) => confirmations.set(o, c);\n",
        ),
      "Canary dispatch authority",
    ],
    [
      "review 20 R20-1: a U+2028 inside a string ahead of `//` (the rc20 filter split there and dropped the rest)",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  const armed = canaryArmed();\n  if (!armed.armed) {",
          '  const probe = "\u2028// "; const rt0 = canaryRuntime(); void rt0;\n  const armed = canaryArmed();\n  if (!armed.armed) {',
        ),
      "Canary API: WRITE_DISABLED before the runtime",
    ],
    [
      "review 20 R20-2 (a): a block comment closed on a following `//` line, with code after it",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  const armed = canaryArmed();\n  if (!armed.armed) {",
          "  /*\n  // */ const rt0 = canaryRuntime(); void rt0;\n  const armed = canaryArmed();\n  if (!armed.armed) {",
        ),
      "Canary API: WRITE_DISABLED before the runtime",
    ],
    [
      "review 20 R20-2 (b): a template-literal line starting with `//` that interpolates a runtime call",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  const armed = canaryArmed();\n  if (!armed.armed) {",
          "  const probe = `\n  // ${String(canaryRuntime())}`;\n  void probe;\n  const armed = canaryArmed();\n  if (!armed.armed) {",
        ),
      "Canary API: WRITE_DISABLED before the runtime",
    ],
    [
      "review 21 R21-1 (T1): a runtime call interpolated in a template line that starts with `/*`",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  const armed = canaryArmed();\n  if (!armed.armed) {",
          "  const t0 = `\n/* ${String(canaryRuntime())}`;\n  void t0;\n  const armed = canaryArmed();\n  if (!armed.armed) {",
        ),
      "Canary API: WRITE_DISABLED before the runtime",
    ],
    [
      "review 21 R21-1 (T2): a runtime call after template text that starts with `//`",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  const armed = canaryArmed();\n  if (!armed.armed) {",
          "  const rt0 = [`\n// `, canaryRuntime()][1];\n  void rt0;\n  const armed = canaryArmed();\n  if (!armed.armed) {",
        ),
      "Canary API: WRITE_DISABLED before the runtime",
    ],
    [
      "review 21 R21-1 (O1): a comment opened after code and closed on a following `//` line, then a runtime call",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  const armed = canaryArmed();\n  if (!armed.armed) {",
          "  const probe = 1; /*\n  // */ const rt0 = canaryRuntime(); void rt0, probe;\n  const armed = canaryArmed();\n  if (!armed.armed) {",
        ),
      "Canary API: WRITE_DISABLED before the runtime",
    ],
    [
      "review 21 R21-1 (M1): a runtime import hidden behind a block comment closed on a `//` line",
      () =>
        sub(
          "src/execution/model.ts",
          /\n$/,
          '\nexport const probe = 1; /*\n// */ import "./server/canary/runtime";\n',
        ),
      "Canary runtime imported outside the API route",
    ],
    [
      "review 21 R21-1 (T1m): a second confirmation mint interpolated in a template line that starts with `/*`",
      () =>
        sub(
          ADAPTER,
          /\n$/,
          "\nexport const probe = `\n/* ${String(confirmations.set({} as never, {} as never))}`;\n",
        ),
      "Canary dispatch authority",
    ],
    [
      "review 21 R21-3 (J3x): a dead copy of the final-block arithmetic, only the live arbFinal at the head",
      () =>
        subs("src/execution/server/canary/runtime.ts", [
          [
            '    const arbFinal =\n      BigInt(arb.head.number) - BigInt(EXECUTION_POLICY.confirmations["42161"]);\n',
            "    const arbFinal =\n      BigInt(arb.head.number);\n",
          ],
          [
            "  /** The reconciliation verdict at the FINAL block of each chain",
            '  #finalsCopy(\n    r: ExecutionRecord,\n    notes: string[],\n    reads: { arbStartBlock: string },\n    receipt: { blockNumber: string },\n    base: { head: { number: string } },\n    arb: { head: { number: string } },\n  ): ExecutionRecord | bigint {\n    const baseFinal =\n      BigInt(base.head.number) - BigInt(EXECUTION_POLICY.confirmations["8453"]);\n    const arbFinal =\n      BigInt(arb.head.number) - BigInt(EXECUTION_POLICY.confirmations["42161"]);\n    const from = BigInt(this.#cursor.get(r.id) ?? reads.arbStartBlock);\n    if (baseFinal < BigInt(receipt.blockNumber) || arbFinal < from) {\n      notes.push("RECONCILIATION_NOT_FINAL_YET");\n      return r;\n    }\n    const to = arbFinal < from + 4_999n ? arbFinal : from + 4_999n;\n    return to;\n  }\n  /** The reconciliation verdict at the FINAL block of each chain',
          ],
        ]),
      "an undecided search never ends a record",
    ],
    [
      "review 22 R22-1 (W1): an await before the wallet request after a block comment on its line",
      () =>
        sub(
          ADAPTER,
          "      try {\n        const answer = await this.#raw.request({",
          "      /* let the page paint */ await Promise.resolve();\n      try {\n        const answer = await this.#raw.request({",
        ),
      "Canary: the dispatch limits are re-checked after the last await, with no await before the wallet request",
    ],
    [
      "review 22 R22-1 (W1b): a 30 s wait before the wallet request after a JSDoc on its line",
      () =>
        sub(
          ADAPTER,
          "      try {\n        const answer = await this.#raw.request({",
          "      /** @see PP1 */ await new Promise((r) => setTimeout(r, 30_000));\n      try {\n        const answer = await this.#raw.request({",
        ),
      "Canary: the dispatch limits are re-checked after the last await, with no await before the wallet request",
    ],
    [
      "review 22 R22-1 (W2): an await interpolated in a template line that starts with `//`",
      () =>
        sub(
          ADAPTER,
          "      try {\n        const answer = await this.#raw.request({",
          '      const paint = `\n// ${await Promise.resolve("")}`;\n      void paint;\n      try {\n        const answer = await this.#raw.request({',
        ),
      "Canary: the dispatch limits are re-checked after the last await, with no await before the wallet request",
    ],
    [
      "review 22 R22-1 (W3): an await after a U+2028 inside a line comment",
      () =>
        sub(
          ADAPTER,
          "      try {\n        const answer = await this.#raw.request({",
          "      // paint\u2028await Promise.resolve();\n      try {\n        const answer = await this.#raw.request({",
        ),
      "Canary: the dispatch limits are re-checked after the last await, with no await before the wallet request",
    ],
    [
      "review 22 R22-1 (W4): an await after a comment opened after code and closed on a `//` line",
      () =>
        sub(
          ADAPTER,
          "      try {\n        const answer = await this.#raw.request({",
          "      const paint = /*\n// */ await Promise.resolve();\n      void paint;\n      try {\n        const answer = await this.#raw.request({",
        ),
      "Canary: the dispatch limits are re-checked after the last await, with no await before the wallet request",
    ],
    [
      "review 22 R22-1 (W7): the last check's throw made dead behind a block comment on its line",
      () =>
        sub(
          ADAPTER,
          '          if (problem)\n            throw Object.assign(new BridgeError("CANARY_REQUEST_REFUSED"), {\n              reason: problem,\n            });',
          '          if (problem)\n            /* stale-tolerant */ if (Date.now() < 0)\n              throw Object.assign(new BridgeError("CANARY_REQUEST_REFUSED"), {\n                reason: problem,\n              });',
        ),
      "Canary: the dispatch limits are re-checked after the last await, with no await before the wallet request",
    ],
    [
      "review 22 R22-2 (A1): the closed check weakened while a line comment quotes it",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  if (!armed.armed) {\n    if (!CANARY_WRITES.has(r.action))",
          "  // Closed: `if (!armed.armed) {` answers 403 WRITE_DISABLED before the runtime.\n  if (!armed.armed && r.action.length > 64) {\n    if (!CANARY_WRITES.has(r.action))",
        ),
      "Canary API: WRITE_DISABLED before the runtime while not armed",
    ],
    [
      "review 22 R22-2 (A2): the closed check weakened while a block comment quotes it",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  if (!armed.armed) {\n    if (!CANARY_WRITES.has(r.action))",
          "  /* closed check: if (!armed.armed) { refuse } */\n  if (!armed.armed && r.action.length > 64) {\n    if (!CANARY_WRITES.has(r.action))",
        ),
      "Canary API: WRITE_DISABLED before the runtime while not armed",
    ],
    [
      "review 22 R22-2 (A3): the closed check weakened while a block comment's middle line holds it",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  if (!armed.armed) {\n    if (!CANARY_WRITES.has(r.action))",
          "  /*\n  if (!armed.armed) {\n  */\n  if (!armed.armed && r.action.length > 64) {\n    if (!CANARY_WRITES.has(r.action))",
        ),
      "Canary API: WRITE_DISABLED before the runtime while not armed",
    ],
    [
      "review 22 R22-2 (C1): the one server call respelled while a comment quotes it",
      () =>
        sub(
          ADAPTER,
          "        const r = await pageFetch(CANARY_API_PATH, {",
          "        // The only server call: pageFetch(CANARY_API_PATH, ...).\n        const r = await pageFetch(`${CANARY_API_PATH}`, {",
        ),
      "Canary dispatch authority",
    ],
    [
      "review 22 R22-3 (S1): a durable claim after a block comment on its line",
      () =>
        sub(
          "src/execution/model.ts",
          /\n$/,
          "\n/* journal */ export const probeJournal = { durable: true };\n",
        ),
      "A canary journal claims durability outside the durable store",
    ],
    [
      "review 22 R22-3 (S2): the out-of-scope selector after a block comment on its line",
      () =>
        sub(
          "src/execution/model.ts",
          /\n$/,
          '\n/* legacy */ export const PROBE_SEL = "0xa1f1ce43";\n',
        ),
      "Out-of-scope selector 0xa1f1ce43",
    ],
    [
      "review 22 R22-3 (S3): a late globalThis.fetch after a block comment on its line",
      () =>
        sub(
          ADAPTER,
          "    ? globalThis.fetch.bind(globalThis)\n    : null;\n",
          "    ? globalThis.fetch.bind(globalThis)\n    : null;\n/* late */ export const lateFetch = () => globalThis.fetch;\n",
        ),
      "Canary dispatch authority",
    ],
    [
      "review 22 R22-4 (I1): an early runtime call with a comment inside its parentheses",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  const armed = canaryArmed();\n  if (!armed.armed) {",
          "  const rt0 = canaryRuntime(/* early */);\n  void rt0;\n  const armed = canaryArmed();\n  if (!armed.armed) {",
        ),
      "Canary API: WRITE_DISABLED before the runtime while not armed",
    ],
    [
      "review 22 R22-4 (I2): a runtime import with a webpack magic comment",
      () =>
        sub(
          "src/execution/model.ts",
          /\n$/,
          '\nexport const loadRuntime = () =>\n  import(/* webpackChunkName: "canary" */ "./server/canary/runtime");\n',
        ),
      "Canary runtime imported outside the API route",
    ],
    [
      "review 22 R22-6 (D1): the digest re-check before the confirmation mint deleted",
      () =>
        sub(
          ADAPTER,
          '  if (preparationDigest(prep) !== prep.digest)\n    return no("PREPARATION_DIGEST_MISMATCH");\n',
          "",
        ),
      "Canary dispatch authority",
    ],
    [
      "review 22 R22-6 (D2): the confirmation no longer spent before the commit",
      () =>
        sub(
          ADAPTER,
          '  if (confirmation && typeof confirmation === "object")\n    confirmations.delete(confirmation);\n  if (!c) return no("CONFIRMATION_REQUIRED");',
          '  if (!c) return no("CONFIRMATION_REQUIRED");',
        ),
      "Canary dispatch authority",
    ],
    [
      "review 23 R23-2 (L1): an await after the identity read while a comment holds the anchor text",
      () =>
        sub(
          ADAPTER,
          "        // THE LAST CHECK (G14 closure, PP1-AUDIT-01). The identity read above was the last await; it can take up to\n",
          "        await new Promise((r) => setTimeout(r, 30_000));\n        // The session was re-read by await this.identity( above.\n        // THE LAST CHECK (G14 closure, PP1-AUDIT-01). The identity read above was the last await; it can take up to\n",
        ),
      "Canary: the dispatch limits are re-checked after the last await, with no await before the wallet request",
    ],
    [
      "review 23 R23-2 (L2d): the check moved before an await, a dead identity read and a dead copy of the check after it",
      () =>
        sub(
          ADAPTER,
          /(        \/\/ THE LAST CHECK \(G14 closure, PP1-AUDIT-01\)\.[\s\S]*?a separate, stated risk\.\n)([\s\S]*?)(          if \(problem\)\n            throw Object\.assign\(new BridgeError\("CANARY_REQUEST_REFUSED"\), \{\n              reason: problem,\n            \}\);\n        \}\n)(      \} catch \(e\) \{\n        throw refused\(e\);\n      \}\n      try \{\n        const answer = await this\.#raw\.request\(\{)/,
          '$2$3        await Promise.resolve();\n        if (Date.now() < 0) await this.identity(context.signal);\n$1        if (canary && Date.now() < 0) {\n          const veto = cc?.current;\n          const problem =\n            veto !== undefined &&\n            (typeof veto !== "function" || veto() !== true)\n              ? "REVIEW_NO_LONGER_CURRENT"\n              : (canaryDispatchProblem(\n                  OWNER_CANARY_APPROVAL,\n                  canonical,\n                  grant!.limits,\n                  clock(cc?.notBefore) + grant!.offsetMs,\n                ) ?? preparedDigestProblem(grant!.limits, canonical));\n          if (problem)\n            throw Object.assign(new BridgeError("CANARY_REQUEST_REFUSED"), {\n              reason: problem,\n            });\n        }\n$4',
        ),
      "Canary: the dispatch limits are re-checked after the last await, with no await before the wallet request",
    ],
    [
      "review 23 R23-4 (A4): a comment holds the closed-check text, a guard spelled with a comment elsewhere",
      () =>
        subs("src/app/api/execution/route.ts", [
          [
            "  const armed = canaryArmed();\n  if (!armed.armed) {\n    if (!CANARY_WRITES.has(r.action))",
            "  const armed = canaryArmed();\n  // closed: if (!armed.armed) {\n  if (!armed.armed && r.action.length > 64) {\n    if (!CANARY_WRITES.has(r.action))",
          ],
          [
            "function canaryStatus() {\n  const armed = canaryArmed();\n  return {",
            "function canaryStatus() {\n  const armed = canaryArmed();\n  if (!armed.armed)/* closed */{\n    void armed.reasons;\n  }\n  return {",
          ],
        ]),
      "Canary API: WRITE_DISABLED before the runtime while not armed",
    ],
    [
      "review 23 R23-1 (CR1): a runtime call split by a line comment ended with a lone CR",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  const armed = canaryArmed();\n  if (!armed.armed) {",
          "  const rt0 = canaryRuntime // early\r();\n  void rt0;\n  const armed = canaryArmed();\n  if (!armed.armed) {",
        ),
      "Canary API: WRITE_DISABLED before the runtime while not armed",
    ],
    [
      "review 23 R23-1 (CR2): a second confirmation mint split by a line comment ended with a lone CR",
      () =>
        sub(
          ADAPTER,
          "const confirmations = new WeakMap<object, Confirmed>();\n",
          "const confirmations = new WeakMap<object, Confirmed>();\nexport function remint(k: object, v: Confirmed): void {\n  confirmations // remint\r.set(k, v);\n}\n",
        ),
      "Canary dispatch authority",
    ],
    [
      "review 23 R23-1 (CR4): a runtime import split by a line comment ended with a lone CR",
      () =>
        sub(
          "src/execution/model.ts",
          /\n$/,
          '\nexport const loadRuntime = () =>\n  import // chunk\r("./server/canary/runtime");\n',
        ),
      "Canary runtime imported outside the API route",
    ],
    [
      "review 23 R23-1 (I3): a line comment inside a dynamic import's parentheses (Prettier layout)",
      () =>
        sub(
          "src/execution/model.ts",
          /\n$/,
          '\nexport const loadRuntime = () =>\n  import(\n    // canary chunk\n    "./server/canary/runtime"\n  );\n',
        ),
      "Canary runtime imported outside the API route",
    ],
    [
      "review 23 R23-3 (I6): a runtime fetch with a block comment before its parenthesis",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          /\n$/,
          "\nexport const probeEgress = (u: string) => fetch /* x */ (u);\n",
        ),
      "Canary runtime: no environment, fetch",
    ],
    [
      "review 23 R23-3 (I5): a durable claim behind a `//` string and a comment gap",
      () =>
        sub(
          "src/execution/model.ts",
          /\n$/,
          '\nexport const pj = { u: "//", durable /* j */: true };\n',
        ),
      "A canary journal claims durability outside the durable store",
    ],
    [
      "review 23 R23-8 (X1): the adapter exports its registry through an export list",
      () => sub(ADAPTER, /\n$/, "\nexport { grants, takeGrant };\n"),
      "Canary dispatch authority",
    ],
    [
      "review 23 R23-5 (P2): a comment holds the page-fetch line while the live one is the global fetch",
      () =>
        sub(
          ADAPTER,
          "  const pageFetch = PAGE_FETCH;\n",
          '  // const pageFetch = PAGE_FETCH;\n  const pageFetch = globalThis["fetch"].bind(globalThis);\n',
        ),
      "Canary dispatch authority",
    ],
    [
      "review 23 R23-8 (X2): another file sets a grant in the adapter's registry",
      () =>
        withChange(
          "src/execution/model.ts",
          (t) =>
            'import { grants } from "@/features/wallet/adapter";\n' +
            (t ?? "") +
            "\nexport const forge = (a: object, g: never) => grants.set(a, g);\n",
        ),
      "Canary dispatch authority: a registry of the adapter touched",
    ],
    [
      "review 23 R23-5 (P1): a comment holds the disarmed wiring line while the live one is true",
      () =>
        sub(
          "src/execution/server/gate.ts",
          "export const CANARY_LIVE_WIRING = false as const;",
          "// export const CANARY_LIVE_WIRING = false as const;\nexport const CANARY_LIVE_WIRING = true as boolean;",
        ),
      "CANARY_LIVE_WIRING must stay false in this build",
    ],
    [
      "review 24 R24-1 (E1): the entry's spender changed, a reviewed copy after the old JSDoc anchor",
      () =>
        withChange("src/security/firewall.ts", (t) => {
          let text = t ?? "";
          text = text.replace(
            '  spender: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",\n  // Circle native USDC (Base).',
            '  spender: "0x000000000000000000000000000000000000dEaD",\n  // Circle native USDC (Base).',
          );
          text = text.replace(
            /\n$/,
            '\n/** The reviewed spender, for the operator view. */\nexport const CANARY_REVIEWED_SPENDER = {\n  spender: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",\n} as const;\n',
          );
          return text;
        }),
      "Exactly one canary entry: Base, the pinned Diamond, USDC, one selector",
    ],
    [
      "review 24 R24-1 (E2): the entry's token changed, a reviewed copy after the old JSDoc anchor",
      () =>
        withChange("src/security/firewall.ts", (t) => {
          let text = t ?? "";
          text = text.replace(
            '  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",\n  // AcrossFacetV4',
            '  token: "0x0000000000000000000000000000000000000001",\n  // AcrossFacetV4',
          );
          text = text.replace(
            /\n$/,
            '\nexport const CANARY_REVIEWED_TOKEN = {\n  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",\n} as const;\n',
          );
          return text;
        }),
      "Exactly one canary entry: Base, the pinned Diamond, USDC, one selector",
    ],
    [
      "review 24 R24-1 (E3): the entry's chain changed, a reviewed copy after the old JSDoc anchor",
      () =>
        withChange("src/security/firewall.ts", (t) => {
          let text = t ?? "";
          text = text.replace(
            'export const canaryContractEntry: Readonly<ContractEntry> = Object.freeze({\n  chainId: "8453",',
            'export const canaryContractEntry: Readonly<ContractEntry> = Object.freeze({\n  chainId: "1",',
          );
          text = text.replace(
            /\n$/,
            '\nexport const CANARY_REVIEWED_CHAIN = {\n  chainId: "8453",\n} as const;\n',
          );
          return text;
        }),
      "Exactly one canary entry: Base, the pinned Diamond, USDC, one selector",
    ],
    [
      "review 24 R24-5 (H1): a hashbang line supplies the disarmed wiring line while the live one is true",
      () =>
        withChange("src/execution/server/gate.ts", (t) => {
          let text = t ?? "";
          text = text.replace(
            "export const CANARY_LIVE_WIRING = false as const;",
            "export const CANARY_LIVE_WIRING = true as boolean;",
          );
          text = text.replace(
            /^/,
            "#!export const CANARY_LIVE_WIRING = false as const;\n",
          );
          return text;
        }),
      "CANARY_LIVE_WIRING must stay false in this build",
    ],
    [
      "review 24 R24-5 (H2): a hashbang line supplies the page-fetch line while the live one is the global fetch",
      () =>
        withChange(ADAPTER, (t) => {
          let text = t ?? "";
          text = text.replace(
            "  const pageFetch = PAGE_FETCH;\n",
            '  const pageFetch = globalThis["fetch"].bind(globalThis);\n',
          );
          text = text.replace(/^/, "#!const pageFetch = PAGE_FETCH;\n");
          return text;
        }),
      "Canary dispatch authority",
    ],
    [
      "review 24 R24-3 (X3a): the registry as the adapter's default export",
      () => sub(ADAPTER, /\n$/, "\nexport default grants;\n"),
      "Canary dispatch authority",
    ],
    [
      "review 24 R24-3 (X4): the registry inside a default-exported object",
      () => sub(ADAPTER, /\n$/, "\nexport default { grants, takeGrant };\n"),
      "Canary dispatch authority",
    ],
    [
      "review 24 R24-3 (X6): the registry exported through an alias",
      () => sub(ADAPTER, /\n$/, "\nexport const registry = grants;\n"),
      "Canary dispatch authority",
    ],
    [
      "review 24 R24-2 (B1): a server call before the owner check, after a `//` string",
      () =>
        sub(
          ADAPTER,
          '  const owner = OWNER_CANARY_APPROVAL;\n  const structural = approvalRecordProblems(owner);\n  if (structural.length || !owner)\n    return no(structural[0] ?? "NO_OWNER_APPROVED_CANARY");\n  if (!(adapter instanceof WalletProviderAdapter) || adapter.revoked)\n    return no("NOT_THE_LIVE_WALLET_ADAPTER");\n  const i = input as unknown;',
          '  const early = ["//", await canaryServer({ action: "canary-confirm" })];\n  void early;\n  const owner = OWNER_CANARY_APPROVAL;\n  const structural = approvalRecordProblems(owner);\n  if (structural.length || !owner)\n    return no(structural[0] ?? "NO_OWNER_APPROVED_CANARY");\n  if (!(adapter instanceof WalletProviderAdapter) || adapter.revoked)\n    return no("NOT_THE_LIVE_WALLET_ADAPTER");\n  const i = input as unknown;',
        ),
      "Canary dispatch authority",
    ],
    [
      "review 24 R24-2 (B2): the commit's server call before the confirmation is spent, after a `//` string",
      () =>
        sub(
          ADAPTER,
          '      : null;\n  if (confirmation && typeof confirmation === "object")\n    confirmations.delete(confirmation);\n  if (!c) return no("CONFIRMATION_REQUIRED");',
          '      : null;\n  if (!c) return no("CONFIRMATION_REQUIRED");\n  const early = ["//", await canaryServer({ action: "canary-record" })];\n  void early;\n  if (confirmation && typeof confirmation === "object")\n    confirmations.delete(confirmation);',
        ),
      "Canary dispatch authority",
    ],
    [
      "review 24 R24-4 (T1): a runtime import with a template-literal specifier",
      () =>
        sub(
          "src/execution/model.ts",
          /\n$/,
          "\nexport const loadRuntime = () => import(`./server/canary/runtime`);\n",
        ),
      "Canary runtime imported outside the API route",
    ],
    [
      "review 24 R24-4 (T2): an aliased runtime import with a template-literal specifier",
      () =>
        sub(
          "src/execution/server/gate.ts",
          /\n$/,
          "\nexport const loadRuntime2 = () => import(`@/execution/server/canary/runtime`);\n",
        ),
      "Canary runtime imported outside the API route",
    ],
    [
      "review 24 R24-4 (S1): a .mjs module under src imports the runtime",
      () =>
        sub(
          "src/server/e2e-origin.mjs",
          /\n$/,
          '\nexport const loadRuntime = () => import("../execution/server/canary/runtime");\n',
        ),
      "Canary runtime imported outside the API route",
    ],
    [
      "review 24 R24-6 (J1): a completed label rendered inside JSX text that looks like a block comment",
      () =>
        sub(
          "src/components/execution-review.tsx",
          '      {attention && (\n        <p\n          role="alert"',
          '      <small>/* {t("g14.c.completed")} */</small>\n      {attention && (\n        <p\n          role="alert"',
        ),
      "Canary panel: one completed label",
    ],
    [
      "review 24 R24-6 (J2): a completed label rendered after JSX text that looks like a line comment",
      () =>
        sub(
          "src/components/execution-review.tsx",
          '      {attention && (\n        <p\n          role="alert"',
          '      <small>// {t("g14.c.completed")}</small>\n      {attention && (\n        <p\n          role="alert"',
        ),
      "Canary panel: one completed label",
    ],
    [
      "review 24 (C2): the closed block's 403 made conditional while a comment quotes it",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          '    guardStatus("WRITE_DISABLED");\n    return reply({ error: "WRITE_DISABLED", gate: canaryStatus().gate }, 403);\n  }\n  let rt',
          '    guardStatus("WRITE_DISABLED");\n    if (r.action.length > 64)\n      return reply({ error: "WRITE_DISABLED", gate: canaryStatus().gate }, 403);\n    // return reply({ error: "WRITE_DISABLED", gate: canaryStatus().gate }, 403);\n  }\n  let rt',
        ),
      "Canary API: WRITE_DISABLED before the runtime while not armed",
    ],
    [
      "review 25 R25-1 (W1a): a new decision file imported with a block comment from a file without canary words",
      () =>
        withChanges([
          [
            "src/execution/extra-rule.ts",
            () => "export const EXTRA_RULE = 1;\n",
          ],
          [
            "src/execution/canonical.ts",
            replaceOnce(
              'import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";\n',
              'import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";\nimport /* the reviewed rule */ "./extra-rule";\n',
            ),
          ],
        ]),
      "Canary decision file outside the inventory",
    ],
    [
      "review 25 R25-1 (W1b): a new decision file imported with a line comment in the import list",
      () =>
        withChanges([
          [
            "src/execution/extra-rule.ts",
            () => "export const EXTRA_RULE = 1;\n",
          ],
          [
            "src/execution/canonical.ts",
            (t) =>
              replaceOnce(
                /\n$/,
                "\nexport const EXTRA = EXTRA_RULE;\n",
              )(
                replaceOnce(
                  'import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";\n',
                  'import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";\nimport {\n  EXTRA_RULE, // the owner\'s rule (don\'t inline)\n} from "./extra-rule";\n',
                )(t),
              ),
          ],
        ]),
      "Canary decision file outside the inventory",
    ],
    [
      "review 25 R25-1 (W1d): a new decision file loaded through a dynamic import with a magic comment",
      () =>
        withChanges([
          [
            "src/execution/extra-rule.ts",
            () => "export const EXTRA_RULE = 1;\n",
          ],
          [
            "src/execution/canonical.ts",
            replaceOnce(
              /\n$/,
              '\nexport const loadExtraRule = () =>\n  import(/* webpackChunkName: "rule" */ "./extra-rule");\n',
            ),
          ],
        ]),
      "Canary decision file outside the inventory",
    ],
    [
      "review 25 R25-1 (W2): the store without canary words, its thread check moved into a comment",
      () =>
        withChanges([
          [
            "src/execution/server/canary/runtime.ts",
            replaceOnce(
              'import {\n  CanaryDurableStore,\n  StoreError,\n  ownerHeadProblem,\n} from "./durable-store";',
              'import {\n  JournalLockedStore as CanaryDurableStore,\n  StoreError,\n  ownerHeadProblem,\n} from "./durable-store";',
            ),
          ],
          [
            "src/execution/server/canary/durable-store.ts",
            (t) =>
              replaceOnce(
                '    if (!isMainThread) throw new StoreError("STORE_THREAD_UNSUPPORTED");\n',
                '    // if (!isMainThread) throw new StoreError("STORE_THREAD_UNSUPPORTED");\n    void isMainThread;\n',
              )(wordlessStore(t)),
          ],
        ]),
      "Canary store: one main thread on one local machine",
    ],
    [
      "review 25 R25-2 (T3): a new decision file loaded through a template-literal specifier",
      () =>
        withChanges([
          [
            "src/execution/extra-rule.ts",
            () => "export const EXTRA_RULE = 1;\n",
          ],
          [
            "src/execution/model.ts",
            replaceOnce(
              /\n$/,
              "\nexport const loadExtraRule = () => import(`./extra-rule`);\n",
            ),
          ],
        ]),
      "Canary decision file outside the inventory",
    ],
    [
      "review 25 R25-2 (S3): an .mjs module with its own fetch imported by an execution file",
      () =>
        withChanges([
          [
            "src/execution/canary/net.mjs",
            () => "export const get = (url) => fetch(url);\n",
          ],
          [
            "src/execution/canary/net.d.mts",
            () =>
              "export declare function get(url: string): Promise<Response>;\n",
          ],
          [
            "src/execution/canary/chain-reads.ts",
            (t) =>
              replaceOnce(
                /\n$/,
                "\nexport const readVia = (u: string) => get(u);\n",
              )(
                replaceOnce(
                  'import type { CanaryCheck } from "./quote-verify";\n',
                  'import type { CanaryCheck } from "./quote-verify";\nimport { get } from "./net.mjs";\n',
                )(t),
              ),
          ],
        ]),
      "src/execution/canary/net.mjs",
    ],
    [
      "review 25 R25-3 (X7): an exported function hands out the registry and another file forges a grant through it",
      () =>
        withChanges([
          [
            ADAPTER,
            replaceOnce(
              /\n$/,
              "\nexport function authorityRegistry() {\n  return grants;\n}\n",
            ),
          ],
          [
            "src/execution/model.ts",
            (t) =>
              'import { authorityRegistry } from "@/features/wallet/adapter";\n' +
              replaceOnce(
                /\n$/,
                "\nexport const forge = (a: object, g: never) => authorityRegistry().set(a, g);\n",
              )(t),
          ],
        ]),
      "Canary dispatch authority",
    ],
    [
      "review 25 R25-3 (X8): an exported class with a static getter of the registry",
      () =>
        withChanges([
          [
            ADAPTER,
            replaceOnce(
              /\n$/,
              "\nexport class AuthorityRegistry {\n  static of() {\n    return grants;\n  }\n}\n",
            ),
          ],
        ]),
      "Canary dispatch authority",
    ],
    [
      "review 25 R25-3 (X9): an exported function hands out the confirmation registry",
      () =>
        withChanges([
          [
            ADAPTER,
            replaceOnce(
              /\n$/,
              "\nexport function confirmationRegistry() {\n  return confirmations;\n}\n",
            ),
          ],
        ]),
      "Canary dispatch authority",
    ],
    [
      "review 25 R25-3 (X10): a local alias of the registry exported by a list",
      () =>
        withChanges([
          [
            ADAPTER,
            replaceOnce(
              /\n$/,
              "\nconst registry = grants;\nexport { registry };\n",
            ),
          ],
        ]),
      "Canary dispatch authority",
    ],
    [
      "review 25 R25-4 (H3): a hashbang after a byte-order mark supplies the disarmed wiring line",
      () =>
        withChanges([
          [
            "src/execution/server/gate.ts",
            (t) =>
              "\uFEFF#!export const CANARY_LIVE_WIRING = false as const;\n" +
              replaceOnce(
                "export const CANARY_LIVE_WIRING = false as const;",
                "export const CANARY_LIVE_WIRING = true as boolean;",
              )(t),
          ],
        ]),
      "CANARY_LIVE_WIRING must stay false in this build",
    ],
    [
      "review 25 R25-4 (H4): a hashbang after a byte-order mark supplies the page-fetch line",
      () =>
        withChanges([
          [
            ADAPTER,
            (t) =>
              "\uFEFF#!const pageFetch = PAGE_FETCH;\n" +
              replaceOnce(
                "  const pageFetch = PAGE_FETCH;\n",
                '  const pageFetch = globalThis["fetch"].bind(globalThis);\n',
              )(t),
          ],
        ]),
      "Canary dispatch authority",
    ],
    [
      "review 26 R26-1 (H7): a block comment opened on a hashbang line after a byte-order mark supplies the disarmed wiring line",
      () =>
        withChanges([
          [
            "src/execution/server/gate.ts",
            (t) =>
              "\uFEFF#!/*\n/*\nexport const CANARY_LIVE_WIRING = false as const;\n*/\n" +
              replaceOnce(
                "export const CANARY_LIVE_WIRING = false as const;",
                "export const CANARY_LIVE_WIRING = true as boolean;",
              )(t),
          ],
        ]),
      "CANARY_LIVE_WIRING must stay false in this build",
    ],
    [
      "review 26 R26-1 (H7b): the same with CRLF line breaks",
      () =>
        withChanges([
          [
            "src/execution/server/gate.ts",
            (t) =>
              "\uFEFF#!/*\r\n/*\r\nexport const CANARY_LIVE_WIRING = false as const;\r\n*/\r\n" +
              replaceOnce(
                "export const CANARY_LIVE_WIRING = false as const;",
                "export const CANARY_LIVE_WIRING = true as boolean;",
              )(t),
          ],
        ]),
      "CANARY_LIVE_WIRING must stay false in this build",
    ],
    [
      "review 15 R15-1: the reconciliation no longer finds the fill below the final block",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          "!fill.logs?.some((l) => lower(l.transactionHash) === lower(fillHash))",
          "false",
        ),
      "an undecided search never ends a record",
    ],
    [
      "a signing-path API action before the closed check",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          "  const armed = canaryArmed();\n  if (!armed.armed) {",
          "  const rt0 = canaryRuntime();\n  void rt0;\n  const armed = canaryArmed();\n  if (!armed.armed) {",
        ),
      "Canary API: WRITE_DISABLED before the runtime",
    ],
  ];
  for (const [name, mutate, message] of CASES)
    it(`fails on: ${name}`, () => {
      expectFail(mutate(), message);
    }, 120000);
  // Review 18 R18-2: honest comment lines between the pinned statements do not fail the scanner.
  const PASSES: [string, () => { ok: boolean; output: string }][] = [
    [
      "(F5) a comment line above the reconciliation's head reads",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          '    const [base, arb] = await Promise.all([\n      readBalancesAtHead("8453", owner.account, signal).catch(() => null),',
          '    // Both chains\' agreed heads (two operators each).\n    const [base, arb] = await Promise.all([\n      readBalancesAtHead("8453", owner.account, signal).catch(() => null),',
        ),
    ],
    [
      "(F6) a comment line above the settlement's destination head read",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          '    const head =\n      (\n        await readBalancesAtHead("42161", owner.account, signal).catch(',
          '    // The destination\'s agreed head.\n    const head =\n      (\n        await readBalancesAtHead("42161", owner.account, signal).catch(',
        ),
    ],
  ];
  PASSES.push(
    [
      "(R23-7 F4) a comment mentioning a durable journal",
      () =>
        sub(
          "src/execution/model.ts",
          /\n$/,
          "\n// A journal is durable: only the store says so.\n",
        ),
    ],
    [
      "(R23-7 F5) a comment naming the out-of-scope selector",
      () =>
        sub(
          "src/execution/model.ts",
          /\n$/,
          "\n// 0xa1f1ce43 (multicall) stays out of scope.\n",
        ),
    ],
    [
      "(R23-7 F6) the last-check comment reworded",
      () =>
        sub(
          ADAPTER,
          "The identity read above was the last await; it can take up to",
          "The identity read above is the last await; it can take up to",
        ),
    ],
    [
      "(R23-7 F7) a comment naming await before the last check",
      () =>
        sub(
          ADAPTER,
          '        this.#live();\n        if (context.signal?.aborted) throw new BridgeError("IDENTITY_CHANGED");',
          '        // Do not add an await here.\n        this.#live();\n        if (context.signal?.aborted) throw new BridgeError("IDENTITY_CHANGED");',
        ),
    ],
  );
  PASSES.push(
    [
      "(R24-1 N1) a NOT_FOUND constant outside the replacement search",
      () =>
        sub(
          "src/execution/server/canary/runtime.ts",
          /\n$/,
          '\nexport const NOT_FOUND_ANSWER = { status: "NOT_FOUND" } as const;\n',
        ),
    ],
    [
      "(R24-6 J3) a real JSX comment around label text",
      () =>
        sub(
          "src/components/execution-review.tsx",
          '      {attention && (\n        <p\n          role="alert"',
          '      {/* t("g14.c.completed") */}\n      {attention && (\n        <p\n          role="alert"',
        ),
    ],
    [
      "(R24 C1) comments inside the handler's closed block",
      () =>
        sub(
          "src/app/api/execution/route.ts",
          '    guardStatus("WRITE_DISABLED");\n    return reply({ error: "WRITE_DISABLED", gate: canaryStatus().gate }, 403);',
          '    guardStatus("WRITE_DISABLED"); // counted\n    /* the closed answer */ return reply({ error: "WRITE_DISABLED", gate: canaryStatus().gate }, 403);',
        ),
    ],
  );
  PASSES.push([
    "(R26-1 H8) a byte-order mark, an ordinary hashbang and an ordinary comment",
    () =>
      withChanges([
        [
          "src/execution/server/gate.ts",
          (t) => "\uFEFF#!/usr/bin/env node\n/* note */\n" + (t ?? ""),
        ],
      ]),
  ]);
  PASSES.push([
    "(R25-4 H6) a byte-order mark alone",
    () =>
      withChanges([
        ["src/execution/server/gate.ts", (t) => "\uFEFF" + (t ?? "")],
      ]),
  ]);
  for (const [name, edit] of PASSES)
    it(`still passes with: ${name}`, () => {
      const r = edit();
      expect(r.ok, r.output.slice(-600)).toBe(true);
    }, 120000);
  it("the unmodified canary path passes and reports its added rules", () => {
    const r = run();
    expect(r.ok, r.output.slice(-600)).toBe(true);
    expect(r.output).toMatch(
      /g14Canary: \{ inventory: \d+, decisionClosure: \d+, rules: 12 \}/,
    );
  }, 120000);
});
