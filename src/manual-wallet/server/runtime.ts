import { measuredRead } from "./performance";
import { readFileSync } from "node:fs";
import { readJournal } from "../../execution/server/canary/durable-store";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { CanaryDurableStore } from "../../execution/server/canary/durable-store";
import { SwapLaneEngine, type LaneReview } from "../../swap/lane/engine";
import {
  BridgeLaneEngine,
  type BridgeLaneReview,
} from "../../swap/lane/bridge-engine";
import { openLaneStore } from "../../swap/lane/runtime";
import { openBridgeLaneStore } from "../../swap/lane/bridge-runtime";
import {
  SWAP_LANE_APPROVAL_VERSION,
  SWAP_LANE_KEY_DOMAIN,
  swapLaneGateState,
  swapLaneRecordProblems,
  type OwnerSwapLaneApproval,
} from "../../swap/lane/approval";
import {
  BRIDGE_LANE_APPROVAL_VERSION,
  BRIDGE_LANE_KEY_DOMAIN,
  bridgeLaneGateState,
  bridgeLaneRecordProblems,
  type OwnerBridgeLaneApproval,
} from "../../swap/lane/bridge-approval";
import { routeById } from "../../swap/lane/scope";
import { pinsOf } from "../../swap/lane/pins";
import { pairById, bridgeChainById } from "../../swap/lane/bridge-scope";
import {
  BRIDGE_LANE_PIN_SET,
  BRIDGE_LIFI_DIAMOND,
} from "../../swap/lane/bridge-pins";
import {
  laneReadBoth,
  bridgeReadBoth,
  bridgeLifiQuote,
} from "../../swap/lane/reads";
import { approveCalldata, swapCalldata } from "../../swap/lane/calldata";
import { bridgeApproveCalldata } from "../../swap/lane/bridge-calldata";
import type { LaneSignerStatus } from "../../swap/lane/signer-adapter";
import {
  MANUAL_ROUTES,
  manualTx,
  type ManualLane,
  type ManualPreparation,
} from "../protocol";
import { MANUAL_WALLET_RELEASED } from "../release";
import { ManualBroker } from "./broker";

