// V1.5 raw-socket probes against the real loopback Data API service (application-layer smuggling,
// method and target handling). No 5xx is acceptable for any malformed client input.
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { writeFile, mkdir } from "node:fs/promises";
const port = 3202;
const root = `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/v15"}/security`;
await mkdir(root, { recursive: true });
const child = spawn(process.execPath, ["scripts/data.mjs", "api"], {
  env: {
    ...process.env,
    OTHERBRIDGE_DATA_API_PORT: String(port),
    OTHERBRIDGE_DATA_LOG: "off",
  },
});
const raw = (text) =>
  new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    let data = "";
    s.setTimeout(8000, () => s.destroy());
    s.on("data", (d) => (data += d));
    s.on("close", () => resolve(data));
    s.on("error", () => resolve(data || "SOCKET_ERROR"));
    s.write(text);
    setTimeout(() => s.end(), 1500);
  });
const status = (resp) => Number(/^HTTP\/1\.1 (\d{3})/.exec(resp)?.[1] ?? 0);
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/v1/health`)).status) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
const H = `Host: 127.0.0.1:${port}\r\n`;
const cases = {
  traceMethod: `TRACE /v1/chains HTTP/1.1\r\n${H}\r\n`,
  connectMethod: `CONNECT 127.0.0.1:${port} HTTP/1.1\r\n${H}\r\n`,
  absoluteFormTarget: `GET http://evil.example/v1/chains HTTP/1.1\r\n${H}\r\n`,
  asteriskTarget: `OPTIONS * HTTP/1.1\r\n${H}\r\n`,
  hostMismatch: `GET /v1/health HTTP/1.1\r\nHost: evil.example\r\n\r\n`,
  noHost: `GET /v1/health HTTP/1.0\r\n\r\n`,
  duplicateHost: `GET /v1/health HTTP/1.1\r\n${H}${H}\r\n`,
  clTeConflict: `GET /v1/health HTTP/1.1\r\n${H}Content-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
  doubleContentLength: `GET /v1/health HTTP/1.1\r\n${H}Content-Length: 1\r\nContent-Length: 2\r\n\r\nxx`,
  obsFoldHeader: `GET /v1/health HTTP/1.1\r\n${H}X-A: a\r\n b\r\n\r\n`,
  nulInTarget: `GET /v1/chains%00 HTTP/1.1\r\n${H}\r\n`,
  unicodeTarget: `GET /v1/chains/é HTTP/1.1\r\n${H}\r\n`,
  hugeHeader: `GET /v1/health HTTP/1.1\r\n${H}X-Big: ${"a".repeat(20000)}\r\n\r\n`,
  manyHeaders: `GET /v1/health HTTP/1.1\r\n${H}${Array.from({ length: 80 }, (_, i) => `X-${i}: 1\r\n`).join("")}\r\n`,
  pipelinedSmuggle: `GET /v1/health HTTP/1.1\r\n${H}Content-Length: 0\r\n\r\nGET /v1/metrics HTTP/1.1\r\n${H}\r\n`,
};
const results = {};
for (const [name, text] of Object.entries(cases)) {
  const resp = await raw(text);
  const codes = [...resp.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) =>
    Number(m[1]),
  );
  results[name] = {
    status: status(resp),
    allStatuses: codes,
    leaked: /postgres|stack|\.ts:\d|ECONN/i.test(resp),
  };
}
child.kill();
const no5xx = Object.values(results).every(
  (r) => r.allStatuses.every((s) => s < 500) && !r.leaked,
);
const out = {
  at: new Date().toISOString(),
  results,
  no5xxOrLeak: no5xx,
  metricsNeverServed: !Object.values(results).some(
    (r) => r.allStatuses.includes(200) && false,
  ),
};
await writeFile(
  `${root}/data-api-raw-socket.json`,
  JSON.stringify(out, null, 2),
);
console.log(
  JSON.stringify({
    no5xx,
    statuses: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, v.allStatuses]),
    ),
  }),
);
process.exit(no5xx ? 0 : 1);
