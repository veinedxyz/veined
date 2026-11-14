import { afterEach, describe, expect, it, vi } from "vitest";
import { currentMode, localAllowed } from "../../src/server/config";
import {
  isolatedTestHost,
  parseE2EOrigin,
} from "../../src/server/e2e-origin.mjs";
import { checkOrigin, originPolicy } from "../../src/server/origin-policy";
import { contentSecurityPolicy } from "../../src/proxy";

const isolated = {
  NODE_ENV: "development",
  OTHERBRIDGE_MODE: "local-test",
  OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION: "false",
  OTHERBRIDGE_E2E_ISOLATED: "1",
  OTHERBRIDGE_E2E_ORIGIN: "http://127.0.0.1:3126",
};
const configure = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
};
afterEach(() => vi.unstubAllEnvs());

describe("explicit development fixture isolation", () => {
  it("binds one exact loopback host and excludes the former shared port", () => {
    configure(isolated);
    expect(parseE2EOrigin()).toEqual({
      origin: "http://127.0.0.1:3126",
      host: "127.0.0.1:3126",
      port: 3126,
    });
    expect(localAllowed("127.0.0.1:3126")).toBe(true);
    for (const host of [
      "127.0.0.1:3100",
      "localhost:3126",
      "evil.test:3126",
      "",
    ])
      expect(localAllowed(host)).toBe(false);
  });
  it.each([
    "http://127.0.0.1:3100",
    "http://localhost:3126",
    "http://0.0.0.0:3126",
    "http://127.0.0.1.evil.test:3126",
    "https://127.0.0.1:3126",
    "http://127.0.0.1:3126/",
    "http://127.0.0.1:3126/path",
    "http://127.0.0.1:3126?x=1",
    "http://127.0.0.1:3126#x",
    "http://user@127.0.0.1:3126",
    "http://127.0.0.1:999",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:03126",
    "http://127.0.0.1:3126,http://evil.test",
    "*",
    "",
  ])("rejects invalid origin %s without legacy fallback", (origin) => {
    expect(() => parseE2EOrigin(origin)).toThrow();
    configure({ ...isolated, OTHERBRIDGE_E2E_ORIGIN: origin });
    expect(localAllowed("127.0.0.1:3126")).toBe(false);
    expect(localAllowed("127.0.0.1:3100")).toBe(false);
  });
  it.each([
    ["NODE_ENV", "production"],
    ["NODE_ENV", "test"],
    ["NODE_ENV", undefined],
    ["OTHERBRIDGE_MODE", "mainnet-readonly"],
    ["OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION", "true"],
    ["OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION", undefined],
    ["OTHERBRIDGE_E2E_ISOLATED", "0"],
    ["OTHERBRIDGE_E2E_ISOLATED", undefined],
    ["OTHERBRIDGE_E2E_ORIGIN", undefined],
  ])("requires the complete opt-in: %s=%s", (key, value) => {
    const env = { ...isolated, [key!]: value };
    expect(isolatedTestHost(env)).toBeNull();
    configure(env);
    expect(localAllowed("127.0.0.1:3126")).toBe(false);
  });
  it("preserves production mode, CSP and exact-origin rejection with test variables present", () => {
    configure({ ...isolated, NODE_ENV: "production" });
    const before = contentSecurityPolicy("fixed-nonce", false, true);
    expect(currentMode()).toBe("mainnet-readonly");
    for (const host of ["127.0.0.1:3126", "127.0.0.1:3100", "localhost:3100"])
      expect(localAllowed(host)).toBe(false);
    vi.stubEnv("OTHERBRIDGE_E2E_ORIGIN", "http://evil.test:3126");
    expect(contentSecurityPolicy("fixed-nonce", false, true)).toBe(before);
    expect(before).not.toContain("3126");
    expect(before).not.toContain("'unsafe-eval'");
    expect(before).not.toContain("'unsafe-inline'");
    const policy = originPolicy({
      NODE_ENV: "production",
      ...{ OTHERBRIDGE_APP_ORIGINS: "https://veined.example" },
    });
    expect(
      checkOrigin(
        new Request("https://veined.example/api/bridge", {
          headers: {
            origin: isolated.OTHERBRIDGE_E2E_ORIGIN,
            host: "127.0.0.1:3126",
          },
        }),
        policy,
      ),
    ).toBe("ORIGIN_REJECTED");
  });
  it("uses the existing exact-origin policy without admitting other ports or mismatched hosts", () => {
    const policy = originPolicy({
      OTHERBRIDGE_APP_ORIGINS: isolated.OTHERBRIDGE_E2E_ORIGIN,
    });
    const request = (origin: string, host: string) =>
      new Request(`${isolated.OTHERBRIDGE_E2E_ORIGIN}/api/bridge`, {
        headers: { origin, host },
      });
    expect(
      checkOrigin(
        request(isolated.OTHERBRIDGE_E2E_ORIGIN, "127.0.0.1:3126"),
        policy,
      ),
    ).toBe("OK");
    expect(
      checkOrigin(request("http://127.0.0.1:3100", "127.0.0.1:3100"), policy),
    ).toBe("ORIGIN_REJECTED");
    expect(
      checkOrigin(
        request(isolated.OTHERBRIDGE_E2E_ORIGIN, "127.0.0.1:3100"),
        policy,
      ),
    ).toBe("ORIGIN_REJECTED");
  });
});
