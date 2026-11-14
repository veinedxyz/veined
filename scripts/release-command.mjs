import { spawn } from "node:child_process";
const commands = new Set([
  "release-credentials",
  "release-external-gates",
  "release-schemas",
]);
const command = process.argv[2];
if (!commands.has(command)) throw Error("UNKNOWN_RELEASE_COMMAND");
const child = spawn(
  process.execPath,
  [
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    "--import",
    "./scripts/ts-hooks.mjs",
    `scripts/${command}.ts`,
    ...process.argv.slice(3),
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
// Providers run only through reviewed redacting transports. Drop stderr rather than forward unsafe network/library diagnostics.
child.stdout.pipe(process.stdout);
child.stderr.resume();
let failed = false;
child.on("error", () => {
  failed = true;
  console.error("RELEASE_COMMAND_FAILED_REDACTED");
  process.exitCode = 1;
});
child.on("close", (code) => {
  if (!failed && code !== 0) {
    if (command === "release-external-gates" && code === 2) {
      process.exitCode = 2;
      return;
    }
    console.error("RELEASE_COMMAND_FAILED_REDACTED");
    process.exitCode = code ?? 1;
  }
});
