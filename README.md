# VEINED

**Multichain portfolio, swap and bridge discovery, with Guardian: a deterministic pre-signing security layer built on NEAR.**

> **Read-only preview: execution is CLOSED.** By default nothing in this repository signs, approves or broadcasts
> a transaction, creates a deposit address or moves funds. VEINED adds no platform fee (0 bps).

NEAR Hackathon submission · track **AI Security & Defense** · solo project by **Coinisan** ·
X: [@Veinedxyz](https://x.com/Veinedxyz)

---

## The problem

Assets live on many networks, routes are hard to compare, and the final step (a wallet signature) is unreadable for
most people and for the AI agents now acting on their behalf. One look-alike account, one full-access key grant or one
prompt-injected transfer is enough to lose funds. People need to see what an action really does **before** they sign it.

## What VEINED is

- **Portfolio:** a read-only multichain scan of a public address. Every network is labelled checked, pending, failed or
  not supported; an unchecked network is never shown as empty.
- **Swap and Bridge discovery:** provider-neutral quote comparison and route review across supported networks, with
  fees, price impact and route risks shown. **Execution is closed:** quotes are reviewed, never sent.
- **Guardian:** the security layer below. It reviews swaps, bridges, NEAR transactions, NEP-366 meta transactions,
  NEP-413 signed messages and AI-agent proposals.
- 24 languages (including right-to-left), light and dark themes.

## Guardian (the NEAR Hackathon work)

Guardian reads an action before anything is signed and answers **ALLOW / WARN / ESCALATE / BLOCK** with its findings,
a safe path and a reproducible digest. The rules are deterministic; no language model decides.

Built on NEAR in the hackathon window:

- **NEAR accounts and keys:** account existence through NEAR RPC (`view_account`), look-alike account names, and
  full-access key grants.
- **Signed messages:** NEP-413 messages and NEP-366 meta transactions.
- **NEAR Intents (1Click), "To NEAR" route in Swap and Bridge:**
  - the server requests a **live dry quote**, verifies the quote's **1Click signature** and checks that the quote
    matches the request, then runs Guardian on it;
  - a look-alike recipient is **blocked before any quote is requested**;
  - "dry" means no deposit address is created, and Send stays disabled.
- **Agent Gate:** an AI agent gets a budget and an allowlist, never keys. The owner's policy (per-action and daily
  limits, allowed receivers and methods) and Guardian decide every proposal. Over-budget actions are escalated to the
  owner. The demo agents are synthetic and labelled **SIMULATION**.
- **Chain Signatures:** a signing request is **prepared only** after Guardian allows the action, and is never submitted.
- **NEAR AI Cloud:** optional narration of findings (needs an API key; off by default).

Details: [docs/guardian/ARCHITECTURE.md](docs/guardian/ARCHITECTURE.md).

## Security approach

- **Closed by default.**
  - The general execution gate is closed, the global kill switch is on and the contract registry is empty.
  - Two static scans, `scripts/verify-safety.mjs` and `scripts/g7-safety-scan.ts`, assert these facts.
- **Fail closed.** Missing, stale, contradictory or unknown data never becomes a success; it is shown as pending,
  unknown or blocked.
- **Server-side review.** Guardian runs on the server, on the server's own quote and registry evidence; a client
  cannot supply a verdict.
