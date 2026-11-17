# VEINED Guardian — NEAR HACKATHON

**Track:** AI Security & Defense (`security`). It is also relevant to Unstoppable DeFi (`defi`).

**What it is:** Guardian reads an action before it is signed and returns a verdict with reasons. It works for a person
in a wallet UI and for an AI agent with a budget. The verdict is one of **ALLOW / WARN / ESCALATE / BLOCK**.

**How Guardian decides:** the verdict comes from deterministic rules, never from a language model. Every review has a
sha256 digest, and the same input always produces the same digest.

**What it uses on NEAR:**

- NEAR Intents: live **dry** quotes toward NEAR.
- NEAR account intelligence: named and implicit accounts, look-alikes, keys, meta transactions, NEP-413 messages,
  and an on-chain existence check through RPC.
- A Chain Signatures signing request that is prepared only after Guardian allows the action.
- An optional NEAR AI Cloud narrator running in a TEE. It explains a verdict and can never change it.

## Built in the hackathon window vs. baseline

| | |
|---|---|
| **Judged (new, NEAR integration)** | `src/guardian/**`, `src/app/api/guardian/route.ts`, `src/components/guardian-*.tsx`, `src/app/guardian-system.css`, Guardian hooks in Swap / Bridge / Portfolio, `/guardian` console, `guardian.*` copy in 24 locales, tests `tests/unit/guardian.test.ts`, `tests/integration/guardian-api.test.ts`, `tests/e2e/guardian.spec.ts`, docs in `docs/guardian/`. **"To NEAR" route in Swap and Bridge:** `src/guardian/near-route.ts`, `src/components/near-route.tsx`, `src/components/route-kind.tsx`, `src/app/near-route.css`, `g12.nr.*` copy in 24 locales, tests `tests/unit/g12-near-route.test.ts`, `tests/integration/g12-near-route-api.test.ts`, `tests/e2e/g12-near-route.spec.ts`. |
| **Baseline (pre-existing, not judged)** | The VEINED interface: read-only multichain portfolio, swap quote comparison and bridge route discovery. Execution is **closed** in this build: nothing is signed, approved or broadcast. |

## Run it

Requirements: Node 24 and pnpm 11. You do not need a wallet, keys or funds.

```bash
pnpm install --frozen-lockfile
OTHERBRIDGE_APP_ORIGINS=http://127.0.0.1:3100 node scripts/next-pinned.mjs dev --hostname 127.0.0.1 --port 3100
```

Open http://127.0.0.1:3100/guardian.

**Optional environment variables** (server only; never commit them):

| Variable | Effect |
|---|---|
| `VEINED_NEAR_AI_API_KEY`, `VEINED_NEAR_AI_MODEL` | Enable NEAR AI Cloud narration. |
| `VEINED_NEAR_INTENTS_JWT` | Partner key for 1Click. Dry quotes work without it. |
| `VEINED_GUARDIAN_ONCHAIN=off` | Disable the NEAR RPC account check, for offline runs. |

## Demo: do X → see Y

**Inside the product first (Bridge or Swap → "To NEAR").** This is the flow a normal user meets; the `/guardian`
console below is the deeper tour.

A. **Open Bridge and choose "To NEAR".** Open `/bridge` and click **To NEAR** (or open `/bridge?to=near`; Swap has the
   same switch: `/swap?to=near`). You see **Send to NEAR** with the pill `NEAR Intents · preview`.
B. **Connect a wallet (optional).** Click **Connect wallet** and connect an EVM wallet (for example Rabby). Its address
   becomes the sender and the refund address, and its network is preselected. Without a wallet, type any public
   address of the source network. VEINED never asks for a key or a seed phrase.
C. **Pick a reviewed route.** From: Base · USDC (the token list shows the exact contract, `0x8335…2913`, Circle's native
   USDC). Amount `5`. To NEAR: **wNEAR** (labelled "Wrapped NEAR token (NEP-141), not native NEAR"), **USDC** or **USDT**
   (both "Issued natively on NEAR"). NEAR account: `veinedxyz.near`.
D. **Get NEAR quote.** Guardian first checks the NEAR recipient; then the server asks NEAR Intents (1Click) for a
   **dry** quote and verifies its signature. You see the receipt: you send 5 USDC, you receive about 1.37 wNEAR (live price on 2026-11-11; it moves),
   the minimum you receive, the NEAR Intents fee (0.2 %, set and reported by the provider, included), **VEINED fee: none**,
   the refund fee if the route fails, the arrival estimate (fees and timing are reported by the provider, not covered by
   its signature), "Quote signature: Verified with the NEAR Intents 1Click key"
   and a countdown "Preview valid for … s".
