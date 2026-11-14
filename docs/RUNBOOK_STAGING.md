# Runbook — local staging-equivalent stack

Local only. Never deploy this profile publicly, never point it at production secrets, never change DNS. No signing, approval, broadcast or deploy path exists.

## Topology (`infra/staging/compose.yaml`, project `otherbridge-staging`)

```text
127.0.0.1:8443 ── Caddy (TLS internal CA, single trusted hop)
                    ├─ app.otherbridge.localhost:8443 → app (Next, NODE_ENV=production, public-deployment semantics)
                    └─ api.otherbridge.localhost:8443 → data-api (/v1, API keys, durable limiter)
backend (internal network, no route out): postgres, app, data-api, indexer, rpc-health, ops-exporter, prometheus, alertmanager
egress (outbound only): app, data-api, indexer, rpc-health, migrate — public read-only RPC and quotes
monitoring: prometheus 127.0.0.1:59090, alertmanager 127.0.0.1:59093, grafana 127.0.0.1:53000
```

- PostgreSQL 17 has **no published port**; roles: owner (migrations only), api, indexer, monitor, backup — each service uses its own role.
- One image (`infra/staging/Dockerfile`): multi-stage, pinned base digest, `pnpm install --frozen-lockfile --ignore-scripts` (production dependencies only at runtime), files root-owned, runs as `node`.
- Every service: `read_only` root filesystem, `tmpfs` scratch, `no-new-privileges`, `cap_drop: ALL` (Caddy keeps only `NET_BIND_SERVICE` in its bounding set because its binary carries that file capability; it still listens on 8443), memory/CPU limits, healthchecks (postgres, app, data-api, ops-exporter, prometheus), `restart: unless-stopped` for every long-running service (the fail-fast indexer exits on a database outage and is brought back by the policy; the one-shot `migrate` job uses `restart: "no"`). Images pinned by tag **and** digest; no `latest`.
- Production semantics: `NODE_ENV=production`, `OTHERBRIDGE_PUBLIC_DEPLOYMENT=true`, exact origin `https://app.otherbridge.localhost:8443`, `OTHERBRIDGE_TRUST_PROXY_HOPS=1`, durable PostgreSQL limiter, generated pseudonym key, `OTHERBRIDGE_DEPLOYMENT_ENV=staging` (staging RPC profile), indexer `--witness required`.

## Commands

```text
node scripts/staging.mjs init     # git-ignored .env.staging.local + infra/staging/secrets/metrics_token (never printed)
node scripts/staging.mjs up       # build + migrate job (migrations, chains, seed admitted snapshot, live Tier A admission incl. World Chain 480) + services
node scripts/v15-staging-smoke.mjs   # acceptance (needs OTHERBRIDGE_EVIDENCE_ROOT)
node scripts/v15-drills-cd.mjs       # drills C (bad config) and D (restore swap)
node scripts/staging.mjs down     # stop/remove containers and networks; volumes kept
node scripts/staging.mjs purge --yes # also removes staging volumes (explicit only)
```

Client/key for checks: `docker compose --env-file .env.staging.local -f infra/staging/compose.yaml run --rm --no-deps -T migrate node scripts/data.mjs client:create …` then `key:create … --stdout-json` (keep the key in memory only; revoke afterwards).

## Configuration validation (fails start)

`dataConfig()` / `originPolicy()` / `metricsListenerConfig()` refuse: wildcard or list origins, non-HTTPS public origins, proxy hops outside 0–3 or missing in public mode, memory limiter in public mode, missing/short pseudonym key, weak/default database password (< 24 characters or common defaults), non-private database host without `sslmode=require|verify-ca|verify-full`, unknown deployment marker (treated as production + error), booleans other than exactly `true`/`false`, weak metrics token, non-loopback metrics bind other than a container `0.0.0.0`, and any frozen security-invariant deviation (`EXECUTION_GATE_ANOMALY`, `FEE_COLLECTION_ANOMALY`). Drill C proves the Data API and indexer exit non-zero and that a hostile app environment keeps execution closed and refuses API calls (503) without the durable limiter.

## Smoke acceptance (last run: all checks PASS, evidence `staging/staging-smoke.json`)

Loopback-only publication; DB unpublished; backend internal; container hardening; app pages over TLS; strict CSP and HSTS; 24 locales with correct `lang`/`dir`; Bridge read-only configuration; Portfolio read-only scan (no wallet, public burn address); origin/proxy-trust matrix (foreign, trailing slash, missing port, http scheme, no origin → 403; spoofed client `X-Forwarded-*` replaced by Caddy); live read-only Swap/Bridge quotes non-executable at 0 bps; Data API health/auth/revoked key/no public metrics/coverage integrity/durable limiter; metrics token required; 4/4 targets up; 21 rules loaded; invariants; 0 CSP violations through the ingress; Grafana dashboards rendered, anonymous access refused; Drill B (DB down → Data API degraded/503, app 503, page still served, no holdings invented, alert fired and cleared); Data API down → proxy 502, app unaffected, target-down alert.

## Evidence to preserve / no secret disclosure

`staging/` and `drills/` JSON, screenshots, `docker compose ps`, `docker inspect` hardening fields. Never copy `.env.staging.local`, `infra/staging/secrets/` or Caddy's private keys (`/data` volume) anywhere.
