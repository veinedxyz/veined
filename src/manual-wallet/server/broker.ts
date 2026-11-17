import { randomBytes } from "node:crypto";
import {
  manualTx,
  sameManualTx,
  type ManualPreparation,
  type ManualTx,
} from "../protocol";
import type { LaneSignerResult } from "../../swap/lane/signer-adapter";

// The existing engine commits NONCE + USE + PREPARED before calling handoff(). No RPC write exists here.
// An unfinished handoff survives as REQUESTED in the durable account ledger and blocks all subsequent sends.
export class ManualBroker {
  readonly id = randomBytes(32).toString("hex");
  #resolve: ((r: LaneSignerResult) => void) | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #claimed = false;
  #finished = false;
  #handed = false;
  get handed() {
    return this.#handed;
  }
  #capture!: (tx: ManualTx) => void;
  #failure!: (e: unknown) => void;
  readonly captured = new Promise<ManualTx>((resolve, reject) => {
    this.#capture = resolve;
    this.#failure = reject;
  });
  constructor(
    readonly preparation: ManualPreparation,
    readonly append: (type: string, data: Record<string, unknown>) => void,
    readonly now = Date.now,
  ) {}
  claim(released: boolean) {
    if (!released) throw Error("OWNER_RELEASE_REQUIRED");
    if (this.#claimed || this.#finished) throw Error("MANUAL_AUTHORITY_USED");
    if (this.now() >= this.preparation.expiresAt) throw Error("REVIEW_EXPIRED");
    this.#claimed = true;
    try {
      this.append("REQUESTED", {
        id: this.id,
        lane: this.preparation.lane,
        step: this.preparation.step,
        expiresAt: this.preparation.expiresAt,
        requestedAt: this.now(),
      });
    } catch (e) {
      this.#finished = true;
      throw e;
    }
  }
  handoff(value: unknown): Promise<LaneSignerResult> {
    if (!this.#claimed || this.#resolve || this.#finished)
      throw Error("MANUAL_HANDOFF_INVALID");
    const tx = manualTx(value);
    if (
      !sameManualTx(tx, this.preparation.transaction) ||
      this.now() >= this.preparation.expiresAt
    )
      throw Error("MANUAL_PREPARATION_CHANGED");
    return new Promise((resolve) => {
      this.#handed = true;
      this.#resolve = resolve;
      this.#timer = setTimeout(() => {
        try {
          this.finish("UNCERTAIN", null);
        } catch {
          this.#finished = true;
          resolve({
            outcome: "UNCERTAIN",
            hash: null,
            problems: ["MANUAL_LEDGER_UNAVAILABLE"],
          });
        }
      }, 180_000);
      this.#timer.unref?.();
      this.#capture(tx);
    });
  }
  fail(e: unknown) {
    this.#failure(e);
  }
  finish(outcome: "SENT" | "REFUSED" | "UNCERTAIN", hash: string | null) {
    if (this.#finished || !this.#resolve)
      throw Error("MANUAL_RESULT_ALREADY_USED");
    if (
      outcome === "SENT" &&
      (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
    ) {
      outcome = "UNCERTAIN";
      hash = null;
    }
    if (outcome !== "SENT") hash = null;
    // Commit before resolving the engine's dispatch. A failed write leaves REQUESTED unresolved (fail closed).
    this.append("RESULT", {
      id: this.id,
      lane: this.preparation.lane,
      step: this.preparation.step,
      outcome,
      hash,
      submittedAt: this.now(),
    });
    this.#finished = true;
    clearTimeout(this.#timer);
    this.#resolve({
      outcome,
      hash,
      problems:
        outcome === "UNCERTAIN"
          ? ["WALLET_RESULT_UNKNOWN"]
          : outcome === "REFUSED"
            ? ["WALLET_REJECTED"]
            : [],
    });
  }
}
