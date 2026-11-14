import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseE2EOrigin } from "../src/server/e2e-origin.mjs";
import { registerProcess } from "./lib/process-identity.mjs";
const { origin, port } = parseE2EOrigin(process.env.OTHERBRIDGE_E2E_ORIGIN);
// V1.9: the E2E server enables the Privy wallet layer with a TEST-ONLY App ID that does not exist at Privy. Every
// browser test answers Privy/WalletConnect traffic with deterministic doubles (tests/e2e/privy-mock.ts), so the
// real Privy SDK runs against fixtures and no request ever leaves the machine.
const TEST_PRIVY_APP_ID = "obtestprivyapp00000000001";
const child = spawn(
  process.execPath,
  [
    "scripts/next-pinned.mjs",
    "dev",
    "--disable-source-maps",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "development",
      NODE_OPTIONS: "--max-old-space-size=1024",
      OTHERBRIDGE_MODE: "local-test",
      OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION: "false",
      OTHERBRIDGE_E2E_ISOLATED: "1",
      OTHERBRIDGE_E2E_ORIGIN: origin,
      OTHERBRIDGE_APP_ORIGINS: origin,
      NEXT_PUBLIC_PRIVY_APP_ID:
        process.env.OTHERBRIDGE_E2E_PRIVY === "off" ? "" : TEST_PRIVY_APP_ID,
    },
  },
);
if (process.env.OTHERBRIDGE_E2E_PROCESS_DIRECTORY) {
  const directory = process.env.OTHERBRIDGE_E2E_PROCESS_DIRECTORY;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "server-processes.json"),
    JSON.stringify({
      processes: [
        registerProcess(process.pid, directory),
        registerProcess(child.pid, directory),
      ].filter(Boolean),
      at: new Date().toISOString(),
    }),
  );
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
child.on("error", () => process.exit(1));
child.on("exit", (code) => process.exit(code ?? 1));
