# Whirlpool upstream drift review — V1.17

**Classification: `UNVERIFIED_UPSTREAM_CHANGE`. Affected Jupiter/Titan Whirlpool routes remain `BUILD_REVIEW_REQUIRED`; active pins remain unchanged.** Current executable bytes and on-chain IDL were retrieved through two independent RPC operators. Neither a metadata-only change nor a compatible deployed upgrade is proven, so no pin-update candidate was prepared or activated.

Primary evidence: [program/source review](../evidence/otherbridge-v1-17/20261015T175758204Z-8120f0/Whirlpool/whirlpool-upstream-review.json), [final on-chain IDL review](../evidence/otherbridge-v1-17/20261015T175758204Z-8120f0/Whirlpool/idl-and-audit-review-final.json), [instruction/audit comparison](../evidence/otherbridge-v1-17/20261015T175758204Z-8120f0/Whirlpool/instruction-and-audit-comparison.json). Raw responses, downloaded sources/IDLs, full ProgramData binaries and upstream verification-service response are retained with acquisition timestamps and hashes. The initial IDL parser attempt is explicitly superseded by the final report using Anchor's documented `internal:IdlAccount` discriminator; both final providers agree.

## Accepted pin compared with current finalized accounts

| Field | Accepted pin | Current independent observation |
|---|---|---|
| Program ID | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | Same |
| Loader | `BPFLoaderUpgradeab1e11111111111111111111111` | Same, executable Program account |
| ProgramData | `CtXfPzz36dH5Ws4UYKZvrQ1Xqzn42ecDW6y8NKuiN8nD` | Same, loader-owned, non-executable ProgramData account |
| Upgrade authority | `GwH3Hiv5mACLX3ufTw1pFsrhSPon5tdw252DBs4Rx4PV` | Same, authority remains present |
| Upgrade slot | `440170207` | **`457152296`** |
| Account observation slot | `456788801` | Solana public RPC `457330293`; Allnodes PublicNode `457330289`, both finalized |
| Program account SHA-256 | `5ba0ae1569444542b67322d0f333b289d738efead363c02436c7869cf33c2928` | Same; this covers the 36-byte loader header/pointer, **not executable code** |
| Full historical executable hash | Not retained by accepted pin | Cannot compare current executable to historical executable from this pin |

Both RPC operators returned byte-identical **10,485,760-byte ProgramData** accounts, including the header, executable and allocation padding. Same metadata and full hash at two finalized contexts establish current observations; they do not establish the source used to build that executable.

| Current hash definition | SHA-256 |
|---|---|
| Entire ProgramData, including 45-byte loader header | `a49ebc534880f4aaf525b5fd1504aed6223928bdbbea6c83d40473eb17abd04e` |
| Every executable/allocation byte after offset 45; 10,485,715 bytes | `c422b22f3eefe86dd55878a4f505b9c68c26e241dc96af1573ca032b24b8ee3f` |
| Executable after offset 45 with trailing zero allocation bytes removed; 1,495,881 bytes | `75d0cbf14e39949d50656d581b2e0065ac9543588da96a1dc4c1091a939c605c` |

