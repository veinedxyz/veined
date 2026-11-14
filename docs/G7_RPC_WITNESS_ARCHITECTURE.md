# V1.12 G7 RPC and witness architecture

Status: review candidate; accepted protected baseline remains active. Evidence: evidence/otherbridge-v1-12/v112-20261007T100941277Z-de7692/g7-witness and g7-rpc.

The former pin required NodeReal regardless of the state pair. A rate limit at this single log witness made every valid state pair fail. Each new process also scanned all history from V1.6 before reading fresh state again. Range splitting treated quota answers as size limits, amplifying load.

| Operator group | Endpoint host | Admitted role |
| --- | --- | --- |
| BNB chain | bsc-dataseed.bnbchain.org | State |
| Allnodes | bsc-rpc.publicnode.com | State; witness only after historical-log probe succeeds |
| OnFinality | bnb.api.onfinality.io/public | State; independently probed log witness |
| NodeReal | bsc-mainnet.nodereal.io | Log witness only; never a state vote |
| ONE official endpoints | mainnet.crosstoken.io / mainnet.onechain.nexus | Dual ONE state and exact positive/negative simulations |

There must be two distinct BSC state operator groups and a third distinct log operator group. Alias URLs never create another operator. A cache never votes. Every selected source serves the identical exact finalized hash, with the existing age, floor and bounded step-down limits. A finalized hash disagreement stops immediately; availability cannot rotate around that disagreement. Unknown marketplace backing operators remain excluded. No new endpoint was admitted.

Witness admission probes chain ID, finalized tag, the requested historical header and a one-block historical log request. Availability and quota failures remove that candidate for the attempt. Malformed events stop the run. Observations record role capabilities, latency, last success, health and cooldown; health is availability metadata only. Historical depth is the distance between the probed finalized head and the earliest requested block, not a universal archive guarantee.

NodeReal typically supplies the third group while BNB and Allnodes vote on state. PublicNode returned HTTP 403 on older history during preliminary observations, then passed recent checkpoint probes in the final cohort; it cannot also count as the third group while it serves the selected state pair. OnFinality sometimes returned quota errors. Synthetic chaos proves safe witness rotation when a genuinely independent alternative succeeds; live fallback capacity is not guaranteed when those alternatives remain unavailable. This is a material operational limitation, not a claim of three healthy live log providers.

The product's ordinary health path uses the existing current native snapshot; it does not import G7 or reconstruct its historic ledger. Full G7 is launcher/session work. A refresh shares its in-progress read with simultaneous callers, clears failed pool admission for recovery, and rereads financial state. Final requests wait for an earlier read and perform their own fresh run. Expiry, account/chain binding, one-shot lock and unchanged intent remain separate strict gates.
