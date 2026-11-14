import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const controls = vi.hoisted(() => ({
  status: 200,
  body: '{"ok":true}',
  silent: false,
  addresses: [{ address: "1.1.1.1", family: 4 }],
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => controls.addresses),
}));
vi.mock("node:https", () => ({
  request: vi.fn(
    (
      _url: unknown,
      _options: unknown,
      callback: (
        res: EventEmitter & { statusCode: number; resume: () => void },
      ) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: () => {
          if (controls.silent) return;
          queueMicrotask(() => {
            const res = Object.assign(new EventEmitter(), {
              statusCode: controls.status,
              resume: () => {},
            });
            callback(res);
            res.emit("data", Buffer.from(controls.body));
            res.emit("end");
            req.emit("close");
          });
        },
        destroy: (error: Error) => {
          req.emit("error", error);
          req.emit("close");
        },
      });
      return req;
    },
  ),
}));
import { boundedRequest, ENDPOINTS, rpc } from "../../src/adapters/read-only";
beforeEach(() => {
  controls.status = 200;
  controls.body = '{"ok":true}';
  controls.silent = false;
  controls.addresses = [{ address: "1.1.1.1", family: 4 }];
});
afterEach(() => vi.useRealTimers());
it("valid allowlisted read response is decoded", async () =>
  expect(await boundedRequest(ENDPOINTS.bsc)).toEqual({ ok: true }));
it("R1/F1 history pagination stops at three typed owner pages", async () => {
  const body = {
    owner: "0x3333333333333333333333333333333333333333",
    page: 3,
    size: 20,
    sort: "desc",
  };
  await expect(
    boundedRequest("https://bridge-api.crosstoken.io/bridge/history", body),
  ).resolves.toEqual({ ok: true });
  await expect(
    boundedRequest("https://bridge-api.crosstoken.io/bridge/history", {
      ...body,
      page: 4,
    }),
  ).rejects.toThrow();
});
it.each([429, 302])(
  "Q01/X01 rejects upstream %s and does not follow redirect",
  async (status) => {
    controls.status = status;
    await expect(boundedRequest(ENDPOINTS.bsc)).rejects.toThrow(
      status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
    );
  },
);
it("Q01 malformed JSON never falls back to local data", async () => {
  controls.body = "<html>bad response</html>";
  await expect(boundedRequest(ENDPOINTS.one)).rejects.toThrow(
    "INVALID_RESPONSE",
  );
});
it("X01 DNS rebinding/private target is rejected before request", async () => {
  controls.addresses = [{ address: "169.254.169.254", family: 4 }];
  await expect(boundedRequest(ENDPOINTS.one)).rejects.toThrow("UNSAFE_DNS");
});
it("X02 response size is bounded", async () => {
  controls.body = "x".repeat(1048577);
  await expect(boundedRequest(ENDPOINTS.one)).rejects.toThrow(
    "RESPONSE_TOO_LARGE",
  );
});
it("Q01 timeout is bounded without retry or false success", async () => {
  vi.useFakeTimers();
  controls.silent = true;
  const result = expect(boundedRequest(ENDPOINTS.one)).rejects.toThrow(
    "UPSTREAM_TIMEOUT",
  );
  await vi.advanceTimersByTimeAsync(8001);
  await result;
});
it("R1/F1 JSON-RPC error without result retains its internal cause and never becomes an invalid user request", async () => {
  const error = {
    code: -32000,
    message: "insufficient funds for gas * price + value",
  };
  controls.body = JSON.stringify({ jsonrpc: "2.0", id: 1, error });
  await expect(rpc("one", "eth_chainId")).rejects.toMatchObject({
    code: "RPC_ERROR",
    cause: error,
  });
  controls.body = JSON.stringify({ jsonrpc: "2.0", id: 1 });
  await expect(rpc("one", "eth_chainId")).rejects.toThrow("INVALID_RESPONSE");
});