- **No secrets in the repository.** Configuration comes from environment variables (`.env.example` lists them).
- **Owner-armed canary, shipped disarmed.** The repository also contains a single-use Base → Arbitrum USDC route
  through LI.FI / Across, behind an attested Guardian verdict, two-operator simulation and on-chain settlement checks.
  - It ships **disarmed** (`OWNER_CANARY_APPROVAL = null`, `CANARY_LIVE_WIRING = false`).
  - It is not NEAR work and not a NEAR Intents transfer.
  - As published, it sends nothing. The later armed runs are documented in [docs/LIVE_CANARY.md](docs/LIVE_CANARY.md).
  - Later development (2026-11-21): two Bridges were verified on mainnet.
    - On 2026-11-15, a local owner-armed copy of this repository (the two files in
      [docs/LIVE_CANARY.md](docs/LIVE_CANARY.md)) ran one. A restricted local signer signed it.
    - On 2026-11-20, the owner ran one from their own wallet with a later, separate local source. This repository's
      source did not run it. See [Verified Mainnet Bridge Canary](#verified-mainnet-bridge-canary).

## Run it

Requirements: Node 24 and pnpm 11. No wallet, keys or funds are needed.

```bash
pnpm install --frozen-lockfile
pnpm swap:deps   # installs swap-providers/ (its own lockfile); the app does not start without it
OTHERBRIDGE_APP_ORIGINS=http://127.0.0.1:3100 node scripts/next-pinned.mjs dev --hostname 127.0.0.1 --port 3100
```

On Windows, clone with LF line endings (`git -c core.autocrlf=false clone https://github.com/veinedxyz/veined.git`):
the generated docs module is checked byte for byte (`node scripts/docs-build.mjs --check`), and a CRLF checkout reports
it as out of date. Then, in PowerShell, set the variable first:

```powershell
$env:OTHERBRIDGE_APP_ORIGINS="http://127.0.0.1:3100"; node scripts/next-pinned.mjs dev --hostname 127.0.0.1 --port 3100
```

Open http://127.0.0.1:3100/guardian, `/bridge?to=near` and `/swap?to=near`. The full walkthrough, the API and the
optional environment variables are in [HACKATHON.md](HACKATHON.md).

## Do X → see Y (reproducible)

1. **Live dry quote.**
   - Do: on `/bridge?to=near`, choose Base USDC, amount 5, wNEAR, recipient `alice.near`, any public Base refund
     address, then click **Get NEAR quote**.
   - See: a live quote with "Quote signature: Verified with the NEAR Intents 1Click key", a Guardian decision, and
     **Send · closed in this preview**.
2. **Look-alike recipient.**
   - Do: change the recipient to `intents-near.near`.
   - See: "Guardian blocked this NEAR recipient, so no quote was requested."
3. **Risky signing requests.**
   - Do: on `/guardian`, open **Inspect**, then click **Full-access key**, then **Signed intent** and
     **Meta transaction**.
   - See: **Blocked** for each, with the reasons.
4. **Agent Gate.**
   - Do: on `/guardian`, open **Advanced demonstrations** and click **Replay a compromised agent**.
   - See: "3 blocked · 1 sent to the owner · 3 allowed", with every agent labelled SIMULATION.

## Tests

Targeted Guardian and NEAR suites (they pass on a fresh clone):

```bash
node node_modules/vitest/vitest.mjs run tests/unit/guardian.test.ts tests/integration/guardian-api.test.ts tests/unit/g12-near-route.test.ts tests/integration/g12-near-route-api.test.ts
node scripts/verify-safety.mjs
```

Browser end-to-end tests (Playwright):
1. `pnpm exec playwright install chromium` once.
2. Then `pnpm test:e2e`, or the Guardian and NEAR specs only, as listed in [HACKATHON.md](HACKATHON.md#verify).

**Results on the submitted source** (checkpoint `4a504378…`):
- **E2E: 555/555 passed.**
- **Full unit suite: 2557/2586 · integration: 456/459.** The 32 non-passing tests fail **by design**. They compare
  three protected files with the accepted G7 security baseline, and the disarmed canary proposal changes exactly those
  files. The baseline update is an owner decision that has not been taken.
- No other test fails.

## Built in the hackathon window vs. baseline

- **Judged (NEAR):** Guardian and the NEAR integration are listed file by file in [HACKATHON.md](HACKATHON.md).
- **Baseline:** the VEINED interface (portfolio, quote comparison, route discovery).
- **Git tags:**
  - `pre-hackathon`: the tree of the last private commit before the 2026-10-19 announcement;
  - `hackathon-submission`: the submitted tree.
- Diff: https://github.com/veinedxyz/veined/compare/pre-hackathon...hackathon-submission. Nothing is backdated.

## Verified Mainnet Bridge Canary

**Added 2026-11-21, after the hackathon submission.**

- **What ran:** one owner-controlled, single-use Bridge of **5 USDC** from Base to Arbitrum One. The owner ran it from
  their own wallet, on a local copy of a later VEINED source (checkpoint `50cfa4e1…`, not published here).
- **Result:** **4.981152 USDC** was delivered to the same account, at a route cost of 37.70 bps.
- **Guardian:** the verdict was CLEAR, and the signed calldata is exactly the reviewed calldata.
- **Approval:** the exact approval is fully consumed (allowance 0).

Links:
- Base source: [`0x38be4b80…6c16`](https://basescan.org/tx/0x38be4b805b0f7e37ea22ce3157140acb24e66df9df0e2cd00880d27fea8e6c16).
- Arbitrum fill: [`0xa5bb811b…dde8`](https://arbiscan.io/tx/0xa5bb811bc30f6072dc75a953afb18263d4d1485fcb4abd47b5d8167f69d0dde8).
- Evidence (two RPC operators per chain), method and limits: [docs/MAINNET_BRIDGE_PROOF_2026-11-21.md](docs/MAINNET_BRIDGE_PROOF_2026-11-21.md).

What this does not change or prove:
- This repository's source (the submission, `4a504378…`) did not perform it. Its execution gate stays closed and its
  canary stays disarmed.
- It does not prove same-chain Swap execution, general multichain execution, or any NEAR transfer.

## Status and limits

- Read-only preview. No live transaction, no same-chain Swap execution and no NEAR transfer is part of this submission.
  Later local armed runs are documented separately: see [Verified Mainnet Bridge Canary](#verified-mainnet-bridge-canary)
  and [docs/LIVE_CANARY.md](docs/LIVE_CANARY.md).
- The owner-armed canary is disarmed in this repository.
- Not audited and not production-ready. Early-access sign-up is not open.

## Team, tools and licence

- **Team:** solo project by **Coinisan** (team size 1).
- **NEAR accounts:** payout account `veined.near`; `veinedxyz.near` is a test account.
- **Tools:** AI coding assistants were used during development (allowed by the rules, Q-005); the developer reviewed,
  tested and is responsible for the code.
- **Licence:** see [LICENSE](LICENSE).
- **History:** the engineering history of earlier milestones (Otherbridge V1 to V1.18, partly in Turkish) is preserved
  in [ENGINEERING_HISTORY.md](ENGINEERING_HISTORY.md).
