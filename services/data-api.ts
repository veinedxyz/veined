// Local loopback Otherbridge Data API service. Not a public launch: binds 127.0.0.1 only and
// refuses to start without its durable datastore (rate limits and auth fail closed).
import { createServer } from "node:http";
import { connect, PostgresStore } from "../src/data/store/postgres";
import { DataPlane } from "../src/data/plane";
import { StoreRateLimiter } from "../src/server/rate-limit";
import {
  createDataApi,
  hostFieldLines,
  preRoute,
} from "../src/data/api/router";
import { routingCore, upstreamRead } from "../src/adapters/routing-core";
import { logEvent } from "../src/data/observability/log";
import { registry } from "../src/data/observability/metrics";
import {
  metricsListenerConfig,
  startMetricsServer,
} from "../src/data/observability/metrics-server";
import { dataConfig } from "../src/data/config";
import { assertReleaseStartup } from "../src/release/startup";
assertReleaseStartup();
const port = Number(process.env.OTHERBRIDGE_DATA_API_PORT ?? 3200);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("OTHERBRIDGE_DATA_API_PORT invalid");
// V1.5: configuration errors (e.g. invalid deployment marker, public mode without durable limiter or
// pseudonym key) stop the service before it listens.
const config = dataConfig();
if (config.errors.length) {
  console.error(`Configuration invalid: ${config.errors.join(",")}`);
  process.exit(1);
}
const metricsConfig = metricsListenerConfig();
if (metricsConfig.errors.length) {
  console.error(
    `Metrics configuration invalid: ${metricsConfig.errors.join(",")}`,
  );
  process.exit(1);
}
const url = process.env.OTHERBRIDGE_DATA_DATABASE_URL;
if (!url) {
  console.error(
    "OTHERBRIDGE_DATA_DATABASE_URL missing; the Data API fails closed without its datastore.",
  );
  process.exit(1);
}
const store = new PostgresStore(
  connect(url, { max: 10, application: "otherbridge-data-api" }),
);
if (!(await store.ping())) {
  console.error("Datastore unreachable; refusing to start (fail closed).");
  process.exit(1);
}
const handle = createDataApi({
  store,
  plane: new DataPlane(store),
  limiter: new StoreRateLimiter(store),
  routing: (signal) => routingCore.listNetworks(signal),
  priceRead: upstreamRead,
});
// The public listener host allowlist: loopback by default; a staging ingress may add exact hosts.
const allowedHosts = new Set([
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  ...(process.env.OTHERBRIDGE_DATA_API_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]{1,120}(:\d{2,5})?$/.test(h)),
]);
const server = createServer(async (req, res) => {
  try {
    // Loopback-only Host check blocks DNS-rebinding style access to the local service.
    if (!allowedHosts.has(req.headers.host ?? "")) {
      res.writeHead(421, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          error: {
            code: "MISDIRECTED",
            message: "Unknown host.",
            requestId: null,
          },
        }),
      );
      return;
    }
    // Only origin-form request targets ("/path?query") with exactly one Host field line are routed;
    // absolute-form/malformed targets or repeated Host lines are a client error, never a 500.
    if (
      !/^\/[!-~]{0,2047}$/.test(req.url ?? "") ||
      hostFieldLines(req.rawHeaders) !== 1
    ) {
      res.writeHead(400, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          error: {
            code: "INVALID_REQUEST",
            message: "The request is invalid.",
            requestId: null,
          },
        }),
      );
      return;
    }
    const refused = preRoute(req.method);
    if (refused) {
      res.writeHead(refused.status, Object.fromEntries(refused.headers));
      res.end(req.method === "HEAD" ? undefined : await refused.text());
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (typeof v === "string") headers.set(k, v);
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const response = await handle(
      new Request(`http://${req.headers.host}${req.url ?? "/"}`, {
        method: req.method,
        headers,
        signal: abort.signal,
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(
      req.method === "HEAD"
        ? undefined
        : Buffer.from(await response.arrayBuffer()),
    );
  } catch {
    if (!res.headersSent)
      res.writeHead(500, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
    res.end(
      JSON.stringify({
        error: {
          code: "INTERNAL",
          message: "Unexpected error.",
          requestId: null,
        },
      }),
    );
  }
});
// Bounded limiter state without an external scheduler (api role may only purge these tables).
const purge = setInterval(
  () => void store.purgeLimiterState(Date.now()).catch(() => {}),
  600000,
);
purge.unref();
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.maxHeadersCount = 50;
const bind = process.env.OTHERBRIDGE_DATA_API_BIND ?? "127.0.0.1";
if (!["127.0.0.1", "0.0.0.0"].includes(bind)) {
  console.error("OTHERBRIDGE_DATA_API_BIND invalid");
  process.exit(1);
}
server.listen(port, bind, () =>
  logEvent("data-api.listening", { port, host: bind }),
);
// Internal-only operational metrics (separate port, bearer token). Never on the public listener.
let dbUp = { at: 0, ok: false };
const metricsServer = metricsConfig.enabled
  ? startMetricsServer(metricsConfig, async () => {
      if (Date.now() - dbUp.at > 5000)
        dbUp = { at: Date.now(), ok: await store.ping() };
      registry().set(
        "data_api_db_pool_up",
        {},
        dbUp.ok ? 1 : 0,
        "Data API datastore ping.",
      );
      registry().set("data_api_up", {}, 1, "Data API process is serving.");
      return registry().render();
    })
  : null;
const shutdown = () => {
  logEvent("data-api.shutdown", {});
  metricsServer?.close();
  server.close(() => void store.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
