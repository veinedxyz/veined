# @otherbridge/data-client (private, unpublished)

Typed, dependency-free TypeScript client for the internal-first VEINED Data API `/v1`.

- Server-side only. API keys are secrets: never ship them to browsers. The API disables CORS.
- Read-only GET endpoints; there are no write scopes.
- Coverage is explicit. `PENDING` and `CATALOG_ONLY` chains were not checked and must never be shown as empty.
- `portfolioAll()` follows continuation cursors with a bounded page budget.
- Billing is disabled; plans/quotas are configuration only. This package is not published to npm.

```ts
import { OtherbridgeDataClient } from "@otherbridge/data-client";
const client = new OtherbridgeDataClient({
  baseUrl: "http://127.0.0.1:3200",
  apiKey: process.env.OTHERBRIDGE_DATA_API_KEY!,
});
const chains = await client.chains();
const portfolio = await client.portfolio("0x…", { maxChains: 50 });
```
