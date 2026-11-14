import { BridgeError, addressSchema } from "../../core/model";
export interface Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (value: unknown) => void): void;
  removeListener?(event: string, fn: (value: unknown) => void): void;
}
const pending = new WeakSet<Provider>();
async function boundedWalletResult(
  operation: Promise<unknown>,
  timeout: number,
  timeoutCode: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BridgeError(timeoutCode)), timeout);
        abort = () => reject(new BridgeError("IDENTITY_CHANGED"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
export function readWallet(
  provider: Provider,
  method: "eth_accounts" | "eth_chainId",
  signal?: AbortSignal,
  timeout = 8000,
) {
  return boundedWalletResult(
    Promise.resolve().then(() => provider.request({ method })),
    timeout,
    "WALLET_READ_TIMEOUT",
    signal,
  );
}
export async function requestOnce(
  provider: Provider,
  method: string,
  params?: unknown[],
  timeout = 20000,
  signal?: AbortSignal,
): Promise<unknown> {
  if (pending.has(provider)) throw new BridgeError("WALLET_REQUEST_PENDING");
  pending.add(provider);
  const operation = Promise.resolve()
    .then(() => provider.request({ method, params }))
    .finally(() => pending.delete(provider));
  return boundedWalletResult(
    operation,
    timeout,
    "WALLET_REQUEST_PENDING",
    signal,
  );
}
// V1.9: wallets are discovered and connected only by the Privy external-wallet layer (connect-only). After Privy
// reports the user's explicitly chosen wallet, its identity is bound to bounded live reads; a competing account
// event, a chain change or a disconnect during the bind aborts it (the C1 permission-grant ordering, kept).
// There is no raw injected-provider discovery and no account-permission request anywhere in the application.
export async function bindExternalWallet(
  provider: Provider,
  expected: string,
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const changed = (value: unknown) => {
    const first = Array.isArray(value) && addressSchema.safeParse(value[0]);
    if (
      !first ||
      !first.success ||
      first.data.toLowerCase() !== expected.toLowerCase()
    )
      abort();
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  provider.on?.("accountsChanged", changed);
  provider.on?.("chainChanged", abort);
  provider.on?.("disconnect", abort);
  try {
    if (!addressSchema.safeParse(expected).success)
      throw new BridgeError("WALLET_NOT_EVM");
    const [current, chain] = await Promise.all([
      readWallet(provider, "eth_accounts", controller.signal),
      readWallet(provider, "eth_chainId", controller.signal),
    ]);
    if (
      controller.signal.aborted ||
      !Array.isArray(current) ||
      !addressSchema.safeParse(current[0]).success ||
      current[0].toLowerCase() !== expected.toLowerCase()
    )
      throw new BridgeError("IDENTITY_CHANGED");
    return { account: current[0] as string, chain: parseChain(chain) };
  } finally {
    signal?.removeEventListener("abort", abort);
    provider.removeListener?.("accountsChanged", changed);
    provider.removeListener?.("chainChanged", abort);
    provider.removeListener?.("disconnect", abort);
  }
}
export function parseChain(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-f]{1,8}$/i.test(value))
    throw new BridgeError("INVALID_CHAIN");
  return Number(BigInt(value));
}
export function errorCode(error: unknown): string {
  if (error instanceof BridgeError) return error.code;
  const code = (error as { code?: number })?.code;
  return code === 4001
    ? "USER_REJECTED"
    : code === 4900
      ? "WALLET_DISCONNECTED"
      : "PROVIDER_UNAVAILABLE";
}
