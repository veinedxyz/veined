import { afterEach, describe, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { MODES, SwapError, type QuoteEvent } from "../../src/swap/model";
import { QuoteCoordinator } from "../../src/swap/server/coordinator";
import { swapIntent, swapQuote } from "../fixtures/swap";
import {
  protectedBaselineMismatch,
  releaseMetrics,
} from "../../src/release/monitor";
import { registry } from "../../src/data/observability/metrics";
import { assertReleaseStartup, releaseFile } from "../../src/release/startup";
afterEach(() => vi.unstubAllEnvs());
describe("V116 synthetic chaos; no network and no public writes", () => {
  it.each(MODES)(
    "%s outage produces a bounded failure and no invented route",
    async (mode) => {
      const events: QuoteEvent[] = [];
      const c = new QuoteCoordinator([
        {
          mode,
          provider: "Uniswap",
          chains: ["1"],
          exactOut: true,
          quote: async () => {
            throw new SwapError("PROVIDER_UNAVAILABLE");
          },
        },
      ]);
      await c.compete(swapIntent(), new AbortController().signal, (e) =>
        events.push(e),
      );
      expect(events.filter((e) => e.type === "quote")).toEqual([]);
      expect(events).toContainEqual({
        type: "health",
        health: expect.objectContaining({
          mode,
          status: "PROVIDER_UNAVAILABLE",
          quoteCount: 0,
        }),
      });
      expect(events.at(-1)?.type).toBe("settled");
    },
  );
  it("all-provider failure produces no financial output", async () => {
    const events: QuoteEvent[] = [];
    const c = new QuoteCoordinator(
      MODES.map((mode) => ({
        mode,
        provider: "Uniswap" as const,
        chains: ["1"],
        exactOut: true,
        quote: async () => {
          throw new SwapError("PROVIDER_TIMEOUT");
        },
      })),
    );
    await c.compete(swapIntent(), new AbortController().signal, (e) =>
      events.push(e),
    );
    expect(events.filter((e) => e.type === "quote")).toHaveLength(0);
    expect(events.filter((e) => e.type === "health")).toHaveLength(9);
  });
  it("kill after subscription but before dispatch sends zero requests", async () => {
    const quote = vi.fn(),
      c = new QuoteCoordinator([
        {
          mode: "UNISWAP",
          provider: "Uniswap",
          chains: ["1"],
          exactOut: true,
          quote,
        },
      ]);
    await c.compete(swapIntent(), new AbortController().signal, (e) => {
      if (e.type === "providers")
        vi.stubEnv("SWAP_DISABLED_PROVIDERS", "UNISWAP");
    });
    expect(quote).not.toHaveBeenCalled();
  });
  it("kill while an upstream response is pending suppresses that quote", async () => {
    const intent = swapIntent(),
      events: QuoteEvent[] = [];
    const c = new QuoteCoordinator([
      {
        mode: "UNISWAP",
        provider: "Uniswap",
        chains: ["1"],
        exactOut: true,
        quote: async () => {
          vi.stubEnv("SWAP_DISABLED_PROVIDERS", "UNISWAP");
          return [swapQuote(intent)];
        },
      },
    ]);
    await c.compete(intent, new AbortController().signal, (e) =>
      events.push(e),
    );
    expect(events.filter((e) => e.type === "quote")).toHaveLength(0);
  });
  it("protected drift and a self-rebaselined manifest both trigger the monitor", () => {
    const root = mkdtempSync(join(tmpdir(), "otherbridge-v116-baseline-"));
    try {
      const pointer = readFileSync(
          ".otherbridge/g7-protected-baseline.txt",
          "utf8",
        ).trim(),
        baseline = JSON.parse(readFileSync(pointer, "utf8"));
      for (const p of [
        ".otherbridge/g7-protected-baseline.txt",
        pointer,
        ...Object.keys(baseline),
      ]) {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        copyFileSync(p, join(root, p));
      }
      expect(protectedBaselineMismatch(root)).toBe(0);
      writeFileSync(
        join(root, "AGENTS.md"),
        "synthetic drift in disposable copy",
      );
      expect(protectedBaselineMismatch(root)).toBe(1);
      baseline["AGENTS.md"] = "0".repeat(64);
      writeFileSync(join(root, pointer), JSON.stringify(baseline));
      expect(protectedBaselineMismatch(root)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("dependency monitor detects a forged summary, changed lock and changed raw audit", () => {
    const root = mkdtempSync(join(tmpdir(), "otherbridge-v116-audit-"));
    try {
      const status = JSON.parse(
        readFileSync("release/dependency-audit-status.json", "utf8"),
      );
      for (const p of [
        "release/dependency-audit-status.json",
        ...Object.values(status.bindings).flatMap((b) => {
          const x = b as { file: string; lock: string };
          return [x.file, x.lock];
        }),
      ]) {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        copyFileSync(p, join(root, p));
      }
      status.at = new Date().toISOString();
      writeFileSync(
        join(root, "release/dependency-audit-status.json"),
        JSON.stringify(status),
      );
      const value = () => {
        releaseMetrics(root);
        return registry().snapshot().counters[
          "security_dependency_audit_regression{}"
        ];
      };
      expect(value()).toBe(0);
      writeFileSync(join(root, "pnpm-lock.yaml"), "changed lock");
      expect(value()).toBe(1);
      copyFileSync("pnpm-lock.yaml", join(root, "pnpm-lock.yaml"));
      writeFileSync(join(root, status.bindings.root.file), "{}");
      expect(value()).toBe(1);
      copyFileSync(
        status.bindings.root.file,
        join(root, status.bindings.root.file),
      );
      status.root.critical = 1;
      writeFileSync(
        join(root, "release/dependency-audit-status.json"),
        JSON.stringify(status),
      );
      expect(value()).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("fake execution=true refuses process startup", () =>
    expect(() =>
      assertReleaseStartup({
        OTHERBRIDGE_DEPLOYMENT_ENV: "staging",
        SWAP_EXECUTION_ENABLED: "true",
      }),
    ).toThrow("EXECUTION_FLAG_FORBIDDEN"));
  it.each(["../.env.local", "D:/outside", "/etc/passwd"])(
    "release file path %s is refused",
    (p) =>
      expect(() => releaseFile(process.cwd(), p)).toThrow(
        "RELEASE_PATH_INVALID",
      ),
  );
});