const CANDIDATE = "D:/vnd/post-hackathon-20261117-01/candidate";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hex = (n: string) => "0x" + BigInt(n).toString(16);
const signal = () => AbortSignal.timeout(20_000);
type Review = LaneReview | BridgeLaneReview;
type RecordType = OwnerSwapLaneApproval | OwnerBridgeLaneApproval;
interface Flow {
  engine: SwapLaneEngine | BridgeLaneEngine;
  store: CanaryDurableStore;
  record: RecordType;
  credential: string;
  review?: Review;
  broker?: ManualBroker;
  dispatch?: Promise<unknown>;
  busy: boolean;
  preflighting: boolean;
  tracking?: Promise<Awaited<ReturnType<SwapLaneEngine["track"]>>>;
}
export class AccountRuntime {
  readonly flows = new Map<ManualLane, Flow>();
  readonly history = new Map<string, Flow>();
  readonly root: CanaryDurableStore;
  readonly firstNonce: string;
  constructor(
    readonly account: string,
    nonce: string,
    readonly directory = join(process.cwd(), ".manual-wallet"),
  ) {
    this.root = CanaryDurableStore.open(
      /* turbopackIgnore: true */ join(directory, account),
    );
    if (!this.root.writable) throw Error("MANUAL_STORE_NEEDS_ATTENTION");
    const bind = this.root.of("ACCOUNT_BIND");
    if (!bind.length)
      this.root.append("ACCOUNT_BIND", { account, firstNonce: nonce });
    const saved = this.root.of("ACCOUNT_BIND")[0].data as {
      account: string;
      firstNonce: string;
    };
    if (saved.account !== account) throw Error("MANUAL_ACCOUNT_BINDING");
    this.firstNonce = saved.firstNonce;
    if (this.root.of("MANUAL_RECORD").length > 128)
      throw Error("MANUAL_SESSION_ARCHIVE_LIMIT");
    for (const lane of ["SWAP", "BRIDGE"] as const) {
      for (const entry of this.root
        .of("MANUAL_RECORD")
        .filter((e) => (e.data as { lane: string }).lane === lane)) {
        const saved = entry.data as { record: RecordType; session?: string };
        this.createFlow(lane, saved.record, saved.session);
      }
    }
  }
  append(type: string, data: Record<string, unknown>) {
    this.root.append(type, data);
  }
  status(preflightLane?: ManualLane): LaneSignerStatus {
    const requested = this.root.of("REQUESTED").map(
      (e) =>
        e.data as {
          id: string;
          lane: ManualLane;
          step: string;
          recordId?: string;
        },
    );
    const results = this.root.of("RESULT").map(
      (e) =>
        e.data as {
          id: string;
          lane: ManualLane;
          step: string;
          outcome: string;
          hash: string | null;
        },
    );
    const unresolved = requested.filter(
      (r) =>
        !results.some((x) => x.id === r.id) &&
        !(
          preflightLane === r.lane &&
          this.flows.get(r.lane)?.preflighting &&
          this.flows.get(r.lane)?.broker?.id === r.id &&
          !this.flows.get(r.lane)?.broker?.handed
        ),
    );
    const sent = results.filter((r) => r.outcome === "SENT");
    const uncertain =
      unresolved.length +
      results.filter((r) => r.outcome === "UNCERTAIN").length;
    const pending = sent.filter((r) => {
      const request = requested.find((q) => q.id === r.id);
      const flow = request?.recordId
        ? this.history.get(request.recordId)
        : [...this.history.values()].find(
            (f) => f.record.route === MANUAL_ROUTES[r.lane],
          );
      return !flow?.store.of("RECEIPT").some((e) => {
        const receipt = e.data as { step: string; hash?: string };
        return receipt.step === r.step && receipt.hash === r.hash;
      });
    }).length;
    const signed = sent
      .filter((r) => {
        const request = requested.find((q) => q.id === r.id);
        const current = this.flows.get(r.lane);
        return (
          current &&
          (request?.recordId
            ? request.recordId === current.record.approvalId
            : [...this.history.values()].find(
                (f) => f.record.route === MANUAL_ROUTES[r.lane],
              ) === current)
        );
      })
      .map(
        (r) =>
          `${MANUAL_ROUTES[r.lane]}:${r.step === "SWAP" ? "EXECUTE" : r.step}`,
      );
    return {
      address: this.account,
      pinsSha256: sha("manual-wallet-lane-pins-v1"),
      sessionNotAfter: Date.now() + 600_000,
      enabledRoutes: Object.values(MANUAL_ROUTES),
      chains: {
        "8453": {
          firstNonce: BigInt(this.firstNonce),
          signedCount: sent.length,
          inFlight: pending,
          uncertain,
        },
      },
      signed,
      inFlight: pending,
      uncertain,
    };
  }
  flow(lane: ManualLane) {
    return this.flows.get(lane) ?? this.createFlow(lane);
  }
  async walletStatus(lane: ManualLane) {
    const status = this.status(lane);
    if (status.inFlight || status.uncertain) return status;
    const read = (tag: string) =>
      lane === "SWAP"
        ? laneReadBoth<string>(
            routeById(MANUAL_ROUTES.SWAP)!,
            "eth_getTransactionCount",
            [this.account, tag],
            this.account,
            signal(),
          )
        : bridgeReadBoth<string>(
            "8453",
            "eth_getTransactionCount",
            [this.account, tag],
            this.account,
            signal(),
          );
    const [latest, pending] = await Promise.all([
      read("latest"),
      read("pending"),
    ]);
    const expected =
      BigInt(this.firstNonce) + BigInt(status.chains["8453"].signedCount);
    if (
      !latest.agree ||
      !pending.agree ||
      [...latest.values, ...pending.values].some(
        (v) =>
          typeof v !== "string" ||
          !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v) ||
          BigInt(v) !== expected,
      )
    )
      throw Error("MANUAL_NONCE_CHANGED");
    return status;
  }
  createFlow(lane: ManualLane, saved?: RecordType, session?: string): Flow {
    if (!saved && this.history.size >= 128)
      throw Error("MANUAL_SESSION_ARCHIVE_LIMIT");
    const route = routeById(MANUAL_ROUTES.SWAP)!;
    const pair = pairById(MANUAL_ROUTES.BRIDGE)!;
    const now = Date.now();
    const common = {
      approvalId: "0x" + randomBytes(32).toString("hex"),
      account: this.account,
      firstNonce: this.firstNonce,
      notBefore: now - 1000,
      notAfter: now + 8 * 3600_000,
      singleUse: true as const,
      allowanceCleanup: "ZERO_REVOKE_ONLY" as const,
    };
    const record =
      saved ??
      (lane === "SWAP"
        ? {
            ...common,
            version: SWAP_LANE_APPROVAL_VERSION,
            route: route.id,
            scope: route.id,
            pinSet: pinsOf(route.id)!.set,
            chainId: "8453",
            tokenIn: route.pay.address,
            tokenOut: route.receive.address,
            router: route.router,
            exactAmount: "1000000",
            maxSlippageBps: 50,
            nativeGasBudgetWei: route.gasBudgetWei.toString(),
          }
        : {
            ...common,
            version: BRIDGE_LANE_APPROVAL_VERSION,
            route: pair.id,
            scope: pair.id,
            pinSet: BRIDGE_LANE_PIN_SET,
            sourceChainId: "8453",
            destinationChainId: "42161",
            sourceToken: bridgeChainById("8453")!.usdc.address,
            destinationToken: bridgeChainById("42161")!.usdc.address,
            spender: BRIDGE_LIFI_DIAMOND,
            exactAmount: "5000000",
            minimumOut: pair.minimumOut.toString(),
            maxCostBps: pair.maxCostBps,
            nativeGasBudgetWei: pair.gasBudgetWei.toString(),
          });
    const problems =
      lane === "SWAP"
        ? swapLaneRecordProblems(record)
        : bridgeLaneRecordProblems(record);
    if (
      problems.length ||
      record.account !== this.account ||
      record.route !== MANUAL_ROUTES[lane]
    )
      throw Error("MANUAL_RECORD_INVALID");
    if (session && session !== record.approvalId)
      throw Error("MANUAL_SESSION_BINDING");
    if (!saved)
      this.append("MANUAL_RECORD", {
        lane,
        record,
        ...(session ? { session } : {}),
      });
    // Internal lane credential, never a wallet key and never a transaction signer.
    const credential = sha(`manual-lane-credential:${record.approvalId}`);
    const domain =
      lane === "SWAP" ? SWAP_LANE_KEY_DOMAIN : BRIDGE_LANE_KEY_DOMAIN;
    const keyDigest = sha(`${domain}:${credential}`);
    const base = join(this.directory, this.account, lane.toLowerCase());
    const dir = session ? join(base, "sessions", session) : base;
    const store =
      lane === "SWAP"
        ? openLaneStore(dir, record)
        : openBridgeLaneStore(dir, record);
    const send = async (_authority: unknown, tx: unknown) => {
      const f = this.flows.get(lane)!;
      if (!f.broker) throw Error("MANUAL_BROKER_MISSING");
      f.preflighting = false;
      return f.broker.handoff(tx);
    };
    const engine =
      lane === "SWAP"
        ? new SwapLaneEngine({
            store,
            reuseExistingAllowance: true,
            record: record as OwnerSwapLaneApproval,
            keyDigest,
            chain: {
              both: (m, p, pick) =>
                measuredRead(`SWAP:${m}`, () =>
                  laneReadBoth(route, m, p, this.account, signal(), pick),
                ),
            },
            signer: { status: () => this.walletStatus(lane), send },
            gate: (f) =>
              swapLaneGateState(
                f,
                record as OwnerSwapLaneApproval,
                keyDigest,
                true,
              ),
          })
        : new BridgeLaneEngine({
            store,
            reuseExistingAllowance: true,
            record: record as OwnerBridgeLaneApproval,
            keyDigest,
            chains: {
              source: {
                both: (m, p, pick) =>
                  measuredRead(`BRIDGE:source:${m}`, () =>
                    bridgeReadBoth("8453", m, p, this.account, signal(), pick),
                  ),
              },
              destination: {
                both: (m, p, pick) =>
                  measuredRead(`BRIDGE:destination:${m}`, () =>
                    bridgeReadBoth("42161", m, p, this.account, signal(), pick),
                  ),
              },
              quote: () =>
                measuredRead("BRIDGE:quote", () =>
                  bridgeLifiQuote(pair, this.account, signal()),
                ),
            },
            signer: { status: () => this.walletStatus(lane), send },
            gate: (f) =>
              bridgeLaneGateState(
                f,
                record as OwnerBridgeLaneApproval,
                keyDigest,
                true,
              ),
          });
    const flow = {
      engine,
      store,
      record,
      credential,
      busy: false,
      preflighting: false,
    };
    this.flows.set(lane, flow);
    this.history.set(record.approvalId, flow);
    return flow;
  }
  async review(lane: ManualLane) {
    let f = this.flow(lane);
    if (f.busy || f.tracking) throw Error("MANUAL_OPERATION_PENDING");
    f.busy = true;
    try {
      const unusedExpired =
        Date.now() >= f.record.notAfter &&
        !this.root
          .of("REQUESTED")
          .some(
            (e) =>
              (e.data as { recordId?: string }).recordId ===
              f.record.approvalId,
          ) &&
        ![
          "AUTH",
          "USE",
          "NONCE",
          "PREPARED",
          "DISPATCH",
          "DISPATCH_DUPLICATE",
        ].some((type) => f.store.of(type).length);
      if (f.engine.nextStep() === null || unusedExpired) {
        if (this.status().inFlight || this.status().uncertain || f.tracking)
          throw Error("MANUAL_OPERATION_PENDING");
        if (!unusedExpired) {
          const terminal = await f.engine.track();
          if (
            terminal.state !== "SETTLED_VERIFIED" ||
            !terminal.allowance.agree
          )
            throw Error("MANUAL_SESSION_UNSETTLED");
        }
        // Re-read both operators and the cumulative account nonce before allocating a new record.
        const status = await this.walletStatus(lane);
        if (
          status.inFlight ||
          status.uncertain ||
          this.status().inFlight ||
          this.status().uncertain
        )
          throw Error("MANUAL_OPERATION_PENDING");
        if (this.history.size >= 128)
          throw Error("MANUAL_SESSION_ARCHIVE_LIMIT");
        const prior = f;
        // Persist a new immutable approvalId before opening its separate store. Prior authority remains archived.
        const record = {
          ...prior.record,
          approvalId: "0x" + randomBytes(32).toString("hex"),
          notBefore: Date.now() - 1000,
          notAfter: Date.now() + 8 * 3600_000,
        };
        this.append("MANUAL_RECORD", {
          lane,
          record,
          session: record.approvalId,
        });
        f = this.createFlow(lane, record, record.approvalId);
        f.busy = true;
        prior.busy = false;
      }
      if (this.status().inFlight) await f.engine.track();
      f.review = await f.engine.review(f.credential);
      return f.review;
    } finally {
      f.busy = false;
    }
  }
  prepare(lane: ManualLane, reviewId: unknown): ManualPreparation {
    const f = this.flow(lane),
      r = f.review;
    if (
      f.busy ||
      f.tracking ||
      this.status().uncertain ||
      this.status().inFlight
    )
      throw Error("MANUAL_OPERATION_PENDING");
    if (!r || r.reviewId !== reviewId || !r.ready || !r.step || !r.attestation)
      throw Error("REVIEW_NOT_READY");
    if (Date.now() >= r.expiresAt) throw Error("REVIEW_EXPIRED");
    const route = routeById(MANUAL_ROUTES.SWAP)!;
    const data =
      lane === "SWAP"
        ? r.step === "APPROVE"
          ? approveCalldata(route, 1_000_000n)
          : swapCalldata(route, {
              owner: this.account,
              amountIn: 1_000_000n,
              amountOutMinimum: BigInt((r as LaneReview).amountOutMinimum),
              deadline: BigInt((r as LaneReview).deadline),
            })
        : r.step === "APPROVE"
          ? bridgeApproveCalldata(5_000_000n)
          : (r as BridgeLaneReview).data!;
    const transaction = manualTx({
      chainId: "0x2105",
      from: this.account,
      to: (r.step === "APPROVE"
        ? route.pay.address
        : lane === "SWAP"
          ? route.router
          : BRIDGE_LIFI_DIAMOND
      ).toLowerCase(),
      value: "0x0",
      data,
      gas: hex(r.gas.limits[r.step]),
      maxFeePerGas: hex(r.gas.maxFeePerGas),
      maxPriorityFeePerGas: hex(r.gas.maxPriorityFeePerGas),
    });
    const preparation = {
      id: randomBytes(32).toString("hex"),
      lane,
      reviewId: r.reviewId,
      step: r.step,
      transaction,
      expiresAt: r.expiresAt,
      serverTime: Date.now(),
      released: MANUAL_WALLET_RELEASED,
    };
    f.broker = new ManualBroker(preparation, (t, d) =>
      this.append(t, { ...d, recordId: f.record.approvalId }),
    );
    return preparation;
  }
  async claim(lane: ManualLane, id: unknown) {
    const f = this.flow(lane),
      b = f.broker;
    if (!b || b.preparation.id !== id)
      throw Error("MANUAL_PREPARATION_UNKNOWN");
    if (f.busy) throw Error("MANUAL_OPERATION_PENDING");
    if (this.status().inFlight || this.status().uncertain)
      throw Error("MANUAL_ACCOUNT_NEEDS_RECONCILIATION");
    b.claim(MANUAL_WALLET_RELEASED);
    f.busy = true;
    f.preflighting = true;
    try {
      const token = f.engine.authorize(b.preparation.reviewId, f.credential);
      f.dispatch = f.engine
        .dispatch(token, f.credential)
        .then(
          (result) => {
            b.fail(Error("MANUAL_DISPATCH_COMPLETED"));
            return result;
          },
          (e) => {
            b.fail(e);
            throw e;
          },
        )
        .finally(() => {
          f.busy = false;
          f.preflighting = false;
        });
      // Observe rejection even if the browser disconnects while waiting for handoff.
      void f.dispatch.catch(() => {});
      const transaction = await b.captured;
      return {
        ...b.preparation,
        transaction,
        authority: b.id,
        serverTime: Date.now(),
      };
    } catch (e) {
      f.busy = false;
      f.preflighting = false;
      throw e;
    }
  }
  async result(lane: ManualLane, id: unknown, outcome: unknown, hash: unknown) {
    const f = this.flow(lane),
      b = f.broker;
    if (!b || b.id !== id) throw Error("MANUAL_AUTHORITY_UNKNOWN");
    if (!["SENT", "REFUSED", "UNCERTAIN"].includes(String(outcome)))
      throw Error("MANUAL_RESULT_INVALID");
    b.finish(
      outcome as "SENT" | "REFUSED" | "UNCERTAIN",
      typeof hash === "string" ? hash : null,
    );
    return await f.dispatch;
  }
  async track(lane: ManualLane, recordId?: string) {
    const f = recordId ? this.history.get(recordId) : this.flow(lane);
    if (!f || f.record.route !== MANUAL_ROUTES[lane])
      throw Error("MANUAL_SESSION_UNKNOWN");
    if (f.tracking) return f.tracking;
    if (f.busy) throw Error("MANUAL_OPERATION_PENDING");
    f.tracking = f.engine.track();
    try {
      return await f.tracking;
    } finally {
      f.tracking = undefined;
    }
  }
}
const globals = globalThis as typeof globalThis & {
  __manualAccounts?: Map<string, AccountRuntime>;
};
const accounts = (globals.__manualAccounts ??= new Map());
export async function manualAccount(account: unknown, chain: unknown) {
  if (
    process.cwd().replace(/\\/g, "/").toLowerCase() !== CANDIDATE.toLowerCase()
  )
    throw Error("MANUAL_CANDIDATE_ONLY");
  if (
    typeof account !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(account) ||
    /^0x0{40}$/i.test(account)
  )
    throw Error("WALLET_NOT_CONNECTED");
  if (chain !== 8453) throw Error("WALLET_CHAIN_MISMATCH");
  const address = account.toLowerCase();
  if (accounts.has(address)) return accounts.get(address)!;
  if (accounts.size >= 64) throw Error("MANUAL_ACCOUNT_LIMIT");
  const route = routeById(MANUAL_ROUTES.SWAP)!;
  const [n, pending] = await Promise.all(
    ["latest", "pending"].map((tag) =>
      measuredRead(`account:nonce:${tag}`, () =>
        laneReadBoth<string>(
          route,
          "eth_getTransactionCount",
          [address, tag],
          address,
          signal(),
        ),
      ),
    ),
  );
  if (
    !n.agree ||
    !pending.agree ||
    !n.values.every(
      (x) => typeof x === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(x),
    ) ||
    n.values[0] !== pending.values[0]
  )
    throw Error("MANUAL_NONCE_UNPROVEN");
  // Re-check after async reads: exactly one account runtime and writer in this process.
  if (accounts.has(address)) return accounts.get(address)!;
  if (accounts.size >= 64) throw Error("MANUAL_ACCOUNT_LIMIT");
  const runtime = new AccountRuntime(address, BigInt(n.values[0]!).toString());
  accounts.set(address, runtime);
  return runtime;
}

