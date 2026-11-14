// The ONLY wallet write of the local product pilot: one send-transaction request, guarded twice here (in memory and
// in sessionStorage, so a reload never re-enables it) and released by the local server exactly once. Since V1.9 it
// goes through the single wallet adapter of the active Privy-connected external wallet: the adapter compares the
// server's canonical transaction with the reviewed wallet request field by field (chainId, from, to, value, data,
// gas, maxFeePerGas, maxPriorityFeePerGas), re-reads the live account and chain, refuses a revoked (stale) session
// and hands the frozen canonical values to the wallet. The wallet's own confirmation is the owner's.
import type { WalletProviderAdapter } from "../../../src/features/wallet/adapter";
import type { PilotTx } from "./verify";

const guard = { attempted: false };
export function sendAttempted(sessionId: string) {
  if (guard.attempted) return true;
  try {
    return sessionStorage.getItem("g7-product-send-attempted") === sessionId;
  } catch {
    return false;
  }
}
export function requestWalletConfirmationOnce(
  wallet: WalletProviderAdapter,
  canonical: PilotTx,
  reviewed: PilotTx,
  sessionId: string,
) {
  if (guard.attempted) throw new Error("SECOND_WALLET_REQUEST_REFUSED");
  guard.attempted = true;
  try {
    sessionStorage.setItem("g7-product-send-attempted", sessionId);
  } catch {
    // the in-memory guard and the server-side one-shot still hold
  }
  return wallet.sendCanonicalTransaction(
    { ...canonical },
    { ...reviewed },
    {
      gate: "g7-local-pilot",
    },
  );
}