The [upstream-linked Osec verification status](https://verify.osec.io/status/whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc) returned `is_verified:false`, no source commit, no executable-build hash and no last verification time. Its on-chain hash equals the independently computed zero-trimmed hash above. This provides an additional hash observation; it does not bind the current deployment to audited source. An unchanged authority and unchanged Program account hash cannot establish `METADATA_ONLY`.

## Source, release and IDL compatibility

The accepted source revision and current official `main` were both [cc683ec92acb5e7606caa3d8e514d9383e9c7c11](https://github.com/orca-so/whirlpools/tree/cc683ec92acb5e7606caa3d8e514d9383e9c7c11), committed 2026-10-12T09:29:17Z. The fetched `swap.rs`, `v2/swap.rs`, Whirlpool state layout, program entrypoint, Cargo/Anchor configuration, generated `swap`/`swapV2` clients and security references are identical at those two source revisions. Current public source equality is a source comparison, not a deployment proof. The GitHub releases API still reports **SDK v1.0.2**, published 2025-01-03, as the latest repository release; no statement binds that SDK tag to current program upgrade slot 457152296.

The repository's [IDL instructions](https://github.com/orca-so/whirlpools/blob/cc683ec92acb5e7606caa3d8e514d9383e9c7c11/idl/README.md) point to the generated SDK artifact. NPM metadata resolved `@orca-so/whirlpools-sdk` to **0.22.0**; the explicit-version downloaded IDL has SHA-256 `f3e95ddf321d24b71ce56f5ba842055899f32a1feee3be9f0d3ccf2bd6a55bb8` and names the accepted program ID. No SDK was installed or executed for this review.

The Anchor legacy on-chain IDL address was independently derived as `2KFqE4RWoPVbvodo8vbggCFeHPS8TDvgpwp79ALMrcyn`. Both providers returned the same account bytes, owner equal to the Whirlpool program and decoded IDL SHA-256 **`7afddfe8766bd24d30ff9ee5b12c7ee89bff5bc3b7b0396620e021a97a7ef63f`**. Its authority is `8ztMi8xauc8yhu1qQ6T27XMiTpZpCqoenNw7GjL7futn`; this is distinct from the upgrade authority and does not attest executable semantics. Legacy derivation/layout is documented in [Anchor's source](https://docs.rs/anchor-lang/latest/src/anchor_lang/idl.rs.html).

| Instruction | SDK/current source shape | Current on-chain IDL | Finding |
|---|---|---|---|
| `swap` | Discriminator `f8c69e91e17587c8`; five arguments; 11 accounts, pool index 2, vaults 4/6 | Same discriminator, arguments and first 11 accounts; **extra trailing `whirlpool_program` account** | The reviewed field indices agree; full account contract and deployed semantics need review |
| `swap_v2` | Discriminator `2b04ed0b1ac91e62`; six arguments including optional remaining-accounts info; 15 accounts, pool index 4, mints 5/6, vaults 8/10 | Same discriminator, arguments and first 15 accounts; **extra trailing `whirlpool_program` account** | Same unresolved full-contract difference |

The existing firewall's exact-input mode, amount, direction and pool/vault account positions remain aligned with the public source/IDL prefix. That is insufficient to approve the extra account, dynamic instruction surface, hook behavior or current deployed economics. The existing independent loader/ProgramData metadata verifier rejects the changed header before affected route review can succeed. Unsupported Token-2022 economic extensions, hooks and new CPI families remain outside the reviewed route family; no additional opcode/program/account family was admitted.

## Relevant upstream security scope

The repository tree contains 11 audit references, including Kudelski, Neodyme, OtterSec and Sec3 reports. The three latest Sec3 PDFs were downloaded, hashed and their text reviewed; these reports are source-scoped, incremental assessments and are not an independent audit of Otherbridge.

| Report | Reviewed source scope | Relevant finding / limit |
|---|---|---|
| [2026-08-11](https://github.com/orca-so/whirlpools/blob/cc683ec92acb5e7606caa3d8e514d9383e9c7c11/.audits/2026-08-11.pdf) | PR1311 removal of migration instruction; PR1317 prepare/commit quote interface; PR1326 u256 division fix | One informational TransferFee mint reinitialization issue in prepare/commit was resolved. New prepare/commit surface is not admitted by this review. |
| [2026-08-18](https://github.com/orca-so/whirlpools/blob/cc683ec92acb5e7606caa3d8e514d9383e9c7c11/.audits/2026-08-18.pdf) | PR1366, rent-reduction preparation for Agave 4.2, `e5ee72f..d12f6ac` | Informational potential wSOL reward-collection DoS after rent fallback, acknowledged. Incremental rent/reward scope does not prove deployed swap compatibility. |
| [2026-09-30](https://github.com/orca-so/whirlpools/blob/cc683ec92acb5e7606caa3d8e514d9383e9c7c11/.audits/2026-09-30.pdf) | PR1392 virtual-address-space preparation, `59f4c4c..b823c8d`; PR1396 checkpoint update, `90333c1..5207a03` | No issue in PR1392; informational reward-accrual rounding impact acknowledged for PR1396. Economic design/algorithm soundness is outside the report's scope. |

Neither the reports nor the current verification response map this exact executable hash to a complete reviewed source/build. The repository [security policy](https://github.com/orca-so/whirlpools/blob/cc683ec92acb5e7606caa3d8e514d9383e9c7c11/SECURITY.md) links the Orca Immunefi program; that reporting policy is not binary or compatibility evidence.

## Exact OWNER ACTION and activation boundary

[Machine action](../evidence/otherbridge-v1-17/20261015T175758204Z-8120f0/Whirlpool/owner-actions.json) **`V117-WHIRLPOOL-SOURCE-BINDING`** is assigned to the upstream release/upgrade owner and independent security reviewer. Required input is the exact source commit/tag, reproducible build toolchain/container digest, lockfile/features and deploy recipe for upgrade slot **457152296**, mapping to zero-trimmed executable hash **75d0cbf14e39949d50656d581b2e0065ac9543588da96a1dc4c1091a939c605c**, plus current IDL/authority provenance and complete reviewed source diff/audit scope. Refresh all identities/hashes if another upgrade occurs.

Closure requires independent source/binary reproduction, semantic review of both swap account contracts including the extra self-program account, oracle/tick-array and Token-2022/CPI effects, and positive/negative economic regressions. Only after that proof should a **separate tested pin-update candidate** be prepared for explicit review. Current evidence does not meet that threshold. The four new evidence-helper regressions cover loader header decoding, executable-vs-metadata hash definitions, fail-closed upgrade classification and bounded Anchor IDL decoding. They do not claim live post-upgrade economic or signature validity proof.

The accepted pin file's SHA-256 before and after this acquisition is identical in the machine report. No protected source, accepted router/program pin, global execution flag, fee, write registry, wallet, signing, broadcast or deployment was changed.
