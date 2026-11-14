import { createHash } from "node:crypto";
// Static, script-free local API docs rendered from the OpenAPI document. All text is escaped.
// V1.5 CSP: the only inline content is this constant stylesheet, allowed by its exact SHA-256 hash
// (no 'unsafe-inline'); no scripts at all.
export const DOCS_CSS = `
:root{color-scheme:light dark;--bg:#f6f6f3;--fg:#1b1c19;--muted:#5c5e57;--card:#fff;--line:#d9d9d2;--accent:#3d5a40}
@media (prefers-color-scheme:dark){:root{--bg:#141513;--fg:#ecece6;--muted:#a3a59c;--card:#1d1e1b;--line:#33352f;--accent:#9cc39f}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 16px}
h1{font-size:28px;margin:0 0 6px}section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
h2{font-size:16px;margin:0 0 6px;overflow-wrap:anywhere}.verb{color:var(--accent);font-weight:700}.meta,small{color:var(--muted)}
code{font-family:ui-monospace,monospace}pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;overflow-x:auto}
.banner{border-left:4px solid var(--accent);padding:8px 12px;background:var(--card)}
`;
export const DOCS_CSS_HASH = `sha256-${createHash("sha256").update(DOCS_CSS).digest("base64")}`;
export const DOCS_CSP = `default-src 'none'; style-src '${DOCS_CSS_HASH}'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const esc = (v: unknown) =>
  String(v).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
interface Op {
  summary: string;
  description: string;
  parameters?: {
    name: string;
    in: string;
    required: boolean;
    description: string;
  }[];
}
export function docsPage(doc: {
  info: { title: string; version: string; description: string };
  paths: Record<string, { get: Op }>;
}) {
  const rows = Object.entries(doc.paths)
    .map(([path, item]) => {
      const op = item.get;
      const params = (op.parameters ?? [])
        .map(
          (p) =>
            `<li><code>${esc(p.name)}</code> <small>${esc(p.in)}${p.required ? ", required" : ""}</small> — ${esc(p.description)}</li>`,
        )
        .join("");
      return `<section><h2><span class="verb">GET</span> <code>${esc(path)}</code></h2><p>${esc(op.summary)}</p><p class="meta">${esc(op.description)}</p>${params ? `<ul>${params}</ul>` : ""}</section>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(doc.info.title)}</title><style>${DOCS_CSS}</style></head><body><main><h1>${esc(doc.info.title)} <small>v${esc(doc.info.version)}</small></h1>
<p class="banner">Local loopback documentation. Not a public launch. Billing disabled. Read-only GET endpoints only.</p>
<p>${esc(doc.info.description)}</p>
<pre>curl -H "Authorization: Bearer ob_live_&lt;prefix&gt;_&lt;secret&gt;" http://127.0.0.1:3200/v1/chains</pre>
<p class="meta">API keys are server-side secrets; never place them in browser code. Machine-readable spec: <code>/v1/openapi.json</code>.</p>
${rows}</main></body></html>`;
}
