// V1.21.1 LOW_MEMORY_SERIAL: owner-authorized, explicit-only validation profile. Only the start admission is lower;
// the standard profile and every runtime guard limit stay unchanged. E2E accepts only standard and LOW_MEMORY_SERIAL.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const memory = readFileSync("scripts/lib/test-memory.mjs", "utf8");
describe("V1.21.1 LOW_MEMORY_SERIAL validation profile", () => {
  it("keeps the standard profile unchanged", () => {
    expect(memory).toMatch(
      /standard: \{\s+minimumFreeGb: 5,\s+minimumCommitHeadroomGb: 8,\s+heapMiB: 3072,\s+ownedGiB: 4,\s+\},/,
    );
  });
  it("lowers only the start threshold to 3 GiB; commit headroom, heap and owned cap equal standard", () => {
    expect(memory).toMatch(
      /LOW_MEMORY_SERIAL: \{\s+minimumFreeGb: 3,\s+minimumCommitHeadroomGb: 8,\s+heapMiB: 3072,\s+ownedGiB: 4,\s+\},/,
    );
  });
  it("is selected only explicitly by owned runs and E2E chunks; the runtime guards are unchanged", () => {
    expect(readFileSync("scripts/v1201-owned-run.mjs", "utf8")).toMatch(
      /process\.env\.V1201_MEMORY_PROFILE \?\? "standard"/,
    );
    const runner = readFileSync("scripts/e2e-chunks.mjs", "utf8");
    expect(runner).toMatch(
      /process\.env\.OTHERBRIDGE_E2E_MEMORY_PROFILE \?\? "standard"/,
    );
    expect(runner).toMatch(/waitForHostMemory\(dir, e2eMemoryProfile\)/);
    expect(runner).toMatch(/guardGb: guard,\s+ownedLimitGb: 4,/);
  });
  it("E2E accepts exactly standard and LOW_MEMORY_SERIAL; small, checks and focused stay defined for their own runners", () => {
    const runner = readFileSync("scripts/e2e-chunks.mjs", "utf8");
    expect(runner).toMatch(
      /const E2E_MEMORY_PROFILES = Object\.freeze\(\["standard", "LOW_MEMORY_SERIAL"\]\);/,
    );
    expect(runner).toMatch(
      /!E2E_MEMORY_PROFILES\.includes\(e2eMemoryProfile\)/,
    );
    for (const name of ["small", "checks", "focused"])
      expect(memory).toMatch(new RegExp(`\\b${name}: \\{`));
    expect(readFileSync("scripts/v1201-owned-run.mjs", "utf8")).toMatch(
      /Object\.hasOwn\(memoryProfiles, profile\)/,
    );
  });
  it.each(["small", "checks", "focused", "unknown", "low_memory_serial"])(
    "E2E rejects the %s profile before any E2E work starts",
    (profile) => {
      const dir = mkdtempSync(join(tmpdir(), "e2e-profile-"));
      try {
        const out = join(dir, "out");
        const r = spawnSync(
          process.execPath,
          ["scripts/e2e-chunks.mjs", "plan", out, "12"],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              OTHERBRIDGE_E2E_ORIGIN: "http://127.0.0.1:3161",
              OTHERBRIDGE_E2E_MEMORY_PROFILE: profile,
            },
          },
        );
        expect(r.status).not.toBe(0);
        expect(r.stderr).toMatch(/MEMORY_PROFILE_INVALID/);
        expect(existsSync(out)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
