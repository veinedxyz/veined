// SYNTHETIC_TEST_ONLY: these use programmable chains and recording signers; no network or wallet is reached.
import { expect, it, vi } from "vitest";
import { lane, OWNER_KEY as SWAP_KEY, BASE_ROUTE } from "./swap-lane-fake";
import {
  bridgeLane,
  OWNER_KEY as BRIDGE_KEY,
  settleSource,
  fillAndBury,
} from "./bridge-lane-fake";
vi.mock("../../src/swap/lane/pins", async (original) => {
  const real = await original<typeof import("../../src/swap/lane/pins")>();
  return (await import("./swap-lane-pin-mock")).fakeCodePinModule(real);
});
vi.mock("../../src/swap/lane/bridge-pins", async (original) => {
  const real =
    await original<typeof import("../../src/swap/lane/bridge-pins")>();
  return (await import("./bridge-lane-pin-mock")).fakeBridgePinModule(real);
});
for (const bridge of [false, true]) {
  const name = bridge ? "Bridge" : "Swap",
    amount = bridge ? 5000000n : 1000000n,
    key = bridge ? BRIDGE_KEY : SWAP_KEY;
  const setup = () => {
    const l = bridge
      ? bridgeLane({ reuseExistingAllowance: true })
      : lane({ reuseExistingAllowance: true });
    const chain = "src" in l ? l.src : l.chain;
    return { l, chain, engine: l.engine };
  };
  it.each([1n, 2n, 7n])(
    `${name}: existing allowance × %s skips approval and settles with the exact residual`,
    async (multiplier) => {
      const { l, chain, engine } = setup();
      chain.allowance = amount * multiplier;
      const r = await engine.review(key);
      expect(r.ready, r.problems.join(",")).toBe(true);
      expect(r.step).toBe(bridge ? "EXECUTE" : "SWAP");
      expect(r.reusedAllowance).toBe((amount * multiplier).toString());
      expect(r.gas.limits.APPROVE).toBeUndefined();
      const token = engine.authorize(r.reviewId, key),
        dispatch = await engine.dispatch(token, key);
      expect(dispatch.outcome).toBe("SENT");
      if ("src" in l) {
        settleSource(l);
        fillAndBury(l, l.src.deposits.at(-1)!);
      } else {
        chain.mine();
        chain.advance(BASE_ROUTE.confirmations);
      }
      const tracking = await engine.track();
      expect(tracking.state).toBe("SETTLED_VERIFIED");
      expect(tracking.allowance.value).toBe(
        (amount * (multiplier - 1n)).toString(),
      );
      expect(
        l.store.of("USE").map((e) => (e.data as { step: string }).step),
      ).toEqual([bridge ? "EXECUTE" : "SWAP"]);
      expect(engine.nextStep()).toBeNull();
      const again = await engine.review(key);
      expect(again.ready).toBe(false);
      expect(again.problems).toContain("LANE_ALREADY_USED");
      await expect(engine.dispatch(token, key)).rejects.toBeDefined();
    },
  );
  it.each([0n, 1n])(
    `${name}: insufficient allowance %s requests only the exact permission`,
    async (previous) => {
      const { chain, engine } = setup();
      chain.allowance = previous;
      const r = await engine.review(key);
      expect(r.ready, r.problems.join(",")).toBe(true);
      expect(r.step).toBe("APPROVE");
      expect(r.reusedAllowance).toBeUndefined();
      expect(r.simulation?.allowanceAfter).toBe("0");
      expect(r.gas.limits.APPROVE).toBeDefined();
    },
  );
  it(`${name}: changed allowance during wallet preflight stops before any USE or send`, async () => {
    const { l, chain, engine } = setup();
    chain.allowance = amount * 2n;
    const r = await engine.review(key);
    expect(r.ready).toBe(true);
    const token = engine.authorize(r.reviewId, key);
    chain.allowance = amount;
    await expect(engine.dispatch(token, key)).rejects.toBeDefined();
    expect(l.store.of("USE")).toHaveLength(0);
    expect(l.store.of("PREPARED")).toHaveLength(0);
  });
  it(`${name}: a fresh review detects reduced allowance and invalidates the old execution review`, async () => {
    const { chain, engine } = setup();
    chain.allowance = amount;
    const r = await engine.review(key);
    chain.allowance = 0n;
    const fresh = await engine.review(key);
    expect(fresh.step).toBe("APPROVE");
    expect(() => engine.authorize(r.reviewId, key)).toThrow();
  });
  it(`${name}: existing allowance cannot bypass Guardian or simulation`, async () => {
    const { chain, engine } = setup();
    chain.allowance = amount;
    // Both accepted fake chains have a balance below the required amount here.
    chain.usdc = 0n;
    const r = await engine.review(key);
    expect(r.ready).toBe(false);
    expect(r.problems).toContain("USDC_BALANCE_BELOW_AMOUNT");
    expect(() => engine.authorize(r.reviewId, key)).toThrow();
  });
  it(`${name}: allowance operator disagreement cannot reach preparation`, async () => {
    const { l, chain, engine } = setup();
    chain.allowance = amount;
    chain.tamper = (op, method, params) =>
      op === 1 &&
      method === "eth_call" &&
      String((params[0] as { data?: string })?.data).startsWith("0xdd62ed3e")
        ? "0x0"
        : undefined;
    await expect(engine.review(key)).rejects.toThrow("ALLOWANCE_UNPROVEN");
    expect(l.store.of("USE")).toHaveLength(0);
    expect(l.signer.calls).toHaveLength(0);
  });
  it(`${name}: successful exact approval is never requested again`, async () => {
    const { l, chain, engine } = setup();
    const approval = await engine.review(key);
    expect(approval.step).toBe("APPROVE");
    const token = engine.authorize(approval.reviewId, key);
    expect((await engine.dispatch(token, key)).outcome).toBe("SENT");
    if ("src" in l) settleSource(l);
    else {
      chain.mine();
      chain.advance(BASE_ROUTE.confirmations);
    }
    await engine.track();
    const r = await engine.review(key);
    expect(r.ready, r.problems.join(",")).toBe(true);
    expect(r.step).toBe(bridge ? "EXECUTE" : "SWAP");
    expect(r.reusedAllowance).toBeUndefined();
  });
  it(`${name}: UNKNOWN after allowance reuse cannot create a new approval or resend`, async () => {
    const { l, chain, engine } = setup();
    chain.allowance = amount;
    l.signer.answer = () => ({
      outcome: "UNCERTAIN" as const,
      hash: null,
      problems: ["SYNTHETIC_UNKNOWN"],
    });
    const r = await engine.review(key);
    const token = engine.authorize(r.reviewId, key);
    expect((await engine.dispatch(token, key)).outcome).toBe("UNCERTAIN");
    expect(engine.nextStep()).toBeNull();
    const later = await engine.review(key);
    expect(later.ready).toBe(false);
    await expect(engine.dispatch(token, key)).rejects.toBeDefined();
    expect(l.signer.calls).toHaveLength(1);
  });
}
