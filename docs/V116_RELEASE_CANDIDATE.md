# Otherbridge V1.16 release candidate

Candidate: **OTHERBRIDGE_RC_V1_16_20261015T133159055Z-16dfa3**. Repository: D:\Projeler\otherbridge. Branch: main. HEAD: 8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5. The working tree contains accepted uncommitted work; HEAD alone does not identify this RC. No commit, push or history rewrite is part of V1.16.

The immutable authority is final/source-checkpoint.json in **evidence/otherbridge-v1-16/20261015T133159055Z-16dfa3**, containing the complete sorted per-file SHA-256 map. Its canonical map digest identifies the source checkpoint; the file SHA-256 identifies the manifest. final/build-manifest.json identifies the one delivered production build. Build IDs are expected to vary between independently reproduced Next builds; exact candidate artifacts are hashed, while clean reproduction proves the same locked source passes checks. Neither a changed source nor a different build can inherit approval.

Accepted starting checkpoint: a9889ff350c4cadcc621a92a3c2379ba754eaac79fa19e18c519a32c9da762ac; all 1676 files matched before changes. Active protected pointer: evidence/otherbridge-v1-12-1/owner-security-20261014T140240767Z/preflight/protected-hashes.json; SHA-256 cf7025aeeedac022b8ffa08540ed88345e561d23b50f05ae794f3f5dec1991b4; pointer SHA-256 0fb9bd4aa6eae6af51cb9acf5a64df0e56a80647d2fe5e5744ab9446562a4199; members **107**. Historical evidence remains immutable. Root lock: e22a5add14621ea46ec6ee1705a7174ced09bf390b634b8d341b3fc16df0b0e9; provider lock: 757e1f3b18be3772dfb3fce4c927d7b14a4360c0c55601a868ae483747eae970.

The final gate report and both archive verification receipts are generated after source freeze; their status must be read from final/FINAL_REPORT_TR.md and release/FINAL_GATE_STATUS.json. This document does not predeclare unrun checks as PASS. An engineering failure means RETURN_FOR_REPAIR. An audit input package is not an independent audit result.

Execution is structurally CLOSED, platform fee 0 bps. The release receipt is a schema only; even schema-valid synthetic input is rejected by the current execution inspector because no owner trust root or signature verifier is provisioned. Protected Bridge/G7 write boundaries remain unchanged.

Reproduction: see audit/AUDITOR_REPRODUCTION.md. Provider revisions and pins: SWAP_PROVIDER_SOURCE_INVENTORY.md, src/swap/server/config.ts and both generated pin files. Config schemas: release/production-config.schema.json and release/release-receipt.schema.json. Migration checksums and initial DB state: preflight/.

Boundary: private/local staging-equivalent only. Wallet prompts, signatures, approvals, permits, broadcasts, deploys, fee collection and real G7/Swap/Bridge transactions remain zero. Local Docker image builds and synthetic test doubles do not authorize real transactions.
