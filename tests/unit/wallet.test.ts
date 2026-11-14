import { expect, it, vi } from "vitest";
import {
  bindExternalWallet,
  requestOnce,
} from "../../src/features/wallet/provider";
import { submit } from "../../src/features/bridge/submission";
import { prepare } from "../../src/adapters/onebridge";
import { NATIVE } from "../../src/core/model";
import { localQuote } from "../fixtures/local";
it.each([
  "grant",
  "competing-account",
  "snapshot-mismatch",
  "chain-change",
  "disconnect",
])(
  "C1 identity binding event ordering (V1.9: after Privy reports the chosen wallet): %s",
  async (scenario) => {
    const account = "0x3333333333333333333333333333333333333333";
    const other = "0x4444444444444444444444444444444444444444";
    const listeners = new Map<string, (value: unknown) => void>();
    const provider = {
      on: (event: string, fn: (v: unknown) => void) => {
        listeners.set(event, fn);
      },
      removeListener: (event: string) => {
        listeners.delete(event);
      },
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_accounts") {
          // Events race with the bounded identity reads.
          listeners.get("accountsChanged")?.([
            scenario === "competing-account" ? other : account,
          ]);
          if (scenario === "chain-change")
            listeners.get("chainChanged")?.("0x38");
          if (scenario === "disconnect")
            listeners.get("disconnect")?.({ code: 4900 });
          return [scenario === "snapshot-mismatch" ? other : account];
        }
        if (method === "eth_chainId") return "0x956d7";
        throw Error("UNEXPECTED_WALLET_METHOD");
      }),
    };
    if (scenario === "grant")
      await expect(bindExternalWallet(provider, account)).resolves.toEqual({
        account,
        chain: 612055,
      });
    else
      await expect(bindExternalWallet(provider, account)).rejects.toThrow(
        "IDENTITY_CHANGED",
      );
    expect(listeners.size).toBe(0);
    expect(
      provider.request.mock.calls.every(
        ([args]) => !/send|sign|request/i.test(args.method),
      ),
    ).toBe(true);
  },
);
it("W04 timeout keeps pending lock until wallet operation actually settles", async () => {
  let resolve!: (value: unknown) => void;
  const provider = {
    request: vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
  };
  await expect(
    requestOnce(provider, "eth_requestAccounts", undefined, 10),
  ).rejects.toThrow("WALLET_REQUEST_PENDING");
  await expect(requestOnce(provider, "eth_requestAccounts")).rejects.toThrow(
    "WALLET_REQUEST_PENDING",
  );
  expect(provider.request).toHaveBeenCalledTimes(1);
  resolve([]);
  await Promise.resolve();
});
it("W02 a provider error or a locked account during binding does not become connected", async () => {
  const account = "0x3333333333333333333333333333333333333333";
  await expect(
    bindExternalWallet(
      {
        request: async () => {
          throw { code: 4001 };
        },
      },
      account,
    ),
  ).rejects.toEqual({ code: 4001 });
  await expect(
    bindExternalWallet(
      {
        request: async ({ method }) => (method === "eth_chainId" ? "0x1" : []),
      },
      account,
    ),
  ).rejects.toThrow("IDENTITY_CHANGED");
});
it("S01 flags do not bypass local mode or unverified deployment", async () => {
  const quote = localQuote("0x3333333333333333333333333333333333333333", "1");
  const d = {
    mode: "local-test" as const,
    source: "0x1111111111111111111111111111111111111111",
    destination: "0x2222222222222222222222222222222222222222",
    verified: true,
    nativeSentinel: NATIVE,
    sourceChain: 31337,
    destinationChain: 31338,
    config: "1",
  };
  const provider = {
    identity: vi.fn(),
    sendCanonicalTransaction: vi.fn(),
  };
  for (const enabled of [false, true])
    await expect(
      submit(provider, prepare(quote, d), quote, d, {
        enabled,
        releaseApproved: true,
        revalidate: async () => {},
        persistUnknown: () => {},
        persistHash: () => {},
        persistRejected: () => {},
      }),
    ).rejects.toThrow("MAINNET_WRITE_DISABLED");
  expect(provider.sendCanonicalTransaction).not.toHaveBeenCalled();
  expect(provider.identity).not.toHaveBeenCalled();
});
it("R1/C mainnet quote and claimed verified deployment cannot bypass null write registry", async () => {
  const local = localQuote("0x3333333333333333333333333333333333333333", "12");
  const quote = {
    ...local,
    mode: "mainnet-readonly" as const,
    sourceChain: 612055,
    destinationChain: 56,
  };
  const d = {
    mode: "mainnet-readonly" as const,
    source: "0x1111111111111111111111111111111111111111",
    destination: "0x2222222222222222222222222222222222222222",
    verified: true,
    nativeSentinel: NATIVE,
    sourceChain: 612055,
    destinationChain: 56,
    config: "1",
  };
  const provider = {
    identity: vi.fn(),
    sendCanonicalTransaction: vi.fn(),
  };
  const revalidate = vi.fn();
  await expect(
    submit(
      provider,
      {
        account: quote.account,
        chainId: 612055,
        to: d.source,
        data: "0x",
        value: quote.amount,
      },
      quote,
      d,
      {
        enabled: true,
        releaseApproved: true,
        revalidate,
        persistUnknown: vi.fn(),
        persistHash: vi.fn(),
        persistRejected: vi.fn(),
      },
    ),
  ).rejects.toThrow("MAINNET_WRITE_DISABLED");
  expect(provider.sendCanonicalTransaction).not.toHaveBeenCalled();
  expect(provider.identity).not.toHaveBeenCalled();
  expect(revalidate).not.toHaveBeenCalled();
});
