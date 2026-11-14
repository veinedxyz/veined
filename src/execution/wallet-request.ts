// G13 (review F10): the canonical transaction in the exact shape the protected wallet adapter compares and sends
// (src/features/wallet/adapter.ts CANONICAL_TX_FIELDS; quantities as lowercase 0x-hex without leading zeros). Pure;
// it builds an object, it never calls a wallet. Refuses anything that is not a canonical decimal quantity.
import type { WalletTransaction } from "./model";

const DIGITS = /^(0|[1-9]\d{0,77})$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const hex = (decimal: string) => `0x${BigInt(decimal).toString(16)}`;

export function walletRequest(tx: WalletTransaction): Record<string, string> {
  const quantities = [
    tx.chainId,
    tx.value,
    tx.gas,
    tx.maxFeePerGas,
    tx.maxPriorityFeePerGas,
  ].filter((v): v is string => v !== undefined);
  if (
    !quantities.every((v) => DIGITS.test(v)) ||
    !ADDRESS.test(tx.from) ||
    !ADDRESS.test(tx.to) ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data)
  )
    throw new RangeError("WALLET_REQUEST_INVALID");
  return {
    chainId: hex(tx.chainId),
    from: tx.from,
    to: tx.to,
    value: hex(tx.value),
    data: tx.data,
    ...(tx.gas !== undefined ? { gas: hex(tx.gas) } : {}),
    ...(tx.maxFeePerGas !== undefined
      ? { maxFeePerGas: hex(tx.maxFeePerGas) }
      : {}),
    ...(tx.maxPriorityFeePerGas !== undefined
      ? { maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas) }
      : {}),
  };
}
