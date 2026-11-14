// G13 PROTECTED CHANGE PROPOSAL A — tests of the two root fixes. This file belongs to the PROPOSAL (it is copied into
// the isolated proposal tree only, never into the G13 candidate). SYNTHETIC_TEST_ONLY: packaged catalog snapshots,
// a fake clock, no network.
import { describe, expect, it, vi } from "vitest";
import { RoutingCore } from "../../src/adapters/routing-core";
import snapshot from "../../src/routing/catalog-snapshot.json" with { type: "json" };
import { fallbackRegistry } from "../../src/data/plane";

const read = async (path: string) => {
  if (path === "chains") return snapshot.chains;
  if (path === "tools") return snapshot.tools;
  throw new Error("NOT_REACHED");
};

describe("Proposal A1 — catalog generation (VBA-P1-03 root cause)", () => {
  it("a timed refill with identical content keeps the generation", async () => {
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const p = new RoutingCore(read);
      const a = await p.listNetworks();
      now += 301_000;
      const b = await p.listNetworks();
      expect(b.observedAt).toBe(now);
      expect(b.generation).toBe(a.generation);
    } finally {
      clock.mockRestore();
    }
  });
  it("an explicit refresh always mints a new generation — also while a timed refill is still running", async () => {
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let calls = 0;
      let release = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const p = new RoutingCore(async (path: string) => {
        if (path === "chains" && ++calls === 2) await gate; // the timed refill waits
        return read(path);
      });
      const a = await p.listNetworks();
      now += 301_000;
      const timed = p.listNetworks();
      const explicit = p.listNetworks(undefined, true);
      release();
      const [t, e] = await Promise.all([timed, explicit]);
      expect(e.generation).not.toBe(a.generation);
      expect(
        t.generation === a.generation || t.generation === e.generation,
      ).toBe(true);
      // Under this frozen clock too, a later explicit refresh never repeats the current generation (review R4).
      const sequential = await p.listNetworks(undefined, true);
      expect(sequential.generation).not.toBe(a.generation);
      expect(sequential.generation).not.toBe(e.generation);
    } finally {
      clock.mockRestore();
    }
  });
  it("a call clears only its own pending fill: a later timed call joins the running refresh, whose result is cached", async () => {
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let calls = 0;
      let releaseTimed = () => {};
      let releaseRefresh = () => {};
      const timedGate = new Promise<void>((r) => (releaseTimed = r));
      const refreshGate = new Promise<void>((r) => (releaseRefresh = r));
      const p = new RoutingCore(async (path: string) => {
        if (path === "chains") {
          const n = ++calls;
          if (n === 2) await timedGate;
          if (n === 3) await refreshGate;
        }
        return read(path);
      });
      const a = await p.listNetworks();
      now += 301_000;
      const timed = p.listNetworks();
      const refresh = p.listNetworks(undefined, true);
      releaseTimed();
      await timed; // the older timed fill ends first and must not clear the refresh's pending fill (review R5)
      const joined = p.listNetworks(); // must join the running refresh: no new upstream read
      releaseRefresh();
      const [e, j] = await Promise.all([refresh, joined]);
      expect(calls).toBe(3);
      expect(j.generation).toBe(e.generation);
      expect(e.generation).not.toBe(a.generation);
      expect((await p.listNetworks()).generation).toBe(e.generation); // and the refresh result is the cache
    } finally {
      clock.mockRestore();
    }
  });
  it("an older timed refill that finishes after a newer explicit refresh never overwrites the cache", async () => {
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let calls = 0;
      let release = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const p = new RoutingCore(async (path: string) => {
        if (path === "chains" && ++calls === 2) {
          await gate; // the timed refill is slow and carries OLDER content (one network fewer)
          return { chains: snapshot.chains.chains.slice(1) };
        }
        return read(path);
      });
      const a = await p.listNetworks();
      now += 301_000;
      const timed = p.listNetworks();
      const e = await p.listNetworks(undefined, true); // finishes first
      expect(e.generation).not.toBe(a.generation);
      release();
      const t = await timed;
      expect(t.networks.length).toBe(e.networks.length - 1);
      const after = await p.listNetworks(); // inside the TTL: the cache
      expect(after.generation).toBe(e.generation);
      expect(after.networks.length).toBe(e.networks.length);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("Proposal A2 — native symbol of TVL-catalog networks (VBA-P1-05 root cause)", () => {
  it("networks whose catalog gas token is ETH are named ETH; others keep their own symbol", () => {
    const reg = fallbackRegistry();
    const native = (id: string) =>
      reg.chains.find((c) => c.chainId === id)?.native.symbol;
    expect(native("169")).toBe("ETH");
    expect(native("48900")).toBe("ETH");
    expect(native("8453")).toBe("ETH");
    expect(native("1284")).toBe("GLMR");
  });
});
