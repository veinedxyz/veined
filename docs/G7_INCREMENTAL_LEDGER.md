# V1.12 incremental ledger

The self-hosted file data-plane adapter stores public observations in .otherbridge/data-cache/g7-ledger.json. It is a performance cache; it is not an independent witness or execution authority. The accepted V1.6 ledger baseline remains the accounting root.

The checkpoint includes BSC accepted-through block/hash, ONE through-block/hash, route digest, deposited, pending amount, reserve balance, complete open-pending indexes/values, next finalize/initiate indexes, raw event history, event digest and independently classified source evidence. The enclosing SHA-256 detects corruption, not malicious local authorship. Never treat its checksum as external evidence.

Before extension, fresh selected BSC state sources plus the third witness recheck the saved BSC hash; both ONE endpoints recheck the ONE anchor. All cached events must fit their exact contracts, topic filters and accepted ranges. The full cached BSC history is replayed in memory against accepted accounting semantics. Mismatched external hashes disagreeing with each other stop. Unanimous external anchors differing from the cache invalidate it and rebuild from V1.6. Missing/corrupt cache also starts from V1.6. Floors never permit backward network extension.

Only checkpoint+1 through the new pin is fetched over the network. Cached history plus new events are replayed in memory; current pins, roles, pauses, reserves, pending, fees, gas, calldata, firewall and dual simulations are still fresh external reads. Atomic monotonic saves prevent a slower session overwriting a newer checkpoint. A save can preserve public financially reconciled observations while P20 rejects unapproved source hashes; it never changes P20 or releases a capability.

The empty initial cache was bootstrapped from the owner-accepted V1.11 final dry evidence, with original file hashes and complete ledger replay recorded in g7-witness/checkpoint-bootstrap.json. It was externally anchored again before delta use. Cached event queries reduce historical RPC work; they do not remove mandatory state reads.

Live diagnosis also exposed a mixed-token inbox bug: global bridge indices contained a non-CROSS initiation, while the reserve value list contained only CROSS but its expected count contained all tokens. V1.12 requires every global index exactly once, a unique valid event and valid token/value data, then counts and sums only the exact reserve token. Missing non-CROSS records still fail closed. The spendable formula in src/g5/reserve.ts is unchanged.
