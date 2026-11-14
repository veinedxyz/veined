import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { swapConfig } from "../src/swap/server/config";
import { uniswap } from "../src/swap/server/providers/uniswap";
import { jupiter } from "../src/swap/server/providers/jupiter";
import { titan } from "../src/swap/server/providers/titan";
import { pcsx } from "../src/swap/server/providers/pcsx";
import { swapIntent, solIntent } from "../tests/fixtures/swap";
import { SwapError } from "../src/swap/model";
const c = swapConfig();
const out =
  process.argv[2] ??
  readFileSync(".otherbridge/v116-evidence-path.txt", "utf8").trim() +
    "/sources/provider-preflight.json";
const jobs = [
  {
    name: "Uniswap",
    configured: !!c.uniswapKey,
    adapter: uniswap(c.uniswapKey),
    intent: swapIntent(),
  },
  {
    name: "Jupiter",
    configured: !!c.jupiterKey,
    adapter: jupiter(c.jupiterKey, "JUPITER_ROUTER"),
    intent: solIntent(),
  },
  {
    name: "Titan",
    configured: !!c.titanToken && !!c.titanEndpoint,
    adapter: titan(c.titanEndpoint, c.titanToken),
    intent: solIntent(),
  },
  {
    name: "PCSX",
    configured: c.pcsx,
    adapter: pcsx(c.pcsx, c.pcsxKey),
    intent: swapIntent({
      tokenIn: {
        chain: "1",
        address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        native: false,
        decimals: 18,
        symbol: "WETH",
      },
    }),
  },
];
const results = [];
for (const job of jobs) {
  const base = {
    provider: job.name,
    credentialConfigured: job.name === "PCSX" ? !!c.pcsxKey : job.configured,
    optedIn: job.name === "PCSX" ? c.pcsx : null,
    authentication:
      job.name === "PCSX"
        ? "OPTIONAL_INTEGRATOR_KEY_OR_ANONYMOUS"
        : "SERVER_CREDENTIAL_REQUIRED",
    serverOnly: true,
    execution: "CLOSED",
  };
  if (!job.configured || c.killed.has(job.adapter.mode)) {
    results.push({
      ...base,
      status: !job.configured
        ? job.name === "PCSX"
          ? "OPT_IN_DISABLED"
          : "OWNER_INPUT_REQUIRED"
        : "KILLED",
      requests: 0,
    });
    continue;
  }
  try {
    const quotes = await job.adapter.quote(
      job.intent,
      AbortSignal.timeout(12000),
    );
    results.push({
      ...base,
      status: "READ_ONLY_QUOTE_VALIDATED",
      quotes: quotes.length,
    });
  } catch (e) {
    results.push({
      ...base,
      status: "READ_ONLY_VALIDATION_FAILED",
      error: e instanceof SwapError ? e.code : "PROVIDER_UNAVAILABLE",
    });
  }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      results,
      method:
        "Synthetic public test identity; server-side quote only; no raw requests, responses or credentials in evidence.",
      execution: "CLOSED",
      signatures: 0,
      broadcasts: 0,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log(JSON.stringify(results));