E. **Read Guardian's decision.** For a fresh, genuine quote to an existing account: **Clear** (decision `ALLOW`) with
   "Dry quote: no deposit address was created" and the note "A decision about this quote only. Nothing can be sent
   from this screen." After two minutes the decision reads **Expired · get a new quote**, the server re-reviews the
   signed quote as stale, and the button becomes **Get a new quote**.
F. **Try an attack.** Set the NEAR account to `intents-near.near` (a look-alike of `intents.near`) and click **Get NEAR
   quote**: Guardian blocks the recipient and **no quote is requested**. If a signed quote ever comes back for another
   asset, amount, recipient or refund address, Guardian answers **Blocked** and the amounts are hidden.
G. **Sending stays closed.** The only send control reads **Send · closed in this preview** and is disabled. A dry
   quote creates no deposit address, so nothing can be sent from VEINED.

Offered here (and only here): reviewed source assets on Base, Ethereum, Arbitrum, OP Mainnet, Polygon, BNB Chain,
Avalanche and Solana → wNEAR, USDC or USDT on NEAR; other pairs are not offered. Verified with live dry quotes on
2026-11-11: Base USDC → wNEAR, Arbitrum USDC → USDC, Ethereum ETH → wNEAR, Polygon USDT0 → USDT, OP USDC → USDC,
BNB → wNEAR. The other offered pairs depend on NEAR Intents liquidity when quoted; without a route the screen says so
and shows no quote.

**The Guardian console (`/guardian`):**

1. **Open the console.** Open `/guardian`. You see the Guardian console with four cards: **Agent Gate**,
   **Inspect before you sign**, **Route toward NEAR** and **Built on NEAR**. Guardian also appears in the left rail with
   a crowned-octopus mark.
2. **Replay the compromised agent.** Click **Replay a compromised agent**.
   - The tally reads `3 blocked · 1 sent to the owner · 3 allowed`.
   - The seven decisions, in order: ALLOW (wrap 1 NEAR), ALLOW (swap on Ref), **BLOCK**, **BLOCK**, **BLOCK**,
     ALLOW (owner payout), **ESCALATE**.
   - First BLOCK: a prompt-injected "claim your reward" transfer of 4 NEAR to `ref-finance-rewards.near`. The account
     is not on the allowlist, the amount is over the 3 NEAR per-action limit, and the name contains a lure word.
   - Second BLOCK: a request to add a full-access key.
   - Third BLOCK: profits sent to the look-alike account `0wner.guardian-demo.near`.
   - ESCALATE: the last action would exceed the 5 NEAR daily budget, so the owner must decide.
3. **Inspect a full-access key request.** Under Inspect, click **Full-access key**. You see **Blocked** with the finding
   "Grants a full-access key to alice.near". The safe path starts with "Do not sign or send this.", and the Chain
   Signatures line reads "refused, no signing request is prepared."
4. **Inspect a signed intent.** Click **Signed intent**. You see **Blocked**: it is a NEP-413 message for
   `intents.near` that contains `add_public_key`, and signing it would let someone else withdraw.
5. **Inspect a look-alike token.** Click **Look-alike token**. You see `usdt.tether-tokens.near imitates USDt (native on NEAR)`.
6. **Inspect a meta transaction.** Click **Meta transaction**. You see **Hold**: the NEP-366 delegate is reviewed
   through its inner action, which sends USDC to a "bonus" account.
7. **Inspect a safe wrap.** Click **Safe wrap**. You see **Clear**, and the Chain Signatures line reads "request
   prepared for v1.signer-prod.testnet, not submitted."
8. **Check that an account exists.** Paste `ghost-guardian-demo-0001.near` and click **Review**. You see **Blocked** with
   "does not exist on NEAR", from a live `view_account` RPC call.
9. **Get a route toward NEAR.** Under Route toward NEAR, choose Base ETH, amount `0.01`, recipient `alice.near`, then
   click **Get a dry quote**.
   - You see a live 1Click dry quote (about 6 wNEAR in about 35 s) with verdict **Clear** and the finding "Dry quote: no
     deposit address was created".
   - Change the refund address and you get **Hold**.
   - Set the recipient to `intents-near.near` and you get **Blocked**.
10. **Check Guardian in Swap.** Open `/swap`, pick USDC, enter an amount and click **Compare providers**. A Guardian panel
    appears above **Review Swap**. If the destination token carries a same-symbol impersonation flag, the panel shows
    **Blocked** and Review is disabled.
11. **Check Guardian in Portfolio.** Open `/portfolio` and scan any public address. The side column starts with the
    Guardian sweep: suspicious tokens, same-symbol twins, unverified metadata and hidden spam.

## Around the demo: what else a judge can try (all read-only)

