# Ranking, refresh and bounded competition

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

Eligible provider lanes start concurrently and publish progressive quotes. Each lane permits two active requests, exact-intent single-flight, a two-second cache capped at 128 entries, an eight-second timeout and cooldown capped at 30 seconds. Subscriber cancellation closes the underlying job when no subscriber remains; intent epochs block stale late publication. Titan stream queues/reconnects/frames have independent hard bounds. A slow provider does not delay an earlier checked quote. Durable anonymous quote/decode/simulation health is described in SWAP_INCIDENT_RUNBOOK.md.

Best Output compares bigint output for exact-in and bigint input for exact-out. Best Net requires independently comparable costs and valuation for every candidate; otherwise Recommended uses raw output and shows incomplete costs. Included-in-output fees are never subtracted twice. Fastest uses observed latency; Direct uses hops/splits; ties are deterministic. These are comparisons of checked providers, not the entire DEX market. No live p95 is inferred from a single sample.

Refresh is coalesced, pauses while hidden and resumes with a new request on visibility/focus. Refresh begins before quote TTL where appropriate, with a bounded interval. An unchanged intent preserves the selected route ID/version where available; a material better late route produces a suggestion rather than stealing selection. Input/token/network/address/slippage/wallet-epoch/portfolio-revision changes cancel the old job and clear build/review. Selected expiry closes review.

Evidence root: [evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e](../evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/). Failed attempts remain alongside repaired runs. The final source checkpoint, gate summary and archive verification are authoritative; absence of a final receipt means PENDING, never an inferred pass.

