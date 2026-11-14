import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  adapterFixture,
  defiFixture,
  families,
  loan,
  collateral,
  oracle,
  pair,
  vault,
} from "../fixtures/defi";
import { adapterFor } from "../../src/defi/adapters";
import {
  accrueMorpho,
  decimal,
  liquidityAmounts,
  micros,
  mulDiv,
  sharesToAssets,
  sqrtAtTick,
  UINT256_MAX,
  WAD,
} from "../../src/defi/math";
import { portfolioTotals, mergeDefi } from "../../src/defi/valuation";
import { rawSchema, scanSchema } from "../../src/defi/model";
import { holding } from "../fixtures/portfolio";
import { assertAllowed } from "../../src/data/rpc/methods";
import { encodeFunctionData } from "viem";
import { abiFor } from "../../src/defi/abi";
import { exactUsd, nativeRatio } from "../../src/defi/display";
async function readAll(ctx: ReturnType<typeof adapterFixture>["ctx"]) {
  const adapter = adapterFor(ctx.deployment),
    out = [];
  for (const ref of await adapter.discover(ctx)) {
    const p = await adapter.readPosition(ref, ctx);
    if (p) out.push(p);
  }
  return out;
}
for (const family of families)
  describe(family, () => {
    it("deterministic nonzero position proof with pinned source and positive owed debt", async () => {
      const { ctx } = adapterFixture(family);
      const p = await readAll(ctx);
      expect(p.length).toBeGreaterThan(0);
      expect(p[0].sourceBlock).toBe("12345");
      expect(p[0].evidence[0].source).toBe("SYNTHETIC_FIXTURE_ONLY");
      expect(p[0].borrowed.every((a) => BigInt(a.rawAmount) > 0n)).toBe(true);
    });
    it("exact zero differs from unknown", async () =>
      expect(await readAll(adapterFixture(family, true).ctx)).toEqual([]));
    it("malformed output fails instead of zero", async () => {
      const { ctx } = adapterFixture(family);
      ctx.read = async () => "MALFORMED";
      await expect(readAll(ctx)).rejects.toThrow();
    });
    it("RPC failure remains failure", async () => {
      const { ctx } = adapterFixture(family);
      ctx.read = async () => {
        throw Error("RPC_FAILURE");
      };
      await expect(readAll(ctx)).rejects.toThrow();
    });
    it("stale state cannot appear fresh", async () => {
      const { ctx } = adapterFixture(family);
      ctx.pin.observedAt -= 120000;
      await expect(readAll(ctx)).rejects.toThrow("STALE_STATE");
    });
    it("unknown deployment rejected", async () => {
      const { ctx } = adapterFixture(family);
      ctx.deployment = { ...ctx.deployment, id: "fake-deployment" };
      await expect(readAll(ctx)).rejects.toThrow("UNSUPPORTED_DEPLOYMENT");
    });
    it("identity mismatch rejected", async () => {
      const { ctx } = adapterFixture(family),
        original = ctx.read;
      ctx.read = async (t, n, a) => {
        if (
          [
            "getPool",
            "baseToken",
            "idToMarketParams",
            "isMetaMorpho",
            "asset",
            "getPair",
            "ownerOf",
          ].includes(n)
        ) {
          if (n === "isMetaMorpho") return false;
          if (n === "idToMarketParams")
            return [loan, collateral, oracle, loan, 1n];
          if (n === "asset") return ctx.deployment.contracts.vault ?? vault;
          return "bad-address";
        }
        return original(t, n, a);
      };
      if (family === "lido") {
        ctx.deployment = {
          ...ctx.deployment,
          contracts: { steth: "bad-address", wsteth: "bad-address" },
        };
      }
      await expect(readAll(ctx)).rejects.toThrow();
    });
    it("pricing unavailable never hides the position or debt", async () => {
      const p = await readAll(adapterFixture(family, false, true).ctx);
      expect(p.length).toBeGreaterThan(0);
      expect(p[0].grossAssetsUsd).toBe("0.000000");
      expect(p[0].warnings).toContain("UNPRICED_UNDERLYING");
      if (p[0].borrowed.length)
        expect(p[0].warnings).toContain("UNPRICED_DEBT");
    });
  });