These are part of the same candidate. None of them signs, approves or sends anything.

- **Bridge → "Between networks".** Read a route (for example Base → Arbitrum, USDC). Under Guardian's decision a note
  **Check these numbers** appears only when the quote's own numbers call for it: an estimate that is *higher* than what
  you send for the same reviewed asset (a live quote on 2026-11-11 returned 5.007450 USDC for 5 USDC; VEINED says so and
  says it cannot verify the reason), or costs out of proportion to the amount ("This amount is too small for this
  route"). The quote is never altered or re-ranked.
- **25 / 50 / 75 / 100 % buttons** in Bridge and Swap. They use the balance your own Portfolio scan read for the
  sending address. Without a read balance they are disabled and say why; a network's own coin gets 100 % only after a
  route's network fee is known, and leaves that fee plus a 20 % margin in the wallet.
- **Portfolio.** Scan any public address. Circle's native USDC on Base, Arbitrum, OP Mainnet and Polygon is read from
  the reviewed registry (exact contracts), and the Coverage card counts three kinds of coverage: native coins, reviewed
  tokens, activity index and DeFi. A network that was not read is "not read", never empty.
- **VEINED Scan (`/scan`).** Your saved route previews (quotes, not transactions) and, for a transfer you made yourself
  and attached by its hash, a read-only status matched to that preview. No public activity feed is shown: no licensed
  source is connected, and the page shows no rows it cannot verify.
- **Points (`/points`).** Your own points only; the planned rule (1 point for every 100 USD of verified volume) is
  **not active** and no number is shown for any account.

## Call Guardian from an agent

```bash
curl -s http://127.0.0.1:3100/api/guardian \
  -H 'Origin: http://127.0.0.1:3100' -H 'Content-Type: application/json' \
  -d '{"action":"near-transaction","tx":{"signerId":"alice.near","receiverId":"alice.near","actions":[{"type":"AddKey","params":{"publicKey":"ed25519:x","accessKey":{"permission":"FullAccess"}}}]}}'
# → {"verdict":{"level":"BLOCK","findings":[{"code":"NEAR_KEY_FULL_ACCESS",...}],"steps":["STOP","LIMITED_KEY"],"digest":"…"}}
```

**Actions:**

| Action | Fields |
|---|---|
| `near-transaction` | wallet-selector or near-api-js JSON |
| `near-message` | a NEP-413 message |
| `address` | an EVM, Solana or NEAR address |
| `agent-run` | `policyId` (a server-side owner policy, e.g. `demo-trader`) + `proposals`; a supplied `policy` is refused |
| `intents-tokens` | — |
| `intents-quote` | `dry: true` is required by the schema |

`GET /api/guardian` returns the capabilities.

## Verify

```bash
npx vitest run tests/unit/guardian.test.ts tests/integration/guardian-api.test.ts tests/unit/g12-near-route.test.ts tests/integration/g12-near-route-api.test.ts
OTHERBRIDGE_E2E_ORIGIN=http://127.0.0.1:3126 VEINED_GUARDIAN_ONCHAIN=off npx playwright test tests/e2e/guardian.spec.ts tests/e2e/g12-near-route.spec.ts
```

## Honest status

- **Execution:** closed. No transaction is signed or broadcast, and the Chain Signatures request is prepared only, never
  submitted.
- **Simulation:** the Agent Gate run uses synthetic proposals. The NEAR Intents quotes and the NEAR RPC account checks
  are live and read-only.
- **Fees:** VEINED adds no fee to a NEAR Intents quote and sends no fee recipient. The provider's own fee is shown as
  NEAR Intents reports it in the quote response (0.2 % observed without a partner key; the provider documents 0.25 %
  for unauthenticated requests). Fees and timing are reported, not covered by the quote signature; the signature
  covers the assets, amounts and recipient, and the screen says so.
- **Narration:** NEAR AI Cloud narration needs an owner API key. Without one, Guardian's own localized templates
  explain every finding.
- **Routes and prices:** quotes come from the route sources as reported; VEINED offers a pair only where a route source
  answers, and makes no "best price" or "every network" claim. No price chart is drawn (no licensed price history).
- **Points:** the volume-points rule is a draft waiting for the owner's decisions; nothing is earned, no token and no
  monetary value is promised.
- **Next:** the on-chain Guardian vault contract is the next milestone (`docs/guardian/ARCHITECTURE.md`). The agent would
  hold a function-call key to the vault only, and the vault would enforce this same policy before calling `v1.signer`.

Architecture: [docs/guardian/ARCHITECTURE.md](docs/guardian/ARCHITECTURE.md) · Submission draft: [docs/guardian/SUBMISSION.md](docs/guardian/SUBMISSION.md)
