import { BridgeError, addressSchema } from "../../core/model";
export interface Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (value: unknown) => void): void;
  removeListener?(event: string, fn: (value: unknown) => void): void;
}
export interface Wallet {
  id: string;
  name: string;
  provider: Provider;
}
export function discover(onWallet: (wallet: Wallet) => void): () => void {
  const seen = new Set<Provider>();
  const handle = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (
      !detail?.provider?.request ||
      typeof detail.info?.uuid !== "string" ||
      typeof detail.info?.name !== "string" ||
      seen.has(detail.provider)
    )
      return;
    seen.add(detail.provider);
    onWallet({
      id: detail.info.uuid.slice(0, 100),
      name: detail.info.name.slice(0, 60),
      provider: detail.provider,
    });
  };
  window.addEventListener("eip6963:announceProvider", handle);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const legacy = (window as Window & { ethereum?: Provider }).ethereum;
  if (legacy && !seen.has(legacy))
    onWallet({ id: "legacy", name: "Injected wallet", provider: legacy });
  return () => window.removeEventListener("eip6963:announceProvider", handle);
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
export async function connect(provider: Provider, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const announced: string[] = [];
  let account: string | undefined;
  const changed = (value: unknown) => {
    const first = Array.isArray(value) && addressSchema.safeParse(value[0]);
    if (!first || !first.success) return abort();
    announced.push(first.data.toLowerCase());
    if (account && first.data.toLowerCase() !== account.toLowerCase()) abort();
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  provider.on?.("accountsChanged", changed);
  provider.on?.("chainChanged", abort);
  provider.on?.("disconnect", abort);
  try {
    const accounts = await requestOnce(
      provider,
      "eth_requestAccounts",
      undefined,
      20000,
      controller.signal,
    );
    if (!Array.isArray(accounts) || !accounts[0])
      throw new BridgeError("WALLET_LOCKED");
    account = addressSchema.parse(accounts[0]);
    if (announced.some((value) => value !== account!.toLowerCase())) abort();
    // A matching permission-grant event is expected. Bind the granted account to
    // bounded current reads; a competing event, chain change or disconnect aborts.
    const [current, chain] = await Promise.all([
      readWallet(provider, "eth_accounts", controller.signal),
      readWallet(provider, "eth_chainId", controller.signal),
    ]);
    if (
      controller.signal.aborted ||
      !Array.isArray(current) ||
      !addressSchema.safeParse(current[0]).success ||
      current[0].toLowerCase() !== account.toLowerCase()
    )
      throw new BridgeError("IDENTITY_CHANGED");
    return { account, chain: parseChain(chain) };
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
