import { expect, it, vi } from "vitest";
import {
  runFastflow,
  type FastReview,
  type FastflowPort,
} from "../../src/manual-wallet/fastflow";
import type { ManualPreparation } from "../../src/manual-wallet/protocol";
const review = (step = "SWAP"): FastReview => ({
  reviewId: step,
  step,
  ready: true,
  expiresAt: 20000,
  guardian: { level: "CLEAR" },
  amountOutMinimum: "95",
  quoteOut: "100",
});
function port(first = review()) {
  const api: FastflowPort = {
    review: vi.fn().mockResolvedValue(first),
    prepare: vi.fn().mockImplementation(
      async (r) =>
        ({
          id: "id",
          lane: "SWAP",
          reviewId: r.reviewId,
          step: r.step,
          expiresAt: 20000,
          released: true,
        }) as ManualPreparation,
    ),
    send: vi.fn().mockResolvedValue("0xhash"),
    track: vi.fn().mockResolvedValue({
      state: "OK",
      steps: { APPROVE: { state: "FINAL_SUCCESS" } },
    }),
    current: vi.fn(() => true),
    status: vi.fn(),
    submitted: vi.fn(),
    wait: vi.fn().mockResolvedValue(undefined),
    now: () => 1000,
  };
  return api;
}
it("uses a fresh displayed quote and sufficient allowance with one execution prompt", async () => {
  const p = port();
  expect(await runFastflow(p, review())).toBe("SUBMITTED");
  expect(p.review).not.toHaveBeenCalled();
  expect(p.send).toHaveBeenCalledTimes(1);
  expect(p.track).not.toHaveBeenCalled();
});
it("performs approval, receipt, fresh execution review, then the second wallet confirmation", async () => {
  const p = port(review("APPROVE"));
  vi.mocked(p.review)
    .mockResolvedValueOnce(review("APPROVE"))
    .mockResolvedValueOnce(review());
  expect(await runFastflow(p)).toBe("SUBMITTED");
  expect(p.send).toHaveBeenCalledTimes(2);
  expect(p.track).toHaveBeenCalledTimes(1);
  expect(p.prepare).toHaveBeenNthCalledWith(2, review());
});
it.each(["HOLD", "BLOCK", "CAUTION"])(
  "Guardian %s prevents preparation and wallet requests",
  async (level) => {
    const r = review();
    r.guardian = { level };
    const p = port(r);
    await expect(runFastflow(p)).rejects.toThrow("GUARDIAN_STOP");
    expect(p.send).not.toHaveBeenCalled();
    expect(p.prepare).not.toHaveBeenCalled();
  },
);
it("refreshes a stale cached quote", async () => {
  const p = port();
  await runFastflow(p, { ...review(), expiresAt: 0 });
  expect(p.review).toHaveBeenCalledTimes(1);
});
it("stops on a stale provider response", async () => {
  const p = port({ ...review(), expiresAt: 0 });
  await expect(runFastflow(p)).rejects.toThrow("REVIEW_EXPIRED");
  expect(p.send).not.toHaveBeenCalled();
});
it("keeps the real local financial release closed", async () => {
  const p = port();
  vi.mocked(p.prepare).mockResolvedValue({
    released: false,
  } as ManualPreparation);
  expect(await runFastflow(p)).toBe("LOCAL_READY");
  expect(p.send).not.toHaveBeenCalled();
});
it("never resends after wallet rejection", async () => {
  const p = port();
  vi.mocked(p.send).mockRejectedValue(Error("4001"));
  await expect(runFastflow(p)).rejects.toThrow("4001");
  expect(p.send).toHaveBeenCalledTimes(1);
});
it("identity change during prepare stops before wallet", async () => {
  const p = port();
  vi.mocked(p.current)
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockReturnValue(false);
  await expect(runFastflow(p)).rejects.toThrow("WALLET_SESSION_STALE");
  expect(p.send).not.toHaveBeenCalled();
});
it.each([
  "UNKNOWN_TO_BOTH_OPERATORS",
  "FINAL_FAILED",
  "OPERATORS_DISAGREE",
  "REORGED",
])("approval %s stops execution and never resubmits", async (state) => {
  const p = port(review("APPROVE"));
  vi.mocked(p.track).mockResolvedValue({
    state,
    steps: { APPROVE: { state } },
  });
  await expect(runFastflow(p)).rejects.toThrow("APPROVAL_NEEDS_RECONCILIATION");
  expect(p.send).toHaveBeenCalledTimes(1);
});
it("preserves the originally displayed minimum across the post-approval quote", async () => {
  const p = port();
  vi.mocked(p.review)
    .mockResolvedValueOnce(review("APPROVE"))
    .mockResolvedValueOnce({
      ...review(),
      amountOutMinimum: "90",
      quoteOut: "94",
    });
  await expect(runFastflow(p)).rejects.toThrow("MINIMUM_OUTPUT_CHANGED");
  expect(p.send).toHaveBeenCalledTimes(1);
});
it("a timed out quote request never reaches a wallet", async () => {
  const p = port();
  vi.mocked(p.review).mockRejectedValue(Error("TIMEOUT"));
  await expect(runFastflow(p)).rejects.toThrow("TIMEOUT");
  expect(p.send).not.toHaveBeenCalled();
});
it("bounded polling leaves approval pending without a second send", async () => {
  const p = port(review("APPROVE"));
  vi.mocked(p.track).mockResolvedValue({
    state: "PENDING",
    steps: { APPROVE: { state: "PENDING" } },
  });
  expect(await runFastflow(p)).toBe("APPROVAL_PENDING");
  expect(p.send).toHaveBeenCalledTimes(1);
});
