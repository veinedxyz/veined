import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { keccak256 } from "viem";
const root = (
  await readFile(".otherbridge/v12-evidence-path.txt", "utf8")
).trim();
const json = async (p) => JSON.parse(await readFile(p, "utf8"));
const current = await json(
  `${root}/g5/current-native/native-live-readonly.json`,
);
const oldDirectory = "evidence/otherbridge-v1/repair-r1/sources";
const files = new Set([
  "runtime-source-comparison-b.json",
  "runtime-source-comparison-current.json",
  "solc-0.8.28-official-release.json",
  "historical-build-inputs.json",
  "historical-build-inputs-current.json",
]);
const comparisons = [];
for (const file of [...files].filter((f) => f.startsWith("runtime-source"))) {
  const report = await json(`${oldDirectory}/${file}`);
  for (const attempt of report.results) {
    files.add(attempt.input.split("/").at(-1));
    const input = await json(attempt.input);
    comparisons.push({
      provenance:
        "Reused accepted R1 experiment; no new compilation or deployment",
      originalReport: `${oldDirectory}/${file}`,
      originalAt: report.at,
      revision: attempt.commit,
      compiler: attempt.compiler,
      settings: input.settings,
      sourcePaths: Object.keys(input.sources),
      comparisons: attempt.comparisons,
      compilerErrors: attempt.errors.filter((e) => e.severity === "error"),
    });
  }
}
await mkdir(`${root}/g5/reused-build-evidence`, { recursive: true });
const reused = [];
for (const file of files) {
  const bytes = await readFile(`${oldDirectory}/${file}`);
  await copyFile(
    `${oldDirectory}/${file}`,
    `${root}/g5/reused-build-evidence/${file}`,
  );
  reused.push({
    file,
    originalPath: `${oldDirectory}/${file}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const runtimeCalls = current.calls.filter((c) => c.method === "eth_getCode");
const runtime = runtimeCalls.map((c) => ({
  ...c,
  runtimeKeccak256:
    typeof c.result === "string" && c.result.startsWith("0x")
      ? keccak256(c.result)
      : undefined,
}));
const report = {
  at: new Date().toISOString(),
  result: "BLOCKED",
  currentObservation: `${root}/g5/current-native/native-live-readonly.json`,
  deploymentIdentity:
    "PASS_POINT_IN_TIME: live chain IDs, EIP-1967 slots, proxy and implementation hashes pinned; current pair independently agrees",
  sourceBuildEquivalence: "BLOCKED",
  currentOfficialRevision: "3a8347cd005d00e50af9194204a55da69f96ddfc",
  runtime,
  exactDeployment: {
    compiler: null,
    optimizer: null,
    viaIR: null,
    evmVersion: null,
    metadataBytecodeHash: null,
    appendCBOR: null,
    dependencies: null,
    sourcePaths: null,
    libraries: null,
    immutables: null,
    sourceRevision: null,
  },
  experiments: comparisons,
  reusedEvidence: reused,
  comparisonPolicy:
    "Only exact full deployed runtime equality with independently established build inputs/provenance qualifies. Metadata-stripped executable comparison and UUPS __self substitution are diagnostics only. Successful ABI reads do not prove source/build equivalence.",
  newResearch: `${root}/g5/research/requests.json`,
  blockers: [
    "Authoritative deployment Standard JSON / metadata plus exact sources, dependency revisions, compiler settings, library addresses and immutable values for both live implementations",
    "Same-version payout limits and a complete pinned-block reconciliation of custody, pending transfers and obligations proving spendable CROSS reserve",
    "A second historical sample with canonical ONE source receipt/archive proof; current public candidates lack that receipt",
    "A current bounded positive bridge simulation/quote; current public-account probes failed and are not evidence of executability",
  ],
  reserve: {
    verified: false,
    conservativeReserveBound: current.health.limits.conservativeReserveBound,
    reason:
      "Custody/accounting bound is not spendable reserve; exact implementation build and complete obligation reconciliation unavailable",
  },
  currentQuote: current.quoteError,
  signatures: 0,
  approvals: 0,
  broadcasts: 0,
  deploys: 0,
};
report.liveRuntimePins = {
  oneProxy:
    "0x0dac1e1deb9381d1139c43a9d49d022a4786242e90744abd0f77bf85375b548b",
  oneImplementation:
    "0x8bb2e9361035520a62a806cf78ff6f325d32c578a63f35ad49263524361e04bc",
  bscProxy:
    "0x25b30cfa97d56a7b846443ce92558cf31d86e95966c5afa22dacb0213c52ff9b",
  bscImplementation:
    "0x47b60de2375276f3ead49ea41f35c58d068d6bd57625d3553db4257476f91f22",
};
await writeFile(
  `${root}/g5/deployment-build-equivalence.json`,
  JSON.stringify(report, null, 2),
);
console.log("G5 BLOCKED; build experiments preserved, reserve unverified");
