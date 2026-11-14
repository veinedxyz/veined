# Deterministic user-outcome ranking

Only unexpired, bound normalized routes with price impact at most 15% enter alternatives. A warning is shown above 3%. Same-input/output amount comparisons use BigInt. USD decimal comparison is fixed-point integer arithmetic with 18 fractional places. Revenue/referral/kickback metadata is neither parsed nor consulted.

Best value maximizes quoted destination USD minus costs explicitly outside output. Included protocol fees are already reflected in receive and are not subtracted twice. When a common current USD metric is unavailable, compare expected output base units after the platform fee. Comparisons are within the same bound input and destination token.

Cheapest minimizes the sum of all quoted route fees and network gas costs where every USD amount is present. Unknown-cost routes fall back to net destination token amount; UI and this document state the distinction. Fastest minimizes estimated duration. Ties use user value then stable quote ID. Equivalent economic/path/cost responses are deduplicated. Multiple approved protocols may be returned by the current adapter; a second independent routing vendor is not claimed.

Current Otherbridge platform fee is exactly zero. A future fee policy cannot be introduced into quote comparison without a separately verified quote-bound net-outcome model and release approval. No route is called safest.
