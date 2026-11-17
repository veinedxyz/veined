import { spawnSync } from "node:child_process";
const action = process.argv[2];
if (!["build", "start"].includes(action)) {
  console.error("Usage: node scripts/post-hackathon-preview.mjs build|start");
  process.exit(2);
}
const env = {
  ...process.env,
  NEXT_PUBLIC_VEINED_WALLET_LAYER: "rainbowkit",
  NEXT_TELEMETRY_DISABLED: "1",
  OTHERBRIDGE_APP_ORIGINS: "http://127.0.0.1:3470",
  OTHERBRIDGE_DEPLOYMENT_ENV: "local",
};
function run(args) {
  const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (action === "build") run(["scripts/i18n-check.mjs"]);
run([
  "scripts/next-pinned.mjs",
  action,
  ...(action === "start" ? ["--hostname", "127.0.0.1", "--port", "3470"] : []),
]);
