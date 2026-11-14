// The accepted root lock is immutable. These two upstream security fixes are
// separately frozen in swap-providers/pnpm-lock.yaml. Next's Node processes use
// the same replacements as Turbopack's client/server bundle aliases.
import { registerHooks } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const packages = [
  ["decode-uri-component", "0.5.1", "../src/security/decode-uri-component.cjs"],
  [
    "source-map-js",
    "1.2.2",
    "../swap-providers/node_modules/source-map-js/source-map.js",
  ],
];
if (Number(process.versions.node.split(".")[0]) < 24)
  throw new Error("OTHERBRIDGE_DEPENDENCY_PINS_REQUIRE_NODE_24");
const replacements = new Map();
for (const [name, version, entry] of packages) {
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        `../swap-providers/node_modules/${name}/package.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (manifest.name !== name || manifest.version !== version)
    throw new Error(`OTHERBRIDGE_DEPENDENCY_PIN_MISMATCH ${name}`);
  replacements.set(
    name,
    pathToFileURL(realpathSync(fileURLToPath(new URL(entry, import.meta.url))))
      .href,
  );
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const pinned = replacements.get(specifier);
    return pinned
      ? { url: pinned, format: "commonjs", shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
