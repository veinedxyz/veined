import { readFile, writeFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { keccak256 } from "viem";
import solc from "solc";
const base = "evidence/otherbridge-v1/repair-r1/sources";
const run = process.argv[2] ?? "b";
if (!/^[a-z0-9-]+$/.test(run)) throw Error("INVALID_RUN_NAME");
const outputFile = `${base}/runtime-source-comparison-${run}.json`;
try {
  await access(outputFile);
  throw Error("EVIDENCE_ALREADY_EXISTS");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const manifest = JSON.parse(
  await readFile(
    `${base}/${run === "current" ? "historical-build-inputs-current" : "historical-build-inputs"}.json`,
    "utf8",
  ),
);
const discovery = JSON.parse(
  await readFile(
    "evidence/otherbridge-v1/repair-r1/live/discovery.json",
    "utf8",
  ),
);
const compiler = solc.setupMethods(
  createRequire(import.meta.url)(join(manifest.cache, "soljson.cjs")),
);
if (!compiler.version().startsWith("0.8.28+commit.7893614a"))
  throw Error("COMPILER_VERSION_MISMATCH");
const results = [];
const stripMetadata = (hex) => {
  const bytes = Number.parseInt(hex.slice(-4), 16) + 2;
  return hex.slice(0, -bytes * 2);
};
for (const build of manifest.builds) {
  for (const viaIR of [true, false]) {
    console.log(`Compiling ${build.label}, optimizer=1, viaIR=${viaIR}`);
    const input = {
      language: "Solidity",
      sources: {},
      settings: {
        optimizer: { enabled: true, runs: 1 },
        viaIR,
        remappings: [
          "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
          "@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/",
        ],
        outputSelection: {
          "*": { "*": ["evm.deployedBytecode", "metadata", "abi"] },
        },
      },
    };
    for (const name of ["CrossBridge", "BSCBridge", "BSCBridgeV2"])
      try {
        input.sources[`src/${name}.sol`] = {
          content: await readFile(
            join(manifest.cache, build.projectDirectory, `src/${name}.sol`),
            "utf8",
          ),
        };
      } catch {
        /* This version may not have V2. */
      }
    if (build.label === "current-legacy")
      input.sources["test/legacy/CrossBridgeLegacy.sol"] = {
        content: await readFile(
          join(
            manifest.cache,
            build.projectDirectory,
            "test/legacy/CrossBridgeLegacy.sol",
          ),
          "utf8",
        ),
      };
    const loadedSources = { ...input.sources };
    const compiled = JSON.parse(
      compiler.compile(JSON.stringify(input), {
        import: (path) => {
          if (path.includes("..") || path.startsWith("/"))
            return { error: "UNSAFE_IMPORT" };
          let file = join(manifest.cache, build.projectDirectory, path);
          for (const [prefix, dependency] of Object.entries(build.dependencies))
            if (path.startsWith(prefix + "/"))
              file = join(
                manifest.cache,
                dependency.directory,
                path.slice(prefix.length + 1),
              );
          try {
            const content = createRequire(import.meta.url)(
              "node:fs",
            ).readFileSync(file, "utf8");
            loadedSources[path] = { content };
            return { contents: content };
          } catch {
            return { error: `MISSING_PINNED_IMPORT_${path}` };
          }
        },
      }),
    );
    const evidenceInput = { ...input, sources: loadedSources };
    const inputPath = `${base}/compile-input-${run}-${build.label}-${viaIR ? "ir" : "legacy"}.json`;
    await writeFile(inputPath, JSON.stringify(evidenceInput, null, 2), {
      flag: "wx",
    });
    const result = {
      label: build.label,
      commit: build.commit,
      compiler: compiler.version(),
      viaIR,
      input: inputPath,
      errors: compiled.errors ?? [],
      comparisons: [],
    };
    for (const [chain, name] of [
      ["one", "CrossBridge"],
      ["one", "CrossBridgeLegacy"],
      ["bsc", "BSCBridge"],
      ["bsc", "BSCBridgeV2"],
    ]) {
      const contract =
        compiled.contracts?.[
          name === "CrossBridgeLegacy"
            ? "test/legacy/CrossBridgeLegacy.sol"
            : `src/${name}.sol`
        ]?.[name];
      if (!contract?.evm?.deployedBytecode?.object) continue;
      let code = contract.evm.deployedBytecode.object;
      const address = discovery.snapshots[chain].implementation
        .slice(2)
        .padStart(64, "0");
      for (const refs of Object.values(
        contract.evm.deployedBytecode.immutableReferences ?? {},
      ))
        for (const ref of refs) {
          if (ref.length !== 32) throw Error("UNEXPECTED_IMMUTABLE_SIZE");
          code =
            code.slice(0, ref.start * 2) +
            address +
            code.slice((ref.start + ref.length) * 2);
        }
      const runtime = discovery.calls
        .find(
          (c) =>
            c.chain === chain &&
            c.method === "eth_getCode" &&
            c.params[0] === discovery.snapshots[chain].implementation,
        )
        .result.slice(2);
      const comparison = {
        chain,
        contract: name,
        immutableSubstitution: "UUPS __self = observed implementation address",
        byteLength: code.length / 2,
        expectedByteLength: runtime.length / 2,
        keccak256DecodedBytes: keccak256(`0x${code}`),
        fullRuntimeEqual: code === runtime,
        executablePrefixEqualAfterCborRemoval:
          stripMetadata(code) === stripMetadata(runtime),
        linkReferences: contract.evm.deployedBytecode.linkReferences,
      };
      result.comparisons.push(comparison);
      console.log(JSON.stringify(comparison));
    }
    results.push(result);
  }
}
await writeFile(
  outputFile,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      compilerRelease: manifest.compiler,
      note: "Historical source attempts. Only fullRuntimeEqual is full bytecode equality; prefix equality alone is not metadata/source provenance. No deployment was made.",
      results,
      signatures: 0,
      broadcasts: 0,
      deployments: 0,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(outputFile);
