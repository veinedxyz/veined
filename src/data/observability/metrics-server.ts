import { createServer, type Server } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
// V1.5 internal-only metrics listener. Separate from every public listener; never served on the
// public Data API or the app port. Bearer token required (constant-time compare); GET /metrics only.
export interface MetricsListenerConfig {
  enabled: boolean;
  host: string;
  port: number;
  token: string | null;
  errors: string[];
}
const LOOPBACK = new Set(["127.0.0.1", "::1"]);
export function metricsListenerConfig(
  env: Record<string, string | undefined> = process.env,
  portVar = "OTHERBRIDGE_METRICS_PORT",
): MetricsListenerConfig {
  const errors: string[] = [];
  const raw = env[portVar];
  if (raw === undefined || raw === "")
    return { enabled: false, host: "127.0.0.1", port: 0, token: null, errors };
  const port = /^\d{4,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1024 && port <= 65535)) errors.push(portVar);
  const host = env.OTHERBRIDGE_METRICS_HOST ?? "127.0.0.1";
  if (!LOOPBACK.has(host) && host !== "0.0.0.0")
    errors.push("OTHERBRIDGE_METRICS_HOST");
  const token = env.OTHERBRIDGE_METRICS_TOKEN ?? "";
  // A token is always required; a non-loopback bind (container network) without it is refused.
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token))
    errors.push("OTHERBRIDGE_METRICS_TOKEN");
  return {
    enabled: errors.length === 0,
    host,
    port,
    token: token || null,
    errors,
  };
}
const digest = (v: string) => createHash("sha256").update(v).digest();
export function authorized(header: string | undefined, token: string) {
  const m = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(header ?? "");
  // Hashing first gives equal-length buffers, so the comparison never leaks the token length.
  return !!m && timingSafeEqual(digest(m[1]), digest(token));
}
export function startMetricsServer(
  config: MetricsListenerConfig,
  collect: () => Promise<string> | string,
): Server {
  if (!config.enabled || !config.token)
    throw Error(`METRICS_CONFIG_INVALID:${config.errors.join(",")}`);
  const token = config.token;
  const server = createServer(async (req, res) => {
    const deny = (status: number) => {
      res.writeHead(status, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      res.end(
        status === 401
          ? "unauthorized\n"
          : status === 405
            ? "method not allowed\n"
            : "not found\n",
      );
    };
    if (req.method !== "GET") return deny(405);
    if ((req.url ?? "").split("?")[0] !== "/metrics") return deny(404);
    if (!authorized(req.headers.authorization, token)) return deny(401);
    try {
      const body = await collect();
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(body);
    } catch {
      res.writeHead(500, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      res.end("collect failed\n");
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 30;
  server.listen(config.port, config.host);
  return server;
}
