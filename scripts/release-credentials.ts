import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  checkCredentials,
  checkUniswapChains,
  validateJupiterModes,
  type CredentialProvider,
} from "../src/release/credentials";

// Read only this explicit local credential source; never copy or serialize it.
const env = {
  ...(existsSync(".env.local")
    ? parseEnv(readFileSync(".env.local", "utf8"))
    : {}),
  ...process.env,
};
const offline = process.argv.includes("--offline");
const out = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6);
async function probe(
  provider: CredentialProvider,
  activeModes: readonly string[],
) {
  const { swapIntent, solIntent } = await import("../tests/fixtures/swap");
  const signal = AbortSignal.timeout(15000);
  if (provider === "Uniswap") {
    const { uniswap } = await import("../src/swap/server/providers/uniswap");
    if (!(await checkUniswapChains(env.UNISWAP_API_KEY!))) return false;
    return (
      (await uniswap(env.UNISWAP_API_KEY!).quote(swapIntent(), signal)).length >
      0
    );
  }
  if (provider === "Jupiter") {
    const { jupiter } = await import("../src/swap/server/providers/jupiter");
    return validateJupiterModes(
      activeModes,
      async (mode) =>
        (await jupiter(env.JUPITER_API_KEY!, mode).quote(solIntent(), signal))
          .length > 0,
      (ms) => delay(ms, undefined, { signal }),
    );
  }
  if (provider === "Titan") {
    const { titan } = await import("../src/swap/server/providers/titan");
    return (
      (
        await titan(env.TITAN_WS_ENDPOINT!, env.TITAN_AUTH_TOKEN!).quote(
          solIntent(),
          signal,
        )
      ).length > 0
    );
  }
  const { pcsx } = await import("../src/swap/server/providers/pcsx");
  return (
    (
      await pcsx(true, env.PCSX_INTEGRATOR_KEY!).quote(
        swapIntent({
          tokenIn: {
            chain: "1",
            address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            native: false,
            decimals: 18,
            symbol: "WETH",
          },
        }),
        signal,
      )
    ).length > 0
  );
}
try {
  const result = await checkCredentials(env, offline ? undefined : probe);
  if (out) {
    const path = resolve(out);
    if (
      !path.startsWith(process.cwd() + "/") &&
      !path.startsWith(process.cwd() + "\\")
    )
      throw Error("OUTPUT_REFUSED");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  }
  console.log(JSON.stringify(result, null, 2));
  if (
    result.errors.length ||
    result.providers.some((row) =>
      ["INVALID_CONFIGURATION", "READ_ONLY_FAILED"].includes(row.status),
    )
  )
    process.exitCode = 1;
} catch {
  console.error("CREDENTIAL_CHECK_FAILED_REDACTED");
  process.exitCode = 1;
}
