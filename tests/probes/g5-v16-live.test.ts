// V1.6 G5 opt-in LIVE read-only probe of the application path (DNS-pinned allowlisted RPC adapter):
// runtime pins, settlement trust, drift policy, exact reserve model, health. No wallet, no signing.
import { expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";

const audit = vi.hoisted(() => ({
  calls: [] as { chain: string; method: string; at: string; error?: string }[],
}));
vi.mock("../../src/adapters/read-only", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/adapters/read-only")>();
  return {
    ...real,
    rpc: async (
      chain: "one" | "bsc",
      method: string,
      params: unknown[] = [],
    ) => {
      const call: (typeof audit.calls)[number] = {
        chain,
        method,
        at: new Date().toISOString(),
      };
      audit.calls.push(call);
      try {
        return await real.rpc(chain, method, params);
      } catch (e) {
        call.error = `${(e as { code?: string }).code ?? String(e)} ${JSON.stringify((e as { cause?: unknown }).cause ?? null)}`;
        throw e;
      }
    },
  };
});
import {
  nativeHealth,
  nativeSnapshot,
} from "../../src/adapters/native-service";

const READ = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getStorageAt",
  "eth_getCode",
  "eth_call",
  "eth_getLogs",
  "eth_getBalance",
  "eth_gasPrice",
]);
const json = (x: unknown) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1);

it("V1.6 live app path: exact-build pins hold, trust unchanged, reserve reconciled, writes disabled", async () => {
  const out = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
  expect(
    out,
    "OTHERBRIDGE_EVIDENCE_ROOT must point at the V1.6 evidence root",
  ).toBeTruthy();
  const snapshot = await nativeSnapshot();
  const health = await nativeHealth();
  await mkdir(`${out}/production-like`, { recursive: true });
  await writeFile(
    `${out}/production-like/app-native-snapshot.json`,
    json({ snapshot, health, rpcCalls: audit.calls }),
  );
  expect(audit.calls.every((c) => READ.has(c.method))).toBe(true);
  expect(snapshot.routeDrift).toEqual({
    state: "VERIFIED_READ_ONLY",
    reasons: [],
    executable: false,
  });
  expect(snapshot.deploymentEvidence).toBe(
    "RUNTIME_PINNED_EXACT_BUILD_REPRODUCED",
  );
  expect(snapshot.reserve.verified).toBe(true);
  expect(snapshot.reserve.spendable >= snapshot.minimum).toBe(true);
  expect(health.status).toBe("blocked");
  expect(health.reasons).toEqual(["MAINNET_WRITE_DISABLED"]);
  expect(health.limits?.reserveVerified).toBe(true);
});
