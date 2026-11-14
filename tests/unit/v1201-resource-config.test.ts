import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import config, {
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from "../../next.config";

const development = "phase-development-server";
beforeEach(() => {
  vi.stubEnv("OTHERBRIDGE_BUILD_PROFILE", "");
  vi.stubEnv("OTHERBRIDGE_G7_LOCAL_PILOT", "");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("OTHERBRIDGE_MODE", "local-test");
  vi.stubEnv("OTHERBRIDGE_E2E_ISOLATED", "1");
});
afterEach(() => vi.unstubAllEnvs());

describe("V1201 compiler memory policy is isolated to E2E development", () => {
  it("reclaims the persisted compiler cache in the marked test server", () => {
    expect(config(development).experimental).toEqual({
      turbopackMemoryEviction: "full",
    });
  });
  it.each([
    ["NODE_ENV", "production"],
    ["OTHERBRIDGE_MODE", "mainnet-readonly"],
    ["OTHERBRIDGE_E2E_ISOLATED", ""],
  ])("does not activate without %s's test value", (name, value) => {
    vi.stubEnv(name, value);
    expect(config(development).experimental).toBeUndefined();
  });
  it.each([PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER])(
    "keeps the complete %s configuration and security headers identical even with test markers",
    async (phase) => {
      const marked = config(phase);
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("OTHERBRIDGE_MODE", "mainnet-readonly");
      vi.stubEnv("OTHERBRIDGE_E2E_ISOLATED", "");
      const ordinary = config(phase);
      const { headers: markedHeaders, ...markedOptions } = marked;
      const { headers: ordinaryHeaders, ...ordinaryOptions } = ordinary;
      expect(markedOptions).toEqual(ordinaryOptions);
      expect(marked.experimental).toBeUndefined();
      expect(await markedHeaders?.()).toEqual(await ordinaryHeaders?.());
    },
  );
});
