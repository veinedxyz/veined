// Server-only NEAR mainnet account check (JSON-RPC `query` / `view_account`, finality final). Read-only: one view per
// account, fixed endpoint, 2.5 s timeout, bounded streaming body. NEAR's account validation guidance: block named
// accounts that do not exist, warn on implicit accounts that were never funded. When the lookup was attempted but the
// RPC could not answer (timeout, HTTP error, malformed body), Guardian says so (CAUTION, "could not verify") instead of
// staying silent. VEINED_GUARDIAN_ONCHAIN=off disables the lookup entirely (offline runs): no request, no finding.
import { finding, type Finding } from "../model";
import { nearAccountKind, validNearAccount } from "../near";
import { readBounded } from "./bounded";

export const NEAR_RPC = "https://rpc.mainnet.fastnear.com";
export type NearAccountState =
  "ACCOUNT" | "CONTRACT" | "MISSING" | "UNAVAILABLE" | "SKIPPED";
const EMPTY_CODE = "11111111111111111111111111111111";
export const onchainEnabled = () =>
  process.env.VEINED_GUARDIAN_ONCHAIN !== "off";

export async function nearAccountState(
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<NearAccountState> {
  if (!onchainEnabled() || !validNearAccount(id)) return "SKIPPED";
  try {
    const r = await fetcher(NEAR_RPC, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "guardian",
        method: "query",
        params: {
          request_type: "view_account",
          finality: "final",
          account_id: id,
        },
      }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    const body = JSON.parse(await readBounded(r, 16_000)) as {
      result?: { code_hash?: unknown };
      error?: { cause?: { name?: unknown } };
    };
    if (body.error?.cause?.name === "UNKNOWN_ACCOUNT") return "MISSING";
    if (typeof body.result?.code_hash === "string")
      return body.result.code_hash === EMPTY_CODE ? "ACCOUNT" : "CONTRACT";
    return "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}
const show = (id: string) =>
  id.length > 24 ? `${id.slice(0, 10)}…${id.slice(-8)}` : id;
/** On-chain evidence for accounts that would receive value. */
export async function onchainFindings(
  ids: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<Finding[]> {
  const unique = [...new Set(ids.filter(validNearAccount))].slice(0, 4);
  const states = await Promise.all(
    unique.map((id) => nearAccountState(id, fetcher)),
  );
  return unique.flatMap((id, i) => {
    const s = states[i];
    if (s === "SKIPPED") return [];
    if (s === "UNAVAILABLE")
      return [
        finding("NEAR_ACCOUNT_UNVERIFIED", "CAUTION", "ACCOUNT", {
          account: show(id),
        }),
      ];
    if (s === "MISSING")
      return nearAccountKind(id) === "implicit" ||
        nearAccountKind(id) === "eth-implicit"
        ? [
            finding("NEAR_ACCOUNT_UNFUNDED", "CAUTION", "ACCOUNT", {
              account: show(id),
            }),
          ]
        : [
            finding("NEAR_ACCOUNT_MISSING", "CRITICAL", "ACCOUNT", {
              account: show(id),
            }),
          ];
    return [
      finding("NEAR_ACCOUNT_ONCHAIN", "PASS", "ACCOUNT", {
        account: show(id),
      }),
    ];
  });
}
