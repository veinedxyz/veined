import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base58 } from "@scure/base";
import { DurableSwapHealth } from "../../src/swap/server/health";
import {
  SPL,
  TOKEN_2022,
  decodeSolMint,
  decodeSolTokenAccount,
  type RawSolAccount,
} from "../../src/swap/server/solana-accounts";
import { isSolanaMint, SOLANA_CHAIN_ID } from "../../src/assets/model";
import { searchAssets } from "../../src/assets/registry";
import {
  readImported,
  saveImported,
  removeImported,
} from "../../src/assets/client";
import { solIntent, swapIntent } from "../fixtures/swap";
import { decodePcsx, pcsx } from "../../src/swap/server/providers/pcsx";
import * as transport from "../../src/swap/server/transport";
import {
  ExclusiveDutchOrderV3,
  ExclusiveDutchOrderV4,
  REACTOR_ADDRESS_MAPPING,
  MULTI_REACTOR_ROUTER_MAPPING,
} from "../../swap-providers/compatibility";
import { OrderType } from "../../swap-providers/runtime";
afterEach(() => vi.restoreAllMocks());
const account = (b: Buffer, owner = SPL): RawSolAccount => ({
  owner,
  executable: false,
  data: [b.toString("base64"), "base64"],
  lamports: 2000000,
});
function mint() {
  const b = Buffer.alloc(82);
  b[44] = 6;
  b[45] = 1;
  return b;
}
describe("anonymous bounded durable health", () => {
  it("survives restart, expires buckets, rejects identifying labels", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-swap-health-")),
      path = join(dir, "health.sqlite"),
      now = Date.now(),
      sample = {
        mode: "TITAN",
        chain: "solana",
        phase: "quote",
        status: "PROVIDER_TIMEOUT",
        latencyMs: 8000,
      } as const;
    let db = new DurableSwapHealth(path);
    try {
      db.record(sample, now);
      db.close();
      db = new DurableSwapHealth(path);
      expect(db.snapshot(now)[0]).toMatchObject({
        total: 1,
        timeout: 1,
        b5: 1,
      });
      expect(() =>
        db.record({ ...sample, wallet: solIntent().taker } as never),
      ).toThrow();
      db.record({ ...sample, status: "OK" }, now + 50 * 3600000);
      expect(db.snapshot(now + 50 * 3600000)).toHaveLength(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true });
    }
  });
});
describe("Solana identity, mint and token-account firewall", () => {
  it("parses initialized legacy mint and exact decimals", () => {
    expect(decodeSolMint(account(mint()))).toMatchObject({
      decimals: 6,
      program: SPL,
      extensions: [],
    });
  });
  it.each([
    "owner",
    "executable",
    "uninitialized",
    "decimals",
    "size",
    "authority",
  ])("rejects %s", (kind) => {
    const b = mint(),
      a = account(b);
    if (kind === "owner") a.owner = solIntent().taker;
    if (kind === "executable") a.executable = true;
    if (kind === "uninitialized") b[45] = 0;
    if (kind === "decimals") b[44] = 255;
    if (kind === "size") a.data[0] = Buffer.alloc(81).toString("base64");
    else if (kind === "authority") b.writeUInt32LE(3, 0);
    if (!["size", "owner", "executable"].includes(kind))
      a.data[0] = b.toString("base64");
    expect(() => decodeSolMint(a)).toThrow();
  });
  it.each([1, 3, 4, 6, 9, 10, 12, 14, 25, 26, 65535])(
    "fails closed for economic/unknown mint extension %s",
    (type) => {
      const b = Buffer.alloc(170);
      mint().copy(b);
      b[165] = 1;
      b.writeUInt16LE(type, 166);
      expect(() => decodeSolMint(account(b, TOKEN_2022))).toThrow();
    },
  );
  it("accepts immutable-owner account and binds mint/owner/amount", () => {
    const b = Buffer.alloc(170),
      i = solIntent();
    Buffer.from(base58.decode(i.tokenOut.address)).copy(b, 0);
    Buffer.from(base58.decode(i.taker)).copy(b, 32);
    b.writeBigUInt64LE(77n, 64);
    b[108] = 1;
    b[165] = 2;
    b.writeUInt16LE(7, 166);
    expect(decodeSolTokenAccount(account(b, TOKEN_2022))).toMatchObject({
      mint: i.tokenOut.address,
      owner: i.taker,
      amount: 77n,
      extensions: [7],
    });
    b[108] = 2;
    expect(() => decodeSolTokenAccount(account(b, TOKEN_2022))).toThrow();
  });
  it("preserves case-sensitive imported mints through save/read/remove and exact search", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => data.set(k, v),
    });
    try {
      const address = solIntent().taker;
      expect(isSolanaMint(address)).toBe(true);
      saveImported({
        chainId: SOLANA_CHAIN_ID,
        address,
        symbol: "TEST",
        name: "Unverified",
        decimals: 6,
        logoUrl: null,
        importedAt: 1,
      });
      expect(readImported(SOLANA_CHAIN_ID)[0].address).toBe(address);
      expect(searchAssets(SOLANA_CHAIN_ID, address, null)).toEqual({
        results: [],
        lookup: true,
      });
      expect(removeImported(SOLANA_CHAIN_ID, address)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
describe("current PCSX nonlinear orders", () => {
  const make = (version: 3 | 4) => {
    const i = swapIntent({ chain: "56" });
    i.tokenIn = {
      ...i.tokenIn,
      chain: "56",
      native: false,
      address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    };
    i.tokenOut = {
      ...i.tokenOut,
      chain: "56",
      address: "0x55d398326f99059fF775485246999027B3197955",
    };
    const Class = version === 3 ? ExclusiveDutchOrderV3 : ExclusiveDutchOrderV4,
      info = {
        reactor:
          version === 3
            ? REACTOR_ADDRESS_MAPPING[56].ExclusiveDutchOrderV3
            : REACTOR_ADDRESS_MAPPING[56].ExclusiveDutchOrderV4,
        swapper: i.taker as `0x${string}`,
        nonce: 7n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 90),
        additionalValidationContract:
          "0x0000000000000000000000000000000000000000" as const,
        additionalValidationData: "0x" as const,
        cosigner: "0x1111111111111111111111111111111111111111" as const,
        startingBaseFee: 1n,
        baseInput: {
          token: i.tokenIn.address as `0x${string}`,
          startAmount: i.amount,
          maxAmount: i.amount,
          curve: { relativeBlocks: 0n, relativeAmounts: [] },
          adjustmentPerGweiBaseFee: 0n,
        },
        baseOutputs: [
          {
            token: i.tokenOut.address as `0x${string}`,
            recipient: i.recipient as `0x${string}`,
            startAmount: 1000000n,
            minAmount: 995000n,
            curve: { relativeBlocks: 10n, relativeAmounts: [5000n] },
            adjustmentPerGweiBaseFee: 0n,
          },
        ],
      };
    return { i, Class, info };
  };
  it.each([3, 4] as const)(
    "decodes V%s with exact bounds, domain, nonce and curve",
    (v) => {
      const { i, Class, info } = make(v),
        order = new Class(info, 56),
        d = decodePcsx(order.encode(), i);
      expect(d.nonce).toBe(7n);
      expect(d.output.endAmount).toBe(995000n);
      expect(d.signable).toBe(false);
      expect(d.permit.domain.chainId).toBe(56);
    },
  );
  it.each([3, 4] as const)(
    "accepts the documented API rfqVersion v%s discriminator for MultiReactor quotes",
    async (v) => {
      const { i, Class, info } = make(v);
      const order = new Class(
        { ...info, reactor: MULTI_REACTOR_ROUTER_MAPPING[56].pcs },
        56,
      );
      vi.spyOn(transport, "jsonRead").mockResolvedValue({
        messageType: "PRICE_RESPONSE",
        message: {
          bestOrder: {
            type: "DUTCH_LIMIT",
            order: {
              encodedOrder: order.encode(),
              permitData: order.permitData(),
              rfqVersion: `v${v}`,
            },
          },
        },
      });
      const quotes = await pcsx(true).quote(i, new AbortController().signal);
      expect(quotes).toHaveLength(1);
      expect(quotes[0].amountIn).toBe(i.amount);
      expect(quotes[0].minAmountOut).toBe(995000n);
    },
  );
  it.each([
    "unknown",
    "missing",
    "conflicting",
    "wrong-version",
    "permit",
    "recipient",
  ])("refuses current API %s version or binding mutation", async (mutation) => {
    const { i, Class, info } = make(4);
    if (mutation === "recipient") info.baseOutputs[0].recipient = info.cosigner;
    const order = new Class(
      { ...info, reactor: MULTI_REACTOR_ROUTER_MAPPING[56].pcs },
      56,
    );
    vi.spyOn(transport, "jsonRead").mockResolvedValue({
      messageType: "PRICE_RESPONSE",
      message: {
        bestOrder: {
          type: "DUTCH_LIMIT",
          order: {
            encodedOrder: order.encode(),
            permitData: mutation === "permit" ? {} : order.permitData(),
            rfqVersion:
              mutation === "unknown"
                ? "v99"
                : mutation === "missing"
                  ? undefined
                  : mutation === "wrong-version"
                    ? "v3"
                    : "v4",
            ...(mutation === "conflicting"
              ? { orderType: OrderType.ExclusiveDutchOrderV3 }
              : {}),
          },
        },
      },
    });
    await expect(
      pcsx(true).quote(i, new AbortController().signal),
    ).rejects.toThrow(
      mutation === "unknown" ? "INVALID_SCHEMA" : "REVIEW_REQUIRED",
    );
  });
  it.each([3, 4] as const)(
    "decodes V%s native output while requiring ERC20 input",
    (v) => {
      const { i, Class, info } = make(v);
      i.tokenOut = {
        ...i.tokenOut,
        native: true,
        address: "0x0000000000000000000000000000000000000000",
      };
      info.baseOutputs[0].token = i.tokenOut.address as `0x${string}`;
      const order = new Class(info, 56);
      expect(decodePcsx(order.encode(), i).output.token).toBe(
        i.tokenOut.address,
      );
      expect(() =>
        decodePcsx(order.encode(), {
          ...i,
          tokenIn: { ...i.tokenIn, native: true },
        }),
      ).toThrow();
    },
  );
  it.each([3, 4] as const)(
    "decodes the typed MultiReactor V%s family and refuses a type mix-up",
    (v) => {
      const { i, Class, info } = make(v),
        type =
          v === 3
            ? OrderType.ExclusiveDutchOrderV3
            : OrderType.ExclusiveDutchOrderV4;
      const order = new Class(
        { ...info, reactor: MULTI_REACTOR_ROUTER_MAPPING[56].pcs },
        56,
      );
      expect(decodePcsx(order.encode(), i, type).orderType).toBe(type);
      expect(() =>
        decodePcsx(order.encode(), i, OrderType.ExclusiveDutchOrder),
      ).toThrow();
    },
  );
  it.each(["recipient", "input", "minimum", "curve", "nonce-domain"])(
    "rejects mutated %s",
    (field) => {
      const { i, Class, info } = make(4);
      if (field === "recipient") info.baseOutputs[0].recipient = info.cosigner;
      if (field === "input") info.baseInput.maxAmount++;
      if (field === "minimum") info.baseOutputs[0].minAmount = 1n;
      if (field === "curve") info.baseOutputs[0].curve.relativeBlocks = 0n;
      const order = new Class(info, 56);
      expect(() =>
        decodePcsx(
          order.encode(),
          field === "nonce-domain" ? { ...i, chain: "1" } : i,
        ),
      ).toThrow();
    },
  );
});
