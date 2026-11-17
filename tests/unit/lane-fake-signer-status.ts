// VEINED-MC1 (review MAJOR-1 / MINOR-1): TEST-ONLY. The status body of the restricted signer v5 (CONTRACT-v5.md: POST
// {method: "status"} after {method: "sync"}) as a fake signer would answer it, derived the way signer v5's journal
// summary derives it: every SENT or UNCERTAIN hand-off is a signature; a signature is decided once its receipt is
// buried by the chain's confirmations; an UNCERTAIN one stays uncertain until decided. The body is parsed by the REAL
// parser (src/swap/lane/signer-adapter.ts parseSignerStatus), so a malformed fake is refused like a malformed signer.
// Not a test file itself. SYNTHETIC_TEST_ONLY.
import {
  parseSignerStatus,
  type LaneSignerStatus,
} from "../../src/swap/lane/signer-adapter";

export interface FakeSignature {
  /** "<route>:<signer step>" (APPROVE | EXECUTE | REVOKE). */
  key: string;
  outcome: "SENT" | "REFUSED" | "UNCERTAIN";
  hash: string | null;
}
export interface FakeStatusOptions {
  address: string;
  routes: readonly string[];
  chainId: string;
  firstNonce: bigint;
  signatures: readonly FakeSignature[];
  /** Is this hash's receipt final (buried by the chain's confirmations)? */
  decided: (hash: string | null) => boolean;
  now: number;
  sessionMs?: number;
  /** Extra signatures of OTHER lanes / records on this chain (the signer is shared). */
  others?: readonly FakeSignature[];
}
export function fakeStatusBody(o: FakeStatusOptions): Record<string, unknown> {
  const all = [...(o.others ?? []), ...o.signatures];
  const signed = all.filter((s) => s.outcome !== "REFUSED");
  const open = signed.filter((s) => !o.decided(s.hash));
  const uncertain = open.filter((s) => s.outcome === "UNCERTAIN").length;
  return {
    address: o.address.toLowerCase(),
    pinsSha256: "f".repeat(64),
    sessionNotAfter: new Date(
      o.now + (o.sessionMs ?? 4 * 3_600_000),
    ).toISOString(),
    enabledRoutes: [...o.routes],
    chains: {
      [o.chainId]: {
        firstNonce: o.firstNonce.toString(),
        signedCount: signed.length,
        inFlight: open.length,
        uncertain,
      },
    },
    signed: Object.fromEntries(signed.map((s) => [s.key, true])),
    inFlight: open.length,
    uncertain,
  };
}
/** The parsed status, as laneSignerStatus would return it; throws like the adapter when the body is not the contract's. */
export function fakeStatus(raw: unknown): LaneSignerStatus {
  const s = parseSignerStatus(raw);
  if (!s)
    throw Object.assign(new Error("SIGNER_STATUS_UNAVAILABLE"), {
      code: "SIGNER_STATUS_UNAVAILABLE",
    });
  return s;
}
