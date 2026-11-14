import {
  BridgeError,
  type Quote,
  ROUTE,
  type TransferRecord,
  recordSchema,
  sameAddress,
} from "../../core/model";
import {
  withVerifiedIntent,
  recordSubmission,
  sameIntentNamespace,
} from "./lifecycle";
import {
  validateUnsigned,
  type Deployment,
  type Unsigned,
} from "../../adapters/onebridge";
import { type Provider, parseChain, readWallet } from "../wallet/provider";
export async function submit(
  provider: Provider,
  tx: Unsigned,
  q: Quote,
  d: Deployment,
  context: {
    enabled: boolean;
    releaseApproved: boolean;
    revalidate: () => Promise<void>;
    observeHistory?: (
      claim: import("../../core/model").TransferRecord,
    ) => Promise<unknown>;
    persistUnknown: () => void | Promise<void>;
    persistHash: (hash: string) => void | Promise<void>;
    persistRejected: () => void | Promise<void>;
    intent?: TransferRecord;
  },
): Promise<string> {
  // No local signer and no bypass for a fixture. This is the only wallet write boundary.
  if (
    !context.enabled ||
    !context.releaseApproved ||
    q.mode !== "mainnet-readonly" ||
    !d.verified ||
    ROUTE.sourceContract === null ||
    ROUTE.destinationContract === null
  )
    throw new BridgeError("MAINNET_WRITE_DISABLED");
  if (!context.observeHistory)
    throw new BridgeError("HISTORY_REVALIDATION_REQUIRED");
  return withVerifiedIntent(q.account, q, context.observeHistory, async () => {
    await context.revalidate();
    const accounts = await readWallet(provider, "eth_accounts");
    const chain = parseChain(await readWallet(provider, "eth_chainId"));
    if (
      !Array.isArray(accounts) ||
      accounts[0]?.toLowerCase() !== q.account.toLowerCase() ||
      chain !== q.sourceChain
    )
      throw new BridgeError("IDENTITY_CHANGED");
    validateUnsigned(tx, q, d);
    const intent = recordSchema.parse(context.intent);
    if (
      intent.sourceHash ||
      !sameIntentNamespace(intent, q.account, q) ||
      !sameAddress(intent.recipient, q.recipient) ||
      !sameAddress(intent.token, q.token) ||
      intent.amount !== q.amount.toString() ||
      intent.expected !== q.expected.toString()
    )
      throw new BridgeError("INVALID_SUBMISSION_INTENT");
    return recordSubmission(
      () =>
        provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: tx.account,
              to: tx.to,
              data: tx.data,
              value: `0x${tx.value.toString(16)}`,
              chainId: `0x${tx.chainId.toString(16)}`,
            },
          ],
        }),
      {
        unknown: context.persistUnknown,
        hash: context.persistHash,
        rejected: context.persistRejected,
      },
      intent,
    );
  });
}
