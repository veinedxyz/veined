// V1.5 static security/infra policy checks (in addition to scripts/v14-security.mjs supply-chain scan):
// CSP source policy, inline-style sinks, internal-only metrics, compose hardening and loopback-only
// publication, pinned images/actions, provenance release policy, alert/dashboards hygiene, ignore files.
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
const root = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
if (!root) throw Error("OTHERBRIDGE_EVIDENCE_ROOT required");
await mkdir(`${root}/security`, { recursive: true });
const walk = async (d) =>
  (await readdir(d, { withFileTypes: true })).flatMap
    ? (
        await Promise.all(
          (await readdir(d, { withFileTypes: true })).map((e) =>
            e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
          ),
        )
      ).flat()
    : [];
const checks = {};
const add = (name, ok, detail) => (checks[name] = { ok: !!ok, detail });
// 1. CSP source: production branch has no unsafe-inline/unsafe-eval.
const proxy = await readFile("src/proxy.ts", "utf8");
add("csp.style-src-attr-none", /"style-src-attr 'none'"/.test(proxy));
add(
  "csp.production-no-unsafe-inline",
  /development\s*\?\s*"style-src 'self' 'unsafe-inline'"\s*:\s*`style-src 'self' 'nonce-\$\{nonce\}'`/.test(
    proxy,
  ),
);
add(
  "csp.unsafe-eval-dev-only",
  /\$\{development \? " 'unsafe-eval'" : ""\}/.test(proxy),
);
const docs = await readFile("src/data/api/docs-page.ts", "utf8");
const docsCsp = /export const DOCS_CSP = `([^`]*)`/.exec(docs)?.[1] ?? "";
add(
  "csp.docs-hash-pinned",
  /style-src '\$\{DOCS_CSS_HASH\}'/.test(docsCsp) && !/unsafe/.test(docsCsp),
  docsCsp,
);
// 2. UI sinks.
const ui = (await walk("src")).filter((f) => /\.(tsx?|ts)$/.test(f));
const sinks = [];
for (const f of ui) {
  const t = await readFile(f, "utf8");
  if (
    /\sstyle=\{|dangerouslySetInnerHTML|from "next\/image"|setAttribute\(\s*["']style/.test(
      t,
    )
  )
    sinks.push(f);
}
add("ui.no-inline-style-sinks", sinks.length === 0, sinks);
// 3. Metrics never on public listeners.
const router = await readFile("src/data/api/router.ts", "utf8");
add(
  "metrics.not-on-public-api",
  !/pattern:\s*\/\^\\\/v1\\\/metrics/.test(router),
);
const appRoutes = (await walk("src/app")).filter((f) => /route\.ts$/.test(f));
add(
  "metrics.no-app-route",
  !appRoutes.some((f) => /metrics/.test(f)),
  appRoutes,
);
// 4. Compose hardening.
const yaml = async (f) => await readFile(f, "utf8");
for (const f of [
  "infra/staging/compose.yaml",
  "infra/monitoring/compose.yaml",
  "infra/data/compose.yaml",
]) {
  const t = await yaml(f);
  const published = [
    ...t.matchAll(/ports:\s*\[([^\]]*)\]|-\s*"(\d[^"]*:\d+)"/g),
  ]
    .map((m) => (m[1] ?? m[2]).trim())
    .filter(Boolean);
  add(
    `compose.${f}.loopback-only`,
    published.every((p) =>
      p.split(",").every((x) => /"?127\.0\.0\.1:/.test(x.trim())),
    ),
    published,
  );
  add(`compose.${f}.no-latest`, !/:latest\b/.test(t));
}
const staging = await yaml("infra/staging/compose.yaml");
const pgBlock = staging.slice(
  staging.indexOf("  postgres:"),
  staging.indexOf("  migrate:"),
);
add("staging.db-unpublished", !/ports:/.test(pgBlock));
add(
  "staging.backend-internal",
  /backend:\s*\n\s*name: otherbridge-staging-backend\s*\n\s*internal: true/.test(
    staging,
  ),
);
add(
  "staging.hardening-anchor",
  /read_only: true/.test(staging) &&
    /no-new-privileges:true/.test(staging) &&
    /cap_drop: \["ALL"\]/.test(staging),
);
add(
  "staging.images-digest-pinned",
  [...staging.matchAll(/^\s+image: ([^\s&]+)/gm)].every(
    (m) =>
      /@sha256:[0-9a-f]{64}$/.test(m[1]) ||
      m[1].startsWith("otherbridge-staging-app:"),
  ),
  [...staging.matchAll(/^\s+image: ([^\s&]+)/gm)].map((m) => m[1]),
);
add(
  "staging.public-mode-semantics",
  /OTHERBRIDGE_PUBLIC_DEPLOYMENT: "true"/.test(staging) &&
    /OTHERBRIDGE_TRUST_PROXY_HOPS: "1"/.test(staging) &&
    /OTHERBRIDGE_RATE_LIMIT_BACKEND: postgres/.test(staging),
);
const dockerfile = await readFile("infra/staging/Dockerfile", "utf8");
add(
  "image.non-root-frozen",
  /USER node/.test(dockerfile) &&
    /--frozen-lockfile --ignore-scripts --prod/.test(dockerfile) &&
    /@sha256:[0-9a-f]{64}/.test(dockerfile),
);
const dockerignore = await readFile(".dockerignore", "utf8");
add(
  "image.context-excludes-secrets",
  [
    ".env*",
    "evidence",
    ".git",
    "infra/staging/secrets",
    "infra/monitoring/secrets",
    "**/secrets",
    "node_modules",
  ].every((x) => dockerignore.split(/\r?\n/).includes(x)),
);
const gitignore = await readFile(".gitignore", "utf8");
add(
  "git.secrets-ignored",
  [".env*", "infra/staging/secrets/", "infra/monitoring/secrets/"].every((x) =>
    gitignore.includes(x),
  ),
);
// 5. CI actions pinned by commit.
const ci = await readFile(".github/workflows/verify.yml", "utf8");
const uses = [...ci.matchAll(/uses:\s*([^\s]+)/g)].map((m) => m[1]);
add(
  "ci.actions-pinned",
  uses.every((u) => /@[0-9a-f]{40}$/.test(u)),
  uses,
);
add(
  "ci.no-secrets-or-deploy",
  !/secrets\.|deploy|publish/i.test(ci.replace(/# .*/g, "")),
);
// 6. Provenance release policy.
const inv = JSON.parse(
  await readFile("src/data/registry/rpc-provenance.json", "utf8"),
);
add(
  "provenance.no-release-approval-claimed",
  inv.groups.every((g) => g.reviewStatus !== "APPROVED_FOR_RELEASE"),
  inv.groups
    .filter((g) => g.reviewStatus === "APPROVED_FOR_RELEASE")
    .map((g) => g.operatorGroup),
);
add("provenance.disclaimer", /NOT LEGAL ADVICE/.test(inv.disclaimer));
// 7. Monitoring hygiene.
const rules = await readFile(
  "infra/monitoring/prometheus/rules/otherbridge.rules.yml",
  "utf8",
);
add("alerts.count", (rules.match(/- alert:/g) ?? []).length === 21);
const dash = (await walk("infra/monitoring/grafana/dashboards")).filter((f) =>
  f.endsWith(".json"),
);
const dashText = (await Promise.all(dash.map((f) => readFile(f, "utf8")))).join(
  "\n",
);
add(
  "dashboards.no-addresses",
  !/0x[0-9a-fA-F]{40}/.test(dashText) && dash.length === 6,
  dash.length,
);
const am = await readFile(
  "infra/monitoring/alertmanager/alertmanager.yml",
  "utf8",
);
add(
  "alertmanager.no-external-receivers",
  !/(webhook_configs|email_configs|slack_configs|pagerduty_configs|opsgenie_configs|telegram_configs)/.test(
    am,
  ),
);
const result = {
  at: new Date().toISOString(),
  checks,
  passed: Object.values(checks).every((c) => c.ok),
};
await writeFile(
  `${root}/security/v15-static-policy.json`,
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    passed: result.passed,
    failed: Object.entries(checks)
      .filter(([, c]) => !c.ok)
      .map(([k, c]) => [k, c.detail]),
  }),
);
process.exit(result.passed ? 0 : 1);
