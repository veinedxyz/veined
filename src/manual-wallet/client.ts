"use client";
import type { WalletProviderAdapter } from "../features/wallet/adapter";
import {
  MANUAL_API,
  manualTx,
  sameManualTx,
  type ManualPreparation,
  type ManualLane,
} from "./protocol";

const nativeFetch =
  typeof window !== "undefined" ? window.fetch.bind(window) : null;
let csrf = "";
export async function manualApi(body: Record<string, unknown>) {
  if (!nativeFetch) throw Error("MANUAL_BROWSER_REQUIRED");
  if (!csrf) {
    const res = await nativeFetch(MANUAL_API, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
    if (!res.ok) throw Error("MANUAL_SESSION_REQUIRED");
    csrf = (await res.json()).csrf;
  }
  const res = await nativeFetch(MANUAL_API, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-manual-csrf": csrf },
    body: JSON.stringify(body),
  });
  const answer = await res.json();
  if (!res.ok) throw Error(answer.error ?? "MANUAL_REQUEST_FAILED");
  return answer;
}
export function resetManualSession() {
  csrf = "";
}
type Grant = {
  adapter: WalletProviderAdapter;
  epoch: number;
  preparation: ManualPreparation;
  authority: string;
  deadline: number;
  current: () => boolean;
};
const manualAuthorities = new WeakMap<object, Grant>();
export async function manualAuthority(
  adapter: WalletProviderAdapter,
  lane: ManualLane,
  preparation: ManualPreparation,
  current: () => boolean,
) {
  if (adapter.revoked || !current()) throw Error("WALLET_SESSION_STALE");
  const live = await adapter.identity();
  if (
    live.chainId !== 8453 ||
    live.account.toLowerCase() !== preparation.transaction.from
  )
    throw Error("WALLET_IDENTITY_CHANGED");
  const started = performance.now();
  const { preparation: reply } = await manualApi({
    action: "claim",
    lane,
    account: live.account,
    chainId: 8453,
    id: preparation.id,
  });
  const tx = manualTx(reply.transaction);
  const left =
    Math.min(10_000, reply.expiresAt - reply.serverTime) -
    (performance.now() - started);
  if (
    !sameManualTx(tx, preparation.transaction) ||
    reply.id !== preparation.id ||
    reply.reviewId !== preparation.reviewId ||
    reply.step !== preparation.step ||
    reply.lane !== lane ||
    !/^[0-9a-f]{64}$/.test(reply.authority) ||
    !Number.isFinite(left) ||
    left <= 0 ||
    adapter.revoked ||
    !current()
  )
    throw Error("MANUAL_AUTHORITY_INVALID");
  const authority = Object.freeze(Object.create(null));
  manualAuthorities.set(authority, {
    adapter,
    epoch: adapter.epoch,
    preparation: Object.freeze({ ...preparation, transaction: tx }),
    authority: reply.authority,
    deadline: performance.now() + left,
    current,
  });
  return authority;
}
// Consuming cannot mint a grant. Only a successful same-origin durable claim creates one, once.
export function takeManualAuthority(
  authority: unknown,
  adapter: WalletProviderAdapter,
) {
  const g =
    authority && typeof authority === "object"
      ? manualAuthorities.get(authority)
      : undefined;
  if (authority && typeof authority === "object")
    manualAuthorities.delete(authority);
  if (!g || g.adapter !== adapter || g.epoch !== adapter.epoch)
    throw Error("MANUAL_AUTHORITY_UNKNOWN_OR_USED");
  const check = () => {
    if (
      adapter.revoked ||
      adapter.epoch !== g.epoch ||
      !g.current() ||
      performance.now() >= g.deadline
    )
      throw Error("MANUAL_AUTHORITY_STALE");
  };
  check();
  return { ...g, check };
}
export async function reportManualResult(
  grant: { preparation: ManualPreparation; authority: string },
  outcome: "SENT" | "REFUSED" | "UNCERTAIN",
  hash: string | null,
) {
  return manualApi({
    action: "result",
    lane: grant.preparation.lane,
    account: grant.preparation.transaction.from,
    chainId: 8453,
    id: grant.authority,
    outcome,
    hash,
  });
}
