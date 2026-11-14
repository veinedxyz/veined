# Troubleshooting

## Wrong network

Bridge and Swap read your wallet's current network. If it does not match the route's source network, the form says so; switching is a separate action in your wallet, and every quote is invalidated after the switch.

## Stale quote

Quotes expire quickly (the review shows the remaining time). An expired quote cannot be reviewed — choose **Read route** again. Changing the amount, token, recipient, slippage, network or wallet also invalidates it.

## Safety check needs another attempt

A data source has not caught up yet, did not answer in time, or is temporarily limiting requests. No wallet request was made. Wait a moment and choose **Check again**. **Advanced details** show the failing check, the chain, the data sources with their operator group and the age of the last verified block. A real route problem (for example a changed contract) shows **Route review required** instead and does not go away by retrying.

## RPC unavailable

When a network's vetted data sources are unavailable, Portfolio marks it **Check failed** or **Not checked**, and Bridge/Swap show **Temporarily unavailable**. Nothing is guessed in the meantime.

## Partial portfolio

A partial result is normal while networks are still **pending**. Each network's coverage class tells you what was checked. If some networks keep failing, use **Refresh** later; nothing is shown as zero just because it was not checked.

## A token is missing

Curated tokens are found automatically. For other tokens, paste the exact contract address in the token picker and use **Look up this token**; if the token is real and you trust it, **Import token** adds it to this device.
