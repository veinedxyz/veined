// G7 pilot local server: binds 127.0.0.1 only, serves three static same-origin files and a small POST-only JSON
// API. Every response is no-store and unframeable (CSP frame-ancestors 'none'); there are no CORS headers at all.
// API requests need the exact Host and Origin (DNS-rebinding and cross-site defence), the per-run bearer token and
// the per-claim CSRF token. The server never talks to a wallet: the browser page alone makes the single wallet
// request, after the owner's click, with parameters the server released exactly once.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HOST } from "./policy";
import { PilotError, WALLET_OUTCOMES, type PilotSession } from "./session";

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  expires: "0",
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()",
};

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "client");
const ASSETS = [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ["/app.css", "app.css", "text/css; charset=utf-8"],
] as const;
export function loadAssets() {
  return new Map<
    string,
    { file: string; type: string; body: Buffer; sha256: string }
  >(
    ASSETS.map(([route, file, type]) => {
      const body = readFileSync(join(CLIENT_DIR, file));
      return [
        route,
        {
          file,
          type,
          body,
          sha256: createHash("sha256").update(body).digest("hex"),
        },
      ];
    }),
  );
}

const addressLike = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const wallet = z.strictObject({
  account: addressLike,
  chainId: z.string().regex(/^0x[0-9a-fA-F]{1,8}$/),
});
const BODIES = {
  claim: z.strictObject({}),
  state: z.strictObject({}),
  refresh: z.strictObject({}),
  final: z.strictObject({
    intentDigest: digest,
    confirmations: z.strictObject({
      scope: z.boolean(),
      trust: z.boolean(),
      phrase: z.string().max(64),
    }),
    wallet,
  }),
  arm: z.strictObject({
    candidateId: z.string().regex(/^cand-[0-9a-f]{16}$/),
    intentDigest: digest,
    wallet,
  }),
  "wallet-result": z.strictObject({
    armId: z.string().regex(/^arm-[0-9a-f]{16}$/),
    outcome: z.enum(WALLET_OUTCOMES),
    txHash: z.string().max(80).optional(),
    errorCode: z.union([z.number(), z.string().max(40), z.null()]).optional(),
    errorMessage: z.string().max(300).nullable().optional(),
    quoteAgeAtWalletRequestMs: z.number().nullable().optional(),
    walletRequestAt: z.number().nullable().optional(),
  }),
  "wallet-attempt": z.strictObject({
    armId: z.string().regex(/^arm-[0-9a-f]{16}$/),
  }),
} as const;
type Route = keyof typeof BODIES;
const MAX_BODY = 16 * 1024;

const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
function send(res: ServerResponse, status: number, body: unknown) {
  const text = json(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    // Oversized bodies are drained and discarded (never buffered), then answered with 413.
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
      else chunks.length = 0;
    });
    req.on("end", () =>
      size > MAX_BODY
        ? reject(new PilotError("BODY_TOO_LARGE", 413))
        : resolve(Buffer.concat(chunks).toString("utf8")),
    );
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  send(res, status, body);
}

