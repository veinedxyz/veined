import { it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  RoutingCore,
  upstreamRead,
  type ReadTransport,
} from "../../src/adapters/routing-core";
import { RoutingError, type QuoteInput } from "../../src/routing/model";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
it("M9 bounded public API reads (no wallet or write methods)", async () => {
  if (!base) throw Error("A unique evidence directory is required");
  await mkdir(base, { recursive: true });
  const requests: unknown[] = [];
  let sequence = 0;
  const read: ReadTransport = async (path, params, signal) => {
    const at = new Date().toISOString(),
      requestId = sequence++;
    try {
      const result = await upstreamRead(path, params, signal);
      const raw = JSON.stringify(result, null, 2);
      const file = `${base}/${requestId}-${path}.json`;
      await writeFile(file, raw, { flag: "wx" });
      requests.push({
        path,
        params,
        observedAt: at,
        result: "READ_OK",
        bytes: Buffer.byteLength(raw),
        sha256: createHash("sha256").update(raw).digest("hex"),
        file,
      });
      return result;
    } catch (e) {
      requests.push({
        path,
        params,
        observedAt: at,
        result: "BLOCKED",
        reason: e instanceof RoutingError ? e.code : "EVIDENCE_RECORDING_ERROR",
        httpStatus: e instanceof RoutingError ? e.httpStatus : undefined,
        diagnostic: e instanceof RoutingError ? undefined : String(e),
      });
      throw e;
    }
  };
  const provider = new RoutingCore(read),
    catalog = await provider.listNetworks();
  expect(catalog.networks.some((n) => n.id === "612055")).toBe(true);
  const cases = [];
  let quotePass = false;
  if (!catalog.stale) {
    const source = catalog.networks.find((n) => n.key === "eth")!,
      destination = catalog.networks.find((n) => n.key === "bas")!;
    try {
      const c = await provider.getConnections(source.id, destination.id);
      cases.push({
        case: "ETH-Base-connection",
        connections: c.length,
        executable: false,
      });
    } catch (e) {
      cases.push({ case: "ETH-Base-connection", error: String(e) });
    }
    const input: QuoteInput = {
      source: source.id,
      destination: destination.id,
      sourceAsset: source.nativeAsset.address,
      destinationAsset: destination.nativeAsset.address,
      amount: "10000000000000000",
      sourceAddress: "0x3333333333333333333333333333333333333333",
      destinationAddress: "0x3333333333333333333333333333333333333333",
      generation: catalog.generation,
      slippage: 0.005,
      preference: "receive",
      walletRevision: 0,
    };
    for (const key of ["bas", "sol"]) {
      const dest = catalog.networks.find((n) => n.key === key)!;
      const current = {
        ...input,
        destination: dest.id,
        destinationAsset: dest.nativeAsset.address,
        destinationAddress:
          key === "sol"
            ? "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z"
            : input.destinationAddress,
      };
      try {
        const q = await provider.getQuotes(current);
        expect(q[0].executable).toBe(false);
        quotePass = true;
        cases.push({
          case: `ETH-${key}-quote`,
          result: "PASS_READ_ONLY",
          quote: q[0],
        });
      } catch (e) {
        cases.push({
          case: `ETH-${key}-quote`,
          result: "BLOCKED",
          error: e instanceof RoutingError ? e.code : String(e),
        });
      }
    }
  }
  const summary = {
    at: new Date().toISOString(),
    sdk: "4.10.0",
    types: "18.12.1",
    catalogNetworks: catalog.networks.length,
    stale: catalog.stale,
    M9: !catalog.stale && quotePass ? "PASS_READ_ONLY" : "BLOCKED",
    catalog,
    requests,
    cases,
    execution: false,
    signatures: 0,
    approvals: 0,
    broadcasts: 0,
    deploys: 0,
    G5: "UNCHANGED_BLOCKED",
    scope:
      "Actual public endpoint reading; no funded account or route execution claimed",
  };
  await writeFile(
    `${base}/live-readonly.json`,
    JSON.stringify(summary, null, 2),
    { flag: "wx" },
  );
  console.log("M9", summary.M9, "requests", requests.length);
  expect(requests.length).toBeLessThanOrEqual(7);
});
