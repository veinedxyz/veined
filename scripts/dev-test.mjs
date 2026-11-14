import { spawn } from "node:child_process";
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3100",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      OTHERBRIDGE_MODE: "local-test",
      OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION: "false",
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