// The pilot JSON API, mountable under any path prefix (standalone page: "/api/", product: "/g7-pilot/api/").
// The caller has already enforced the exact Host. Every route is POST-only, needs the exact Origin, JSON, the
// per-run bearer token and (except `claim`) the per-claim CSRF token; bodies are strict schemas; no CORS.
export function pilotApi(
  session: PilotSession,
  journal: (event: string, data?: Record<string, unknown>) => void,
  prefix: string,
) {
  return async (req: IncomingMessage, res: ServerResponse, origin: string) => {
    // Early refusals drain (and discard) any request body so the connection closes cleanly.
    const refuse = (status: number, error: string) => {
      req.resume();
      res.setHeader("connection", "close");
      send(res, status, { error });
    };
    try {
      const path = (req.url ?? "").split("?")[0];
      if (req.method !== "POST") return refuse(405, "METHOD_NOT_ALLOWED");
      const route = path.startsWith(prefix)
        ? (path.slice(prefix.length) as Route)
        : null;
      if (!route || !(route in BODIES)) return refuse(404, "NOT_FOUND");
      if (req.headers.origin !== origin)
        return refuse(403, "ORIGIN_NOT_ALLOWED");
      const site = req.headers["sec-fetch-site"];
      if (site !== undefined && site !== "same-origin")
        return refuse(403, "CROSS_SITE_REQUEST");
      if (
        !/^application\/json(;\s*charset=utf-8)?$/i.test(
          String(req.headers["content-type"] ?? ""),
        )
      )
        return refuse(415, "JSON_REQUIRED");
      const auth = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(
        String(req.headers.authorization ?? ""),
      );
      if (!session.checkToken(auth ? auth[1] : null))
        return refuse(401, "UNAUTHORIZED");
      if (
        route !== "claim" &&
        !session.checkCsrf(String(req.headers["x-g7-csrf"] ?? "") || null)
      )
        return refuse(403, "CSRF");
      let parsed: unknown;
      try {
        parsed = JSON.parse((await readBody(req)) || "{}");
      } catch (e) {
        if (e instanceof PilotError) throw e;
        return send(res, 400, { error: "INVALID_JSON" });
      }
      const body = BODIES[route].safeParse(parsed);
      if (!body.success) return send(res, 400, { error: "INVALID_BODY" });
      journal("API", { route });
      switch (route) {
        case "claim":
          return send(res, 200, session.claim());
        case "state":
          return send(res, 200, session.snapshot());
        case "refresh":
          return send(res, 200, await session.refresh());
        case "final":
          return send(
            res,
            200,
            await session.final(body.data as z.infer<(typeof BODIES)["final"]>),
          );
        case "arm":
          return send(
            res,
            200,
            session.arm(body.data as z.infer<(typeof BODIES)["arm"]>),
          );
        case "wallet-result":
          return send(
            res,
            200,
            session.walletOutcome(
              body.data as z.infer<(typeof BODIES)["wallet-result"]>,
            ),
          );
        case "wallet-attempt":
          return send(
            res,
            200,
            session.walletAttempt(
              (body.data as z.infer<(typeof BODIES)["wallet-attempt"]>).armId,
            ),
          );
      }
    } catch (e) {
      if (e instanceof PilotError)
        return send(res, e.status, {
          error: e.code,
          state: session.snapshot(),
        });
      journal("SERVER_ERROR", {
        error: String((e as Error)?.message ?? e).slice(0, 300),
      });
      return send(res, 500, { error: "INTERNAL" });
    }
  };
}

// Binds 127.0.0.1 only and returns the exact Host/Origin every request must carry.
export async function listenLoopback(server: Server, port: number) {
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: HOST, port, exclusive: true }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== HOST)
    throw new Error(`NOT_BOUND_TO_LOOPBACK ${JSON.stringify(address)}`);
  const host = `${HOST}:${address.port}`;
  return { port: address.port, host, origin: `http://${host}` };
}

export interface PilotServer {
  server: Server;
  port: number;
  origin: string;
  close(): Promise<void>;
}
// Standalone technical page (dry-run diagnostics / fixture tests): three static files + the API under /api/.
export async function startPilotServer(
  session: PilotSession,
  port: number,
  journal: (event: string, data?: Record<string, unknown>) => void,
): Promise<PilotServer> {
  const assets = loadAssets();
  const api = pilotApi(session, journal, "/api/");
  let origin = "";
  let host = "";
  const server = createServer((req, res) => {
    // Exact Host: a rebinding DNS name pointing at 127.0.0.1 is refused before anything else.
    if (req.headers.host !== host) {
      req.resume();
      res.setHeader("connection", "close");
      return send(res, 421, { error: "HOST_NOT_ALLOWED" });
    }
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" || req.method === "HEAD") {
      const asset = assets.get(path);
      if (!asset) return send(res, 404, { error: "NOT_FOUND" });
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": asset.type,
        "content-length": asset.body.length,
      });
      return res.end(req.method === "HEAD" ? undefined : asset.body);
    }
    void api(req, res, origin);
  });
  const bound = await listenLoopback(server, port);
  host = bound.host;
  origin = bound.origin;
  journal("LISTENING", {
    origin,
    assets: Object.fromEntries(
      [...assets].map(([r, a]) => [r, { file: a.file, sha256: a.sha256 }]),
    ),
  });
  return {
    server,
    port: bound.port,
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
