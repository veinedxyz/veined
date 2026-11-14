import { afterEach, expect, it, vi } from "vitest";
vi.mock("../../src/adapters/read-only", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/adapters/read-only")>();
  const { BridgeError } = await import("../../src/core/model");
  return {
    ...real,
    rpc: async () => {
      throw new BridgeError("UPSTREAM_UNAVAILABLE");
    },
  };
});
import { NextRequest } from "next/server";
import { POST } from "../../src/app/api/bridge/route";
import { currentMode } from "../../src/server/config";
import { boundedRequest } from "../../src/adapters/read-only";
afterEach(() => vi.unstubAllEnvs());
it("X05 production never exposes fixture mode even if requested", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("OTHERBRIDGE_MODE", "local-test");
  expect(currentMode()).toBe("mainnet-readonly");
});
it("X01 hostile origin and arbitrary proxy fields are rejected", async () => {
  const request = (body: unknown, origin: string) =>
    new NextRequest("http://127.0.0.1:3100/api/bridge", {
      method: "POST",
      headers: {
        Origin: origin,
        Host: "127.0.0.1:3100",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  expect(
    (await POST(request({ action: "health" }, "https://attacker.example")))
      .status,
  ).toBe(422);
  expect(
    (
      await POST(
        request(
          { action: "proxy", url: "http://169.254.169.254" },
          "http://127.0.0.1:3100",
        ),
      )
    ).status,
  ).toBe(422);
  await expect(boundedRequest("https://127.0.0.1")).rejects.toThrow(
    "HOST_NOT_ALLOWED",
  );
  await expect(boundedRequest("https://attacker.example")).rejects.toThrow(
    "HOST_NOT_ALLOWED",
  );
});
it("live quote upstream failure remains fail closed rather than switching to fixture", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("OTHERBRIDGE_MODE", "local-test");
  const r = await POST(
    new NextRequest("http://127.0.0.1:3100/api/bridge", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:3100", Host: "127.0.0.1:3100" },
      body: JSON.stringify({
        action: "quote",
        amount: "1",
        account: "0x3333333333333333333333333333333333333333",
      }),
    }),
  );
  expect(r.status).toBe(422);
  expect(await r.json()).toEqual({ error: "UPSTREAM_UNAVAILABLE" });
});