describe("protocol accounting", () => {
  it("vault shares and Lido conversion retain the correct presentation units", async () => {
    const vault = (await readAll(adapterFixture("erc4626").ctx))[0];
    expect(vault.details).toMatchObject({
      shareDecimals: "18",
      shareSymbol: "SHARE",
      shares: "10000000000000000000",
    });
    const lido = await readAll(adapterFixture("lido").ctx);
    expect(
      lido.find((p) => p.details.positionToken === "wstETH")!.details.rateRaw,
    ).toBe("1200000000000000000");
  });
  it("Aave collateral subset is counted once", async () => {
    const p = (await readAll(adapterFixture("aave-v3").ctx))[0];
    expect(p.grossAssetsUsd).toBe("1000.000000");
    expect(p.debtUsd).toBe("100.000000");
    expect(p.knownNetUsd).toBe("900.000000");
    expect(p.risk.kind).toBe("health-factor");
  });
  it("Aave zero health factor is attention, not absent", async () => {
    const { ctx } = adapterFixture("aave-v3"),
      read = ctx.read;
    ctx.read = async (t, n, a) =>
      n === "getUserAccountData"
        ? [1n, 1n, 0n, 8000n, 7500n, 0n]
        : read(t, n, a);
    expect((await readAll(ctx))[0].risk).toMatchObject({
      kind: "health-factor",
      value: "0.000000000000000000",
      attention: "attention",
    });
  });
  it("Compound counts deposited collateral plus current base supply minus current debt", async () => {
    const p = (await readAll(adapterFixture("compound-iii").ctx))[0];
    expect(p.grossAssetsUsd).toBe("4100.000000");
    expect(p.debtUsd).toBe("20.000000");
    expect(p.risk.kind).toBe("collateralization-status");
  });
  it.each([
    [true, false, "none"],
    [false, false, "attention"],
    [true, true, "attention"],
  ])("Compound native booleans %s / %s", async (ok, liq, attention) => {
    const { ctx } = adapterFixture("compound-iii"),
      read = ctx.read;
    ctx.read = async (t, n, a) =>
      n === "isBorrowCollateralized"
        ? ok
        : n === "isLiquidatable"
          ? liq
          : read(t, n, a);
    expect((await readAll(ctx))[0].risk).toMatchObject({ attention });
  });
  it("Morpho virtual shares round supply down and debt up", () => {
    expect(sharesToAssets(1n, 1n, 1n)).toBe(0n);
    expect(sharesToAssets(1n, 1n, 1n, true)).toBe(1n);
  });
  it("Morpho fee shares use accrued supply minus fee amount", () => {
    const x = accrueMorpho(
      [1000n, 1000000n, 500n, 1000000n, 0n, WAD / 10n],
      WAD / 100n,
      10n,
    );
    expect(x.borrowAssets).toBe(552n);
    expect(x.supplyAssets).toBe(1052n);
    expect(x.supplyShares).toBe(1009541n);
  });
  it("Morpho does not trust an unreviewed oracle", async () => {
    const { ctx } = adapterFixture("morpho-blue");
    ctx.trustedOracles = new Set();
    expect((await readAll(ctx))[0].risk).toEqual({
      kind: "not-available",
      reason: "ORACLE_NOT_REVIEWED",
    });
  });
  it("Morpho zero oracle does not delete debt", async () => {
    const { ctx } = adapterFixture("morpho-blue"),
      read = ctx.read;
    ctx.read = async (t, n, a) => (n === "price" ? 0n : read(t, n, a));
    const p = (await readAll(ctx))[0];
    expect(p.borrowed.length).toBe(1);
    expect(p.risk.kind).toBe("not-available");
  });
  it("wstETH converts at official rate and stETH remains rebasing exposure", async () => {
    const p = await readAll(adapterFixture("lido").ctx);
    expect(p[1].underlying[0].rawAmount).toBe((12n * WAD).toString());
    expect(p[0].rewards).toEqual([]);
  });
  it("vault uses convertToAssets, never share price", async () => {
    const p = (await readAll(adapterFixture("erc4626").ctx))[0];
    expect(p.grossAssetsUsd).toBe("11.000000");
    expect(p.details.shares).toBe((10n * WAD).toString());
  });
  it("self-asset vault cycle rejected", async () => {
    const { ctx } = adapterFixture("erc4626"),
      read = ctx.read;
    ctx.read = async (t, n, a) =>
      n === "asset" ? ctx.deployment.contracts.vault : read(t, n, a);
    await expect(readAll(ctx)).rejects.toThrow("VAULT_CYCLE");
  });
  it("nested curated cycle rejected", async () => {
    const { ctx } = adapterFixture("erc4626"),
      read = ctx.read;
    ctx.curatedVaults = new Set([loan]);
    ctx.read = async (t, n, a) =>
      n === "asset"
        ? t === loan
          ? ctx.deployment.contracts.vault
          : loan
        : read(t, n, a);
    await expect(readAll(ctx)).rejects.toThrow("VAULT_CYCLE");
  });
  it("LP proportions follow reserves and total supply", async () => {
    const p = (await readAll(adapterFixture("uniswap-v2").ctx))[0];
    expect(p.underlying.map((a) => a.rawAmount)).toEqual([
      "100000000",
      WAD.toString(),
    ]);
    expect(p.grossAssetsUsd).toBe("2100.000000");
  });
  it("LP zero total supply rejected", async () => {
    const { ctx } = adapterFixture("uniswap-v2"),
      read = ctx.read;
    ctx.read = async (t, n, a) => (n === "totalSupply" ? 0n : read(t, n, a));
    await expect(readAll(ctx)).rejects.toThrow("INVALID_LP_SUPPLY");
  });
  it("V3 uncollected fees are exact, outside rewards and gross (V1.14 closes the V1.13 fee gap)", async () => {
    const p = (await readAll(adapterFixture("uniswap-v3").ctx))[0];
    expect(p.rewards).toEqual([]);
    expect(p.coverage).toBe("FULL_POSITION");
    expect(p.details.range).toBe("IN_RANGE");
    expect(p.details.fees).toBe("UNCOLLECTED_EXACT_AT_SOURCE_BLOCK");
    expect(p.fees?.map((f) => [f.role, f.rawAmount])).toEqual([
      ["fee", "999999"],
    ]);
    const principal = p.underlying.reduce(
      (s, a) => s + Number(a.valueUsd ?? 0),
      0,
    );
    expect(Number(p.grossAssetsUsd)).toBeCloseTo(principal, 6);
  });
  it("only protocol-view rewards are claimable", async () => {
    const scan = await defiFixture();
    expect(
      scan.positions
        .flatMap((p) => p.rewards)
        .every((r) => r.confidence === "protocol-view"),
    ).toBe(true);
  });
});
describe("exact math and exposure graph", () => {
  it("every literal V113 UI message key exists in the canonical dictionary", () => {
    const dictionary = JSON.parse(
      readFileSync("src/i18n/locales/en.json", "utf8"),
    );
    for (const path of [
      "src/components/help-view.tsx",
      "src/components/portfolio.tsx",
      "src/components/portfolio-defi.tsx",
    ]) {
      for (const match of readFileSync(path, "utf8").matchAll(
        /["']v113\.([a-zA-Z0-9]+)["']/g,
      ))
        expect(typeof dictionary.v113[match[1]], path + ":" + match[1]).toBe(
          "string",
        );
    }
  });
  it("native risk formatting preserves large integer magnitude without Number coercion", () => {
    expect(nativeRatio("123456789012345678901234567890.123456")).toBe(
      "123456789012345678901234567890.123",
    );
    expect(nativeRatio("2.000000000000000000")).toBe("2.000");
  });
  it("priced USD dust is visibly below one cent, not zero", () => {
    expect(exactUsd("0.000001")).toBe("<$0.01");
    expect(exactUsd("0.000000")).toBe("$0.00");
  });
  it("unsafe legacy floating USD stays unpriced instead of crashing or inventing precision", () => {
    const total = portfolioTotals([holding("1", WAD.toString(), 1e30)]);
    expect(total.walletUsd).toBe("0.000000");
    expect(total.unpricedAssets).toBe(1);
  });
  it("fee recipient with zero stored shares receives the correctly accrued Morpho fee shares", async () => {
    const { ctx } = adapterFixture("morpho-blue", true);
    const read = ctx.read.bind(ctx);
    ctx.read = async (target, name, args) =>
      name === "feeRecipient" ? ctx.wallet : read(target, name, args);
    const p = (await readAll(ctx))[0];
    expect(BigInt(p.supplied[0].rawAmount)).toBeGreaterThan(0n);
    expect(p.borrowed).toEqual([]);
    expect(p.collateral).toEqual([]);
  });
  it("zero-result replacement ownership is released when that deployment fails on refresh", async () => {
    const scan = await defiFixture(),
      c = scan.coverage[0],
      receipt = "1:0x1111111111111111111111111111111111111111";
    const old = {
      ...scan,
      positions: [],
      coverage: [c],
      replacedWalletAssets: [receipt],
      replacementOwners: { [c.deploymentId]: [receipt] },
    };
    const failed = {
      ...old,
      replacedWalletAssets: [],
      replacementOwners: {},
      coverage: [
        { ...c, state: "FAILED" as const, result: "UNKNOWN" as const },
      ],
    };
    expect(mergeDefi(old, failed).replacedWalletAssets).toEqual([]);
  });
  it.each([0, 6, 8, 18, 36])("decimal %s preserves uint256", (d) =>
    expect(decimal(UINT256_MAX, d).replace(".", "")).toBe(
      UINT256_MAX.toString().padStart(d + 1, "0"),
    ),
  );
  it.each([0n, 1n, 2n ** 128n, UINT256_MAX])("raw boundary %s", (v) =>
    expect(rawSchema.parse(v.toString())).toBe(v.toString()),
  );
  it("uint256 overflow rejected", () =>
    expect(rawSchema.safeParse((UINT256_MAX + 1n).toString()).success).toBe(
      false,
    ));
  it("negative owed amount rejected", () =>
    expect(rawSchema.safeParse("-1").success).toBe(false));
  it("mulDiv rounding", () => {
    expect(mulDiv(5n, 5n, 3n)).toBe(8n);
    expect(mulDiv(5n, 5n, 3n, true)).toBe(9n);
  });
  it("official TickMath zero and extrema", () => {
    expect(sqrtAtTick(0)).toBe(2n ** 96n);
    expect(sqrtAtTick(-887272)).toBe(4295128739n);
    expect(sqrtAtTick(887272)).toBe(
      1461446703485210103287273052203988822378723970342n,
    );
  });
  it.each([-61, 0, 61])("V3 range tick %s", (tick) => {
    const [a, b] = liquidityAmounts(WAD, sqrtAtTick(tick), -60, 60);
    expect(a >= 0n && b >= 0n).toBe(true);
    if (tick < -60) expect(b).toBe(0n);
    if (tick > 60) expect(a).toBe(0n);
  });
  it("currency formatting never Number overflows", () =>
    expect(exactUsd(decimal(UINT256_MAX, 6))).toContain("115,792"));
  it("wrapper and independent underlying wallet balance count once each", async () => {
    const scan = await defiFixture(),
      p = scan.positions.find((p) => p.protocolId === "erc4626")!;
    scan.positions = [p];
    scan.replacedWalletAssets = p.representations;
    const total = portfolioTotals(
      [
        holding("1", WAD.toString(), 100, {
          address: p.details.shareContract,
          native: false,
        }),
        holding("1", "5000000", 5, {
          address: loan,
          native: false,
          decimals: 6,
        }),
      ],
      scan,
    );
    expect(total.walletUsd).toBe("5.000000");
    expect(total.defiUsd).toBe("11.000000");
    expect(total.knownNetUsd).toBe("16.000000");
  });
  it("duplicate positions cannot inflate totals", async () => {
    const scan = await defiFixture();
    const before = portfolioTotals([], scan);
    scan.positions.push(...scan.positions);
    expect(portfolioTotals([], scan).knownNetUsd).toBe(before.knownNetUsd);
  });
  it("unpriced debt remains positive and net partial", async () => {
    const scan = await defiFixture();
    scan.positions[0].borrowed[0].valueUsd = null;
    const total = portfolioTotals([], scan);
    expect(total.unpricedDebt).toBe(1);
    expect(total.partial).toBe(true);
  });
  it("fresh zero closes older position on progressive merge", async () => {
    const old = await defiFixture(),
      next = {
        ...old,
        positions: [],
        coverage: [old.coverage[0]],
        replacedWalletAssets: [],
        continuation: [],
      };
    expect(
      mergeDefi(old, next).positions.some(
        (p) => p.deploymentId === next.coverage[0].deploymentId,
      ),
    ).toBe(false);
  });
  it("cross-wallet merges refused", async () => {
    const scan = await defiFixture();
    expect(() => mergeDefi(scan, { ...scan, wallet: loan })).toThrow(
      "WALLET_SCOPE_MISMATCH",
    );
  });
  it("model retains source provenance", async () =>
    expect(scanSchema.parse(await defiFixture()).version).toBe(2));
  it("USD micros handles negative net only", () =>
    expect(micros("-1.000001")).toBe(-1000001n));
});
describe("read capability boundary", () => {
  const data = encodeFunctionData({
    abi: abiFor("asset"),
    functionName: "asset",
  });
  it("unknown protocol selector fails without capability", () =>
    expect(() =>
      assertAllowed(
        { method: "eth_call", params: [{ to: vault, data }, "0x1"] },
        { ecosystem: "EVM" },
      ),
    ).toThrow());
  it("exact server capability permits pinned view", () =>
    expect(() =>
      assertAllowed(
        { method: "eth_call", params: [{ to: vault, data }, "0x1"] },
        { ecosystem: "EVM", defiViews: [{ to: vault, data }] },
      ),
    ).not.toThrow());
  it("same selector at wrong target rejected", () =>
    expect(() =>
      assertAllowed(
        { method: "eth_call", params: [{ to: pair, data }, "0x1"] },
        { ecosystem: "EVM", defiViews: [{ to: vault, data }] },
      ),
    ).toThrow());
  it.each([
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "personal_sign",
    "eth_sign",
    "wallet_sendCalls",
    "wallet_grantPermissions",
  ])("%s remains rejected", (method) =>
    expect(() =>
      assertAllowed(
        { method, params: [] },
        { ecosystem: "EVM", defiViews: [{ to: vault, data }] },
      ),
    ).toThrow(),
  );
});
