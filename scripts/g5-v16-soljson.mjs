// Compile Standard JSON (stdin) with an explicitly supplied official soljson build (argv[2]); prints
// "<version>\n<Standard JSON output>". Forensics-only; the caller verifies the soljson SHA-256 against
// binaries.soliditylang.org/wasm/list.json before use.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import wrapper from "solc/wrapper.js";

const load = createRequire(import.meta.url);
const solc = wrapper(load(resolve(process.argv[2])));
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  process.stdout.write(solc.version() + "\n");
  process.stdout.write(solc.compile(input));
});
