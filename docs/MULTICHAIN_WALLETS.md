# Multi-VM wallet and address boundary

There is no signature/approve/broadcast path. Browser discovery/permission and public address reads are for quote observation; no seed/private key/session is stored. A quote can be read with manual public source/destination addresses without connecting a wallet. This is not a verification of balance/gas/allowance or of real wallet readiness. The interface shows these uncertainties explicitly.

| VM | Address check | Optional read-only browser connector |
| --- | --- | --- |
| EVM | checksum EVM, nonzero | existing EIP-6963 / legacy injected account/network read; existing R1 permission protection |
| SVM | base58, exactly 32 bytes, nonzero | Solana injected publicKey/connect, otherwise Wallet Standard solana:mainnet |
| UTXO | Bitcoin mainnet Base58Check or bech32/bech32m | UniSat requestAccounts/getAccounts/getNetwork=livenet |
| MVM | Sui 0x + 64 hex, nonzero | Wallet Standard standard:connect, sui:mainnet account |
| TVM | Tron Base58Check, 0x41 prefix, nonzero | TronLink tron_requestAccounts/defaultAddress; chain readiness is not claimed |
| STL | Stellar StrKey G, CRC16-Xmodem | Freighter read/access and public mainnet network passphrase |

UTXO is the general family name; other UTXO networks such as Zcash are closed because their wallet/address support has not been verified. Their appearing in the catalog does not make them accept a Bitcoin address. Testnets are closed for read-only quotes as well. Extension support is not guaranteed on every chain with the same VM class. An incompatible or missing extension produces an explicit error; no EVM wallet is selected via provider fallback.

Source/destination addresses are independent. On a non-EVM switch there is no automatic EVM recipient/sender. The EVM global wallet identity revision invalidates the review even on duplicate accountsChanged, chainChanged, disconnect and reconnect. An EVM chain mismatch is indicated with a notice; the read-only quote does not gain submission authority because of this.

Native permission is limited to 12 seconds in the UI; the lock on the underlying open request is held until it settles. A late result is not bound to state. After connecting, 3-second public identity checks break the quote/review on an address change. The Bitcoin/Freighter mainnet requirement is rechecked after permission and in the identity poll. Wallet Standard account chain membership is verified. If the exact signature and chain-switch counts are unknown, they remain null/'Exact count unverified'; zero is not fabricated.

Fixture addresses are public examples: 0x3333…, the Bitcoin genesis address, Solana/Stellar addresses derived from the RFC8032 public key. No private key was generated/read. The unit/integration/E2E providers are explicitly synthetic; no real user wallet is used.
