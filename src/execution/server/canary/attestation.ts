// G14 Track A (G13 limit §5-6 / review N5, canary path): review artefacts MACed by THIS server process. The preflight
// report, the Guardian verdict and the canary check list are computed on the server and MACed with a key that exists
// only in this process; the canary engine accepts a PREFLIGHT / GUARDIAN step only with an attestation it can verify.
// What this gives (round-1 review F12, stated precisely): integrity between the server's review and its start inside
// one process — a client cannot substitute a report, a verdict or a "ready" claim through the engine. It is NOT an
// external proof of authenticity (the same process makes and checks it), and the lifecycle's own recomputation
// (lifecycle.ts, PREFLIGHT) only proves the claim matches the attached report, not who wrote the report.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson, digest } from "../../canonical";

export type AttestedKind = "PREFLIGHT" | "GUARDIAN" | "CANARY_CHECKS";
export interface Attestation {
  kind: AttestedKind;
  record: string;
  plan: string;
  /** sha256 of the canonical payload. */
  digest: string;
  at: number;
  mac: string;
}
export class ReviewAttestor {
  readonly #key = randomBytes(32);
  #mac(a: Omit<Attestation, "mac">) {
    return createHmac("sha256", this.#key)
      .update(
        canonicalJson([
          "veined.canary.attestation.v1",
          a.kind,
          a.record,
          a.plan,
          a.digest,
          a.at,
        ]),
      )
      .digest("hex");
  }
  attest(
    kind: AttestedKind,
    record: string,
    plan: string,
    payload: unknown,
    at: number,
  ): Attestation {
    const body = { kind, record, plan, digest: digest(payload), at };
    return Object.freeze({ ...body, mac: this.#mac(body) });
  }
  /** True only for an attestation this process made, for exactly this kind, record, plan and payload. */
  verify(
    a: unknown,
    kind: AttestedKind,
    record: string,
    plan: string,
    payload: unknown,
  ): boolean {
    if (!a || typeof a !== "object") return false;
    const x = a as Record<string, unknown>;
    if (
      x.kind !== kind ||
      x.record !== record ||
      x.plan !== plan ||
      typeof x.mac !== "string" ||
      !/^[0-9a-f]{64}$/.test(x.mac) ||
      !Number.isSafeInteger(x.at)
    )
      return false;
    let d: string;
    try {
      d = digest(payload);
    } catch {
      return false;
    }
    if (x.digest !== d) return false;
    const want = Buffer.from(
      this.#mac({ kind, record, plan, digest: d, at: x.at as number }),
      "hex",
    );
    return timingSafeEqual(want, Buffer.from(x.mac, "hex"));
  }
}
