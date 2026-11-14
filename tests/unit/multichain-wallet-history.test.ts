import { it, expect, vi, afterEach } from "vitest";
import {
  boundedNativeConnect,
  connectNativeRead,
  readNativeIdentity,
} from "../../src/routing/wallet-read";
import {
  savePreview,
  readPreviews,
  attachPreviewHash,
} from "../../src/routing/history";
import {
  normalizeQuote,
  normalizeStatus,
  normalizeConnections,
} from "../../src/routing/normalize";
import {
  fixtureCatalog,
  fixtureInput,
  fixtureQuote,
  fixtureNetwork,
  addresses,
} from "../fixtures/routing";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("non-EVM wallet discovery without an extension fails closed", async () => {
  vi.stubGlobal("window", {});
  await expect(connectNativeRead(fixtureNetwork("btc"))).rejects.toThrow(
    "WALLET_ECOSYSTEM_UNSUPPORTED",
  );
});
it("Solana connection reads a public key, never requests a transaction", async () => {
  const connect = vi.fn(async () => ({
    publicKey: { toString: () => addresses.SVM },
  }));
  vi.stubGlobal("window", { solana: { connect } });
  expect(await connectNativeRead(fixtureNetwork("sol"))).toBe(addresses.SVM);
  expect(connect).toHaveBeenCalledExactlyOnceWith();
});
it("Bitcoin wallet on a test network is not silently switched", async () => {
  const requestAccounts = vi.fn();
  vi.stubGlobal("window", {
    unisat: { requestAccounts, getNetwork: async () => "testnet" },
  });
  await expect(connectNativeRead(fixtureNetwork("btc"))).rejects.toThrow(
    "WALLET_ECOSYSTEM_UNSUPPORTED",
  );
  expect(requestAccounts).not.toHaveBeenCalled();
});
it("Bitcoin network change during permission or identity polling invalidates readiness", async () => {
  const getNetwork = vi
    .fn()
    .mockResolvedValueOnce("livenet")
    .mockResolvedValue("testnet");
  const getAccounts = vi.fn(async () => [addresses.UTXO]);
  vi.stubGlobal("window", {
    unisat: {
      getNetwork,
      getAccounts,
      requestAccounts: async () => [addresses.UTXO],
    },
  });
  await expect(connectNativeRead(fixtureNetwork("btc"))).rejects.toThrow(
    "WALLET_ECOSYSTEM_UNSUPPORTED",
  );
  expect(await readNativeIdentity(fixtureNetwork("btc"))).toBeUndefined();
  expect(getAccounts).not.toHaveBeenCalled();
});
it("permission timeout retains underlying request lock and late result cannot auto-connect", async () => {
  vi.useFakeTimers();
  let release: (v: {
    publicKey: { toString: () => string };
  }) => void = () => {};
  const connect = vi.fn(
    () =>
      new Promise<{ publicKey: { toString: () => string } }>(
        (r) => (release = r),
      ),
  );
  vi.stubGlobal("window", { solana: { connect } });
  const pending = boundedNativeConnect(fixtureNetwork("sol"));
  const rejection = expect(pending).rejects.toThrow("WALLET_TIMEOUT");
  await vi.advanceTimersByTimeAsync(12001);
  await rejection;
  await expect(boundedNativeConnect(fixtureNetwork("sol"))).rejects.toThrow(
    "WALLET_REQUEST_PENDING",
  );
  expect(connect).toHaveBeenCalledTimes(1);
  release({ publicKey: { toString: () => addresses.SVM } });
  await Promise.resolve();
  await Promise.resolve();
});
function storage(initial = "[]") {
  let raw = initial;
  vi.stubGlobal("localStorage", {
    getItem: () => raw,
    setItem: (_key: string, value: string) => (raw = value),
  });
  vi.stubGlobal("navigator", {
    locks: { request: async (_key: string, cb: () => unknown) => cb() },
  });
  return () => raw;
}
function preview() {
  const c = fixtureCatalog(),
    i = fixtureInput();
  return {
    q: normalizeQuote(fixtureQuote(i), i, c),
    from: fixtureNetwork("eth"),
    to: fixtureNetwork("bas"),
  };
}
it("preview namespace preserves records; attached hashes stay untrusted hints", async () => {
  const raw = storage(),
    p = preview();
  await savePreview(p.q, p.from, p.to);
  await savePreview({ ...p.q, id: "another" }, p.from, p.to);
  expect(readPreviews()).toHaveLength(2);
  await attachPreviewHash(p.q.id, `0x${"a".repeat(64)}`);
  expect(readPreviews().find((r) => r.id === p.q.id)?.state).toBe(
    "QUOTE_PREVIEW",
  );
  await expect(
    attachPreviewHash(p.q.id, `0x${"b".repeat(64)}`),
  ).rejects.toThrow("HASH_CONFLICT");
  expect(JSON.parse(raw())).toHaveLength(2);
});
it("corrupt/imported completion claims are never overwritten or trusted", async () => {
  const raw = storage('[{"state":"COMPLETED"}]'),
    p = preview();
  expect(readPreviews()).toEqual([]);
  await expect(savePreview(p.q, p.from, p.to)).rejects.toThrow();
  expect(raw()).toBe('[{"state":"COMPLETED"}]');
});
it("absent namespace lock does not write a preview", async () => {
  const raw = storage(),
    p = preview();
  vi.stubGlobal("navigator", {});
  await expect(savePreview(p.q, p.from, p.to)).rejects.toThrow(
    "STORAGE_LOCK_UNAVAILABLE",
  );
  expect(raw()).toBe("[]");
});
it("bare connection addresses hydrate only from actual token metadata", () => {
  const raw = fixtureQuote(),
    data = {
      connections: [
        {
          fromChainId: 1,
          toChainId: 8453,
          fromTokens: [
            { chainId: 1, address: raw.action.fromToken.address },
            { chainId: 1, address: "unknown" },
          ],
          toTokens: [{ chainId: 8453, address: raw.action.toToken.address }],
        },
      ],
    };
  const c = normalizeConnections(data, "1", "8453", {
    source: [raw.action.fromToken],
    destination: [raw.action.toToken],
  });
  expect(c[0].sourceAssets).toEqual([raw.action.fromToken]);
  expect(c[0].destinationAssets[0].decimals).toBe(18);
});
it("status requires source amount/assets/recipients and minimum payout", () => {
  const context = { ...fixtureInput(), minimum: "10" },
    q = fixtureQuote(),
    input = {
      source: context.source,
      destination: context.destination,
      hash: "h",
      context,
    };
  const raw = {
    status: "DONE",
    substatus: "COMPLETED",
    fromAddress: context.sourceAddress,
    toAddress: context.destinationAddress,
    sending: {
      chainId: context.source,
      txHash: "h",
      amount: context.amount,
      token: q.action.fromToken,
    },
    receiving: {
      chainId: context.destination,
      txHash: "r",
      amount: "10",
      token: q.action.toToken,
    },
  };
  expect(normalizeStatus(raw, input).status).toBe("COMPLETED");
  expect(
    normalizeStatus({ ...raw, toAddress: addresses.SVM }, input).status,
  ).toBe("UNKNOWN");
  expect(
    normalizeStatus(
      { ...raw, receiving: { ...raw.receiving, amount: "9" } },
      input,
    ).status,
  ).toBe("UNKNOWN");
  expect(normalizeStatus(raw, { ...input, context: undefined }).status).toBe(
    "UNKNOWN",
  );
});
