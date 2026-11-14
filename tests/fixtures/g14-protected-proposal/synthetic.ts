// G14 protected proposal — SYNTHETIC_TEST_ONLY fixtures shared by the unit and integration suites.
// The account is the synthetic 0x3333…3333 (never the owner's), the "owner approval" below is a made-up record that
// exists only inside tests, and the wallet is an in-memory EIP-1193 double: nothing here signs, sends, or reaches a
// network, and no value is an owner-approved amount, minimum, budget or deadline.
import fx from "../g14-canary-across.json" with { type: "json" };
import type { OwnerCanaryApproval } from "../../../src/security/canary-approval";
import type { Eip1193Like } from "../../../src/features/wallet/adapter";
import { CANARY_PINS, type PinReads } from "../../../src/execution/canary/pins";
import type { SourceRead } from "../../../src/execution/canary/chain-reads";
import type { ExecutableQuote } from "../../../src/execution/canary/quote-verify";

export const SYN = "0x3333333333333333333333333333333333333333";
export const OTHER = "0x4444444444444444444444444444444444444444";
export const QUOTED_AT = Date.parse(fx.at);
export const NOW = QUOTED_AT + 1000;
export const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const SELECTOR = "0x1794958f";
export const BASE_A = "https://base-rpc.publicnode.com";
export const BASE_B = "https://mainnet.base.org";
export const ARB_A = "https://arbitrum-one-rpc.publicnode.com";
export const ARB_B = "https://arb1.arbitrum.io/rpc";

/** A made-up, well-formed record for tests: 5 USDC, minimum 4.90 USDC, a gas budget and a one-hour window. */
export const syntheticApproval = (
  over: Partial<Record<keyof OwnerCanaryApproval, unknown>> = {},
): OwnerCanaryApproval =>
  ({
    version: "veined.owner-canary-approval.v1",
    approvalId: "0x" + "5a".repeat(32),
    scope: "base-arbitrum-usdc-max5",
    pinSet: "g14-canary-pins.2026-11-12.2",
    account: SYN,
    sourceChainId: "8453",
    destinationChainId: "42161",
    token: USDC_BASE,
    destinationToken: USDC_ARB,
    target: DIAMOND,
    spender: DIAMOND,
    selector: SELECTOR,
    maxAmount: "5000000",
    exactAmount: "5000000",
    minimumOut: "4900000",
    nativeGasBudgetWei: "10000000000000",
    notBefore: QUOTED_AT - 60_000,
    notAfter: QUOTED_AT + 3_600_000,
    singleUse: true,
    allowanceCleanup: "SEPARATE_OWNER_APPROVAL",
    ...over,
  }) as OwnerCanaryApproval;

export const approveData = (spender = DIAMOND, amount = 5_000_000n) =>
  "0x095ea7b3" +
  spender.slice(2).toLowerCase().padStart(64, "0") +
  amount.toString(16).padStart(64, "0");

export const quote = (
  over: Partial<NonNullable<ExecutableQuote["transactionRequest"]>> = {},
  extra: Partial<ExecutableQuote> = {},
): ExecutableQuote => ({
  tool: fx.tool,
  quotedAt: QUOTED_AT,
  transactionRequest: { ...fx.transactionRequest, ...over },
  estimate: { ...fx.estimate },
  ...extra,
});
export const BLOCK = {
  number: "56427300",
  hash: "0x" + "a".repeat(64),
  timestamp: Math.floor(NOW / 1000),
};
export const pinReads = (
  origin = BASE_A,
  over: Partial<PinReads> = {},
): PinReads => ({
  origin,
  chainId: "8453",
  block: BLOCK,
  selector: CANARY_PINS.selector,
  diamondCodehash: fx.pins.diamondCodehash,
  facetForSelector: fx.pins.facet,
  facetCodehash: fx.pins.facetCodehash,
  facetSpokePool: fx.pins.proxies["8453"].spokePool,
  feeCollectorCodehash: CANARY_PINS.feeCollector.codehash,
  sourceSpokePool: {
    codehash: fx.pins.proxies["8453"].spokePoolProxyCodehash,
    implementation: fx.pins.proxies["8453"].spokePoolImplementation,
    implementationCodehash:
      fx.pins.proxies["8453"].spokePoolImplementationCodehash,
  },
  sourceUsdc: {
    codehash: CANARY_PINS.usdc["8453"].codehash,
    implementation: fx.pins.proxies["8453"].usdcImplementation,
    implementationCodehash: fx.pins.proxies["8453"].usdcImplementationCodehash,
    decimals: 6,
    symbol: "USDC",
  },
  ...over,
});
export const src = (
  origin: string,
  values: Record<string, string | null>,
  block: SourceRead["block"] = BLOCK,
  chainId = "8453",
): SourceRead => ({ origin, chainId, block, values });
/** The real eth_simulateV1 result of the fixture, with the approval call the engine adds when one is needed. */
export const simCalls = () => {
  const c = structuredClone(fx.simulationCalls);
  return [
    c[0],
    {
      status: "0x1",
      returnData: "0x" + "0".repeat(64),
      gasUsed: "0x5208",
      logs: [],
    },
    c[1],
    c[2],
    c[3],
    c[4],
  ];
};
export const FEES = {
  baseFeePerGas: "5000000",
  maxFeePerGas: "10000000",
  maxPriorityFeePerGas: "1000000",
};

export interface WalletCall {
  method: string;
  params: unknown;
}
/**
 * In-memory EIP-1193 wallet double. It records every request; `send` decides how the one financial request ends
 * (a hash by default). It never signs and has no key.
 */
export function fakeWallet(
  opts: {
    account?: string;
    chain?: string;
    send?: (params: unknown) => Promise<unknown> | unknown;
  } = {},
) {
  let account = opts.account ?? SYN;
  let chain = opts.chain ?? "0x2105";
  const calls: WalletCall[] = [];
  const provider: Eip1193Like & {
    calls: WalletCall[];
    set(next: { account?: string; chain?: string }): void;
    count(method: string): number;
  } = {
    calls,
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === "eth_accounts") return account ? [account] : [];
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") {
        chain = (params as { chainId: string }[])[0].chainId;
        return null;
      }
      if (method === "eth_sendTransaction")
        return opts.send ? opts.send(params) : `0x${"ab".repeat(32)}`;
      throw Object.assign(new Error(`unexpected ${method}`), { code: 4200 });
    },
    set(next) {
      if (next.account !== undefined) account = next.account;
      if (next.chain !== undefined) chain = next.chain;
    },
    count: (method) => calls.filter((c) => c.method === method).length,
  };
  return provider;
}
/** No signing, typed-data, raw-send or add-chain request may ever appear in a wallet call log. */
export const forbiddenWalletCalls = (calls: readonly WalletCall[]) =>
  calls.filter((c) =>
    /sign|sendRaw|addEthereumChain|requestPermissions|sendCalls/i.test(
      c.method,
    ),
  );
