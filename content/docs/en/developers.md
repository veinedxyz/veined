# Developers

## Data API

{{BRAND}}'s Data API serves chains, coverage, token metadata and balances from the self-hosted data plane. It is described by an **OpenAPI** document served with the API, and every response carries a request ID.

- **Base**: `/v1/...` on the Data API host (separate from the app).
- **Coverage first**: every balance answer states the network's tier and observed block; an unchecked network is reported as such, never as zero.

## Keys and scopes

API access uses keys issued per client. Keys are shown once, stored only as verifiers, and carry scopes (for example coverage, tokens, balances). Keys can be revoked immediately; usage is recorded per client without wallet labels.

## Rate limits

Each plan has a per-minute limit and a concurrency limit, enforced by a shared limiter. A `429` response means the limit was reached; retry after the window.

## Asset registry API (app)

The app uses `POST /api/assets` with `list`, `search` and `preview` actions. It accepts only a chain ID and a query or an exact token address — never wallet data — and is rate-limited. Logos are served as sanitized bytes from `/api/asset-image/<sha256>` with `nosniff` and a sandboxing CSP.

## Constants

| Constant | Value |
| --- | --- |
| {{BRAND}} fee | {{FEE_BPS}} bps |
| Sending | {{SENDING}} |
| App languages | {{LOCALES}} |
| Mainnets in catalog | {{MAINNETS}} |
