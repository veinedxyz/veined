import {
  CROSS,
  ROUTE,
  type Quote,
  type TransferRecord,
} from "../../src/core/model";
import { parseAmount } from "../../src/core/amounts";
export function localQuote(account: string, amount: string): Quote {
  const value = parseAmount(amount);
  return {
    id: crypto.randomUUID(),
    mode: "local-test",
    account,
    recipient: account,
    route: ROUTE.id,
    config: "1",
    sourceChain: 31337,
    destinationChain: 31338,
    token: CROSS,
    amount: value,
    networkFee: 10n ** 16n,
    serviceFee: value / 1000n,
    gasBudget: 10n ** 15n,
    expected: value,
    min: 10n ** 17n,
    max: 99n * 10n ** 18n,
    observedAt: Date.now(),
    expiresAt: Date.now() + 60000,
  };
}
export function localTrack(record: TransferRecord): TransferRecord {
  if (record.error === "IMPORTED_UNVERIFIED")
    return { ...record, state: "UNVERIFIED_COMPLETION" };
  const elapsed = Date.now() - record.updatedAt;
  const state =
    elapsed < 1200
      ? "SOURCE_CONFIRMING"
      : elapsed < 2400
        ? "SETTLEMENT_PENDING"
        : elapsed < 3600
          ? "DESTINATION_CONFIRMING"
          : "COMPLETED";
  return {
    ...record,
    state,
    destinationHash: state === "COMPLETED" ? `0x${"b".repeat(64)}` : undefined,
    index: "7",
    observedBlock: "42",
    blockHash: `0x${"c".repeat(64)}`,
  };
}
