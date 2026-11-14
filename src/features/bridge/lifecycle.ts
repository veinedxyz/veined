import {
  BridgeError,
  hashSchema,
  sameAddress,
  type TransferRecord,
  ROUTE,
  type Mode,
  recordSchema,
} from "../../core/model";
import { validateObservation } from "./observation";
import { readHistory } from "../../storage/history";
// Only this module's actual request catch can create a proof. Storage/import never
// restores it. Retry starts by revoking the old proof, so a later timeout blocks.
const rejectedInRuntime = new Map<string, number>();
function rejectionIdentity(record: TransferRecord) {
  const { state, error, updatedAt, ...identity } = record;
  void state;
  void error;
  void updatedAt;
  return JSON.stringify(
    Object.entries(identity)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [
        key,
        [
          "account",
          "recipient",
          "token",
          "sourceHash",
          "destinationHash",
        ].includes(key) && typeof value === "string"
          ? value.toLowerCase()
          : value,
      ]),
  );
}
function trustedRejection(record: TransferRecord, now: number) {
  const at = rejectedInRuntime.get(rejectionIdentity(record));
  return (
    !record.sourceHash &&
    record.error !== "IMPORTED_UNVERIFIED" &&
    at !== undefined &&
    now >= at &&
    now - at <= 30000
  );
}
export interface IntentNamespace {
  mode: Mode;
  route: string;
  config: string;
  sourceChain: number;
  destinationChain: number;
}
export const mainnetNamespace: IntentNamespace = {
  mode: "mainnet-readonly",
  route: ROUTE.id,
  config: ROUTE.version,
  sourceChain: ROUTE.sourceChain,
  destinationChain: ROUTE.destinationChain,
};
export function sameIntentNamespace(
  record: TransferRecord,
  account: string,
  namespace: IntentNamespace,
) {
  return (
    sameAddress(record.account, account) &&
    record.mode === namespace.mode &&
    record.route === namespace.route &&
    record.config === namespace.config &&
    record.sourceChain === namespace.sourceChain &&
    record.destinationChain === namespace.destinationChain
  );
}
export function intentLockKey(account: string, namespace: IntentNamespace) {
  return `otherbridge:${namespace.mode}:${namespace.route}:${namespace.config}:${namespace.sourceChain}:${namespace.destinationChain}:${account.toLowerCase()}`;
}
export function assertNoUnresolved(
  records: TransferRecord[],
  account: string,
  namespace: IntentNamespace = mainnetNamespace,
) {
  const terminal = new Set([
    "COMPLETED",
    "USER_REJECTED",
    "SOURCE_REVERTED",
    "SOURCE_CANCELLED",
  ]);
  if (
    records.some(
      (r) =>
        sameIntentNamespace(r, account, namespace) && !terminal.has(r.state),
    )
  )
    throw new BridgeError("DUPLICATE_INTENT");
}
export async function revalidateIntentHistory(
  claims: TransferRecord[],
  account: string,
  namespace: IntentNamespace,
  observe: (claim: TransferRecord) => Promise<unknown>,
  now: () => number = Date.now,
) {
  const fresh: TransferRecord[] = [];
  for (const claim of claims) {
    if (!sameIntentNamespace(claim, account, namespace)) {
      fresh.push(claim);
      continue;
    }
    // A missing hash cannot prove cancellation or rejection after a reload.
    if (!claim.sourceHash) {
      fresh.push(
        trustedRejection(claim, now())
          ? { ...claim, state: "USER_REJECTED", error: undefined }
          : {
              ...claim,
              state: "SUBMISSION_UNKNOWN",
              error: "MANUAL_ACTION_REQUIRED",
            },
      );
      continue;
    }
    try {
      fresh.push(
        validateObservation(claim, await observe(claim), now()).record,
      );
    } catch {
      fresh.push({ ...claim, state: "UNVERIFIED_COMPLETION" });
    }
  }
  assertNoUnresolved(fresh, account, namespace);
  return fresh;
}
export async function withVerifiedIntent<T>(
  account: string,
  namespace: IntentNamespace,
  observe: (claim: TransferRecord) => Promise<unknown>,
  action: (fresh: TransferRecord[]) => Promise<T>,
) {
  if (!navigator.locks) throw new BridgeError("LOCK_UNAVAILABLE");
  return navigator.locks.request(
    intentLockKey(account, namespace),
    { ifAvailable: true },
    async (lock) => {
      if (!lock) throw new BridgeError("DUPLICATE_INTENT");
      const history = readHistory();
      if (history.error) throw new BridgeError(history.error);
      const fresh = await revalidateIntentHistory(
        history.records,
        account,
        namespace,
        observe,
      );
      return action(fresh);
    },
  );
}
export async function recordSubmission(
  request: () => Promise<unknown>,
  persistence: {
    unknown: () => void | Promise<void>;
    hash: (hash: string) => void | Promise<void>;
    rejected: () => void | Promise<void>;
  },
  intent?: TransferRecord,
): Promise<string> {
  const snapshot = intent && recordSchema.parse(intent);
  const identity =
    snapshot && !snapshot.sourceHash ? rejectionIdentity(snapshot) : undefined;
  if (identity) rejectedInRuntime.delete(identity);
  await persistence.unknown();
  let result: unknown;
  try {
    result = await request();
  } catch (e) {
    if ((e as { code?: number })?.code === 4001) {
      await persistence.rejected();
      if (identity) {
        rejectedInRuntime.set(identity, Date.now());
        if (rejectedInRuntime.size > 100)
          rejectedInRuntime.delete(rejectedInRuntime.keys().next().value!);
      }
      throw new BridgeError("USER_REJECTED");
    }
    throw new BridgeError("SUBMISSION_UNKNOWN");
  }
  try {
    const hash = hashSchema.parse(result);
    await persistence.hash(hash);
    return hash;
  } catch {
    throw new BridgeError("SUBMISSION_UNKNOWN");
  }
}
