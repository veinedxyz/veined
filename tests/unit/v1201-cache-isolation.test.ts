import { afterEach, beforeEach, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateReproductionCache } from "../../scripts/lib/e2e-cache.mjs";

let temporary: string, root: string;
const owner = { pid: 123, created: "2026-10-27T18:07:35.3855920Z" };
beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "veined-v1201-cache-"));
  root = join(
    temporary,
    ".otherbridge",
    "v1201-repro",
    "2026-10-27T18-07-35-431Z",
  );
  mkdirSync(root, { recursive: true });
});
afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});
const rotate = (overrides = {}) =>
  rotateReproductionCache({
    directory: root,
    cwd: root,
    expectedOwner: owner,
    currentOwner: owner,
    ...overrides,
  });

it("preserves the prior dev cache and production output while making the next cache fresh", () => {
  mkdirSync(join(root, ".next", "dev", "cache"), { recursive: true });
  writeFileSync(join(root, ".next", "dev", "cache", "data"), "prior dev");
  writeFileSync(join(root, ".next", "BUILD_ID"), "production");
  const receipt = rotate();
  expect(receipt.rotated).toBe(true);
  expect(receipt.deletedFiles).toBe(0);
  expect(receipt.freshDevCache).toBe(true);
  if (!receipt.destination) throw Error("PRESERVED_CACHE_DESTINATION_REQUIRED");
  expect(readFileSync(join(receipt.destination, "cache", "data"), "utf8")).toBe(
    "prior dev",
  );
  expect(readFileSync(join(root, ".next", "BUILD_ID"), "utf8")).toBe(
    "production",
  );
});
it("accepts a newly created reproduction with no dev cache", () => {
  expect(rotate()).toMatchObject({ rotated: false, freshDevCache: true });
});
it("refuses another current workspace", () => {
  expect(() => rotate({ cwd: temporary })).toThrow(
    "OWNED_REPRODUCTION_CACHE_ROOT_REQUIRED",
  );
});
it("refuses an ordinary workspace even when its owner is alive", () => {
  expect(() => rotate({ directory: temporary, cwd: temporary })).toThrow(
    "OWNED_REPRODUCTION_CACHE_ROOT_REQUIRED",
  );
});
it.each([null, { ...owner, created: "2026-10-27T18:08:00.0000000Z" }])(
  "refuses a missing or reused owner identity %j",
  (currentOwner) => {
    expect(() => rotate({ currentOwner })).toThrow(
      "LIVE_REPRODUCTION_OWNER_REQUIRED",
    );
  },
);
it.each([".next", ".next/dev"])(
  "refuses a junction at %s without moving its target",
  (link) => {
    const target = join(temporary, "unrelated-cache");
    mkdirSync(target);
    writeFileSync(join(target, "sentinel"), "untouched");
    if (link.includes("/")) mkdirSync(join(root, ".next"));
    symlinkSync(target, join(root, link), "junction");
    expect(() => rotate()).toThrow("REPRODUCTION_CACHE_LINK_REFUSED");
    expect(existsSync(join(root, link))).toBe(true);
    expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("untouched");
  },
);
