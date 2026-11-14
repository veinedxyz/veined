// G14 closure — SYNTHETIC_TEST_ONLY child process for the real kill / restart tests (positive test-only variant only).
// It runs the REAL runtime on a store directory, with the fake chain behind fetch and a fake LI.FI behind the
// adapter's own node:https / node:dns transport, drives one APPROVE step through the real submission boundary and the
// real adapter to a crash point, and then kills ITSELF (no clean-up, no lock release). The second run ("recover") only
// opens the store, prints the rebuilt state and checks that nothing asks the wallet again.
// Every wallet request is appended (fsync) to <calls> before it is answered. Nothing signs or reaches a network.
// Usage: node --experimental-transform-types --import ./scripts/ts-hooks.mjs crash-child.ts <dir> <point> <calls>
import { json, pageServer } from "./page-server";
import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import dns from "node:dns/promises";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import {
  SYNTHETIC_OWNER_KEY,
  fakeChain,
  fakeHttps,
  fakeLookup,
  lifiAnswer,
} from "./fake-chain";
import { NOW, SYN, fakeWallet } from "../g14-protected-proposal/synthetic";

const [dir, point, calls] = process.argv.slice(2);
// The fixture quote is dated: the child's clock runs from the fixture time (a test-only process).
const offset = NOW - Date.now();
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + offset;
(dns as unknown as { lookup: unknown }).lookup = fakeLookup;
(https as unknown as { request: unknown }).request = fakeHttps(lifiAnswer);
syncBuiltinESMExports();
const chain = fakeChain({ owner: SYN, now: () => Date.now() });
// G14 follow-up F2: the page fetch (captured by the adapter at load) stays the page-server delegator; every other
// URL — the four pool operators — goes to the fake chain.
pageServer.next = chain.fetch as typeof fetch;
const log = (method: string) => {
  const fd = openSync(calls, "a");
  appendFileSync(fd, JSON.stringify({ at: Date.now(), method }) + "\n");
  fsyncSync(fd);
  closeSync(fd);
};
const die = () => process.kill(process.pid, "SIGKILL");
appendFileSync(calls, "");

const { openCanaryRuntime } =
  await import("../../../src/execution/server/canary/runtime");
const { WalletProviderAdapter } =
  await import("../../../src/features/wallet/adapter");
const { submitCanary } =
  await import("../../../src/features/bridge/submission");

if (point === "hold") {
  try {
    openCanaryRuntime({ dir });
    console.log("HOLD_OK");
    await new Promise((r) => setTimeout(r, 4000));
    process.exit(0);
  } catch (e) {
    console.log((e as { code?: string }).code ?? String(e));
    process.exit(0);
  }
}
const rt = openCanaryRuntime({ dir });
if (point === "recover") {
  // Recovery only reads the store and the (fake) chain; no wallet object even exists in this run, so nothing can be
  // asked again. The wallet-call log is compared before / after to prove it.
  const { readFileSync } = await import("node:fs");
  const lines = () =>
    readFileSync(calls, "utf8").split(/\r?\n/).filter(Boolean).length;
  const before = lines();
  const report = rt.recovery();
  const rec = report.records[0];
  console.log(
    JSON.stringify({
      store: report.store.status,
      restoreProblem: report.restoreProblem,
      state: rec?.state,
      attempts: rec?.attempts.map((a) => a.recovery),
      needsAttention: rec?.needsAttention,
      secondRunSends: lines() - before,
    }),
  );
  rt.close();
  process.exit(0);
}
const review = await rt.review(
  {
    account: SYN,
    chainId: "8453",
    amount: "5000000",
    ownerKey: SYNTHETIC_OWNER_KEY,
  },
  AbortSignal.timeout(30_000),
);
if (!review.ready) {
  console.log(
    "NOT_READY " +
      JSON.stringify(review.checks.filter((c) => c.status !== "PASS")),
  );
  process.exit(3);
}
const token = rt.authorize({
  session: review.session,
  record: review.record,
  trustedGesture: true,
});
const preparation = rt.prepare({
  session: review.session,
  record: review.record,
  token,
});
if (point === "before-reserve") die();
const p = fakeWallet({
  send: (params) => {
    log("eth_sendTransaction");
    if (point === "after-dispatch") die();
    return chain.submit((params as Record<string, string>[])[0]);
  },
});
const a = new WalletProviderAdapter(p, {
  address: SYN,
  chainId: 8453,
  epoch: 1,
});
const write = async (kind: string, ref: unknown, hash?: string) => {
  const r = await rt.write({
    session: review.session,
    kind: kind as never,
    ref: ref as never,
    ...(hash ? { hash } : {}),
  });
  if (kind === "requested" && point === "after-reserve") die();
  return r.ok;
};
// G14 follow-up F2: the adapter's own server calls (confirmation, durable "requested") reach this process's runtime.
pageServer.handler = async (body) => {
  if (body.action === "canary-confirm")
    return json({
      preparation: rt.confirm({
        session: body.session as string,
        record: body.record as string,
        action: body.step as never,
        review: body.review as string,
        attempt: body.attempt as string,
        digest: body.digest as string,
      }),
      serverNow: Date.now(),
    });
  if (body.action === "canary-record" && body.kind === "requested") {
    const r = await rt.write({
      session: review.session,
      kind: "requested",
      ref: body.ref as never,
    });
    if (point === "after-reserve") die();
    return json(r);
  }
  return json({ error: "INVALID_REQUEST" }, 422);
};
await submitCanary(a, preparation as never, {
  session: review.session,
  gesture: { trusted: true, at: Date.now() },
  persistNotRequested: (ref) => write("not-requested", ref),
  persistHash: async (h, _a, ref) => {
    await write("hash", ref, h);
    if (point === "after-hash") die();
  },
  persistLateHash: async (h, _a, ref) =>
    void (await write("late-hash", ref, h)),
  persistRejected: async (ref) => void (await write("rejected", ref)),
});
die();
