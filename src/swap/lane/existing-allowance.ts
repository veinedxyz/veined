// Optional manual-wallet policy: reuse a permission already on chain; never grant or enlarge one.
// Default lane compositions do not opt in. Every value is read again during the full attested review and preflight.
export interface AllowanceChain {
  both<T>(
    method: string,
    params: unknown[],
    pick?: (value: unknown) => unknown,
  ): Promise<{
    values: readonly (T | null)[];
    agree: boolean;
    errors: readonly string[];
  }>;
}
const quantity = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v);
export async function existingAllowance(
  chain: AllowanceChain,
  owner: string,
  token: string,
  spender: string,
): Promise<bigint> {
  const heads = await chain.both<string>("eth_blockNumber", [], () => null);
  if (
    heads.errors.length ||
    !heads.values.every(quantity) ||
    heads.values.length !== 2
  )
    throw Error("ALLOWANCE_HEAD_UNPROVEN");
  const a = BigInt(heads.values[0] as string),
    b = BigInt(heads.values[1] as string);
  if (a <= 1n || b <= 1n || (a > b ? a - b : b - a) > 20n)
    throw Error("ALLOWANCE_HEAD_UNPROVEN");
  const block = "0x" + ((a < b ? a : b) - 1n).toString(16);
  const data =
    "0xdd62ed3e" +
    owner.slice(2).toLowerCase().padStart(64, "0") +
    spender.slice(2).toLowerCase().padStart(64, "0");
  const r = await chain.both<string>("eth_call", [{ to: token, data }, block]);
  if (
    r.errors.length ||
    !r.agree ||
    r.values.length !== 2 ||
    !r.values.every(quantity) ||
    BigInt(r.values[0] as string) !== BigInt(r.values[1] as string)
  )
    throw Error("ALLOWANCE_UNPROVEN");
  return BigInt(r.values[0] as string);
}