/** Restart-safe read-only recovery. It never claims, authorizes or dispatches. */
export async function trackSavedAccount(
  account: string,
  lane: string,
  requestId?: string,
): Promise<Record<string, unknown>> {
  if (
    !/^0x[0-9a-f]{40}$/.test(account) ||
    (lane !== "SWAP" && lane !== "BRIDGE")
  )
    throw Error("MANUAL_RECOVERY_INPUT");
  let runtime = accounts.get(account);
  if (!runtime) {
    if (accounts.size >= 64) throw Error("MANUAL_ACCOUNT_LIMIT");
    const data = readJournal(
      readFileSync(
        join(process.cwd(), ".manual-wallet", account, "journal.ndjson"),
      ),
    );
    if (data.status !== "READY") throw Error("MANUAL_STORE_NEEDS_ATTENTION");
    const bind = data.entries.find((e) => e.type === "ACCOUNT_BIND")?.data as
      { account: string; firstNonce: string } | undefined;
    if (!bind || bind.account !== account || !/^\d+$/.test(bind.firstNonce))
      throw Error("MANUAL_ACCOUNT_BINDING");
    runtime = new AccountRuntime(account, bind.firstNonce);
    accounts.set(account, runtime);
  }
  const request = requestId
    ? runtime.root
        .of("REQUESTED")
        .find((e: { data: Record<string, unknown> }) => e.data.id === requestId)
    : undefined;
  if (requestId && !request) throw Error("MANUAL_REQUEST_UNKNOWN");
  const requested = request?.data as
    { recordId?: string; lane?: string } | undefined;
  if (requested && requested.lane !== lane)
    throw Error("MANUAL_SESSION_BINDING");
  const recordId = requested
    ? (requested.recordId ??
      [...runtime.history.values()].find(
        (f) => f.record.route === MANUAL_ROUTES[lane],
      )?.record.approvalId)
    : undefined;
  if (requested && !recordId) throw Error("MANUAL_SESSION_UNKNOWN");
  return runtime.track(lane, recordId);
}
