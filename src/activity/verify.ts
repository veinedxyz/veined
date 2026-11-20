// Server-only, read-only hash import. No caller-selected URL, RPC method, calldata or block range.
import { z } from "zod";
import {
  decodeEventLog,
  formatUnits,
  parseAbi,
  parseUnits,
  keccak256,
  type Hex,
} from "viem";
import { httpsTransport, type RpcTransport } from "../data/rpc/transport";
import {
  profileAllows,
  provenanceForUrl,
  registryProfile,
} from "../data/registry/rpc-provenance";
import {
  activityInput,
  type ActivityInput,
  type VerifiedTransaction,
} from "./model";
const Q = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/);
const H = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const A = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const D = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
const logSchema = z.object({
  address: A,
  topics: z.array(H).max(4),
  data: D,
  transactionHash: H,
  blockHash: H,
  blockNumber: Q,
  logIndex: Q,
  removed: z.boolean().optional(),
});
const receiptSchema = z.object({
  transactionHash: H,
  blockHash: H,
  blockNumber: Q,
  status: z.enum(["0x0", "0x1"]),
  from: A,
  to: A.nullable(),
  logs: z.array(logSchema).max(2000),
  gasUsed: Q.optional(),
  effectiveGasPrice: Q.optional(),
  l1Fee: Q.optional(),
  operatorFeeScalar: Q.nullable().optional(),
  operatorFeeConstant: Q.nullable().optional(),
});
const txSchema = z.object({
  hash: H,
  blockHash: H,
  blockNumber: Q,
  from: A,
  to: A.nullable(),
  input: D,
  value: Q,
  nonce: Q,
});
const blockSchema = z.object({ hash: H, number: Q, timestamp: Q });
const lower = (s: string) => s.toLowerCase();
const TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const ROUTER = "0x2626664c2603336e57b271c5c0b26f421741e481";
const DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const chains = {
  "8453": {
    explorer: "https://basescan.org",
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    weth: "0x4200000000000000000000000000000000000006",
    spoke: "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64",
    sources: [
      {
        operator: "allnodes-publicnode",
        url: "https://base-rpc.publicnode.com",
      },
      { operator: "base-coinbase", url: "https://mainnet.base.org" },
    ],
  },
  "42161": {
    explorer: "https://arbiscan.io",
    usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    weth: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    spoke: "0xe35e9842fceaca96570b734083f4a58e8f7c5f2a",
    sources: [
      {
        operator: "arbitrum-offchain-labs",
        url: "https://arb1.arbitrum.io/rpc",
      },
      { operator: "drpc", url: "https://arbitrum.drpc.org" },
    ],
  },
} as const;
const acrossAbi = parseAbi([
  "event FilledRelay(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint256 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 exclusiveRelayer, bytes32 indexed relayer, bytes32 depositor, bytes32 recipient, bytes32 messageHash, (bytes32 updatedRecipient, bytes32 updatedMessageHash, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)",
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
]);
export class ActivityError extends Error {
  constructor(
    public code: string,
    public sources: { operator: string; code: string }[] = [],
  ) {
    super(code);
  }
}
// Transport already pins public DNS, rejects redirects, caps bytes/time and validates admitted HTTPS URLs.
export async function verifyTransaction(
  raw: ActivityInput,
  transport: RpcTransport = httpsTransport,
  inferSender = false,
): Promise<VerifiedTransaction> {
  const input = activityInput.parse(raw),
    initialWallet = lower(input.address),
    hash = lower(input.hash),
    chain = chains[input.chainId];
  const policy = registryProfile();
  if (
    policy.errors.length ||
    chain.sources.some(
      (s) => !profileAllows(policy.profile, provenanceForUrl(s.url)),
    )
  )
    throw new ActivityError("RPC_POLICY_CLOSED");
  async function read(
    source: (typeof chain.sources)[number],
    method: string,
    params: unknown[],
  ) {
    // Internal call sites below are the complete read capability. This function is never exported.
    if (
      ![
        "eth_chainId",
        "eth_blockNumber",
        "eth_getTransactionByHash",
        "eth_getTransactionReceipt",
        "eth_getBlockByNumber",
      ].includes(method)
    )
      throw new ActivityError("METHOD_REJECTED");
    const response = await transport(
      { id: source.operator, chainId: input.chainId, url: source.url },
      { jsonrpc: "2.0", id: 1, method, params },
      { timeoutMs: 8000, maxBytes: 1000000 },
    );
    const envelope = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.literal(1),
        result: z.unknown().optional(),
        error: z.unknown().optional(),
      })
      .parse(response);
    if (envelope.error || !("result" in envelope))
      throw new ActivityError("RPC_ERROR");
    return envelope.result;
  }
  const observations = await Promise.allSettled(
    chain.sources.map(async (source) => {
      const [cid, head, txRaw, receiptRaw] = await Promise.all([
        read(source, "eth_chainId", []),
        read(source, "eth_blockNumber", []),
        read(source, "eth_getTransactionByHash", [hash]),
        read(source, "eth_getTransactionReceipt", [hash]),
      ]);
      if (BigInt(Q.parse(cid)) !== BigInt(input.chainId))
        throw new ActivityError("CHAIN_MISMATCH");
      if (txRaw === null || receiptRaw === null)
        throw new ActivityError("RECEIPT_UNAVAILABLE");
      const tx = txSchema.parse(txRaw),
        receipt = receiptSchema.parse(receiptRaw);
      if (
        lower(tx.hash) !== hash ||
        lower(receipt.transactionHash) !== hash ||
        lower(tx.blockHash) !== lower(receipt.blockHash) ||
        BigInt(tx.blockNumber) !== BigInt(receipt.blockNumber) ||
        lower(tx.from) !== lower(receipt.from) ||
        tx.to?.toLowerCase() !== receipt.to?.toLowerCase()
      )
        throw new ActivityError("TX_RECEIPT_MISMATCH");
      const block = blockSchema.parse(
        await read(source, "eth_getBlockByNumber", [
          receipt.blockNumber,
          false,
        ]),
      );
      if (
        lower(block.hash) !== lower(receipt.blockHash) ||
        BigInt(block.number) !== BigInt(receipt.blockNumber)
      )
        throw new ActivityError("REORGED");
      for (const l of receipt.logs)
        if (
          l.removed ||
          lower(l.transactionHash) !== hash ||
          lower(l.blockHash) !== lower(block.hash) ||
          BigInt(l.blockNumber) !== BigInt(block.number)
        )
          throw new ActivityError("LOG_BINDING_MISMATCH");
      const confirmations = BigInt(Q.parse(head)) - BigInt(block.number) + 1n;
      if (confirmations < 10n) throw new ActivityError("PENDING_CONFIRMATIONS");
      return { tx, receipt, block, confirmations };
    }),
  );
  const errors = observations.flatMap((o, i) =>
    o.status === "rejected"
      ? [
          {
            operator: chain.sources[i].operator,
            code:
              o.reason instanceof ActivityError
                ? o.reason.code
                : "PROVIDER_UNAVAILABLE",
          },
        ]
      : [],
  );
  if (errors.length)
    throw new ActivityError("VERIFICATION_UNAVAILABLE", errors);
  const [first, second] = observations.map(
    (o) =>
      (
        o as PromiseFulfilledResult<{
          tx: z.infer<typeof txSchema>;
          receipt: z.infer<typeof receiptSchema>;
          block: z.infer<typeof blockSchema>;
          confirmations: bigint;
        }>
      ).value,
  );
  const facts = (o: typeof first) =>
    JSON.stringify({
      tx: o.tx,
      receipt: o.receipt,
      block: o.block,
    }).toLowerCase();
  if (facts(first) !== facts(second))
    throw new ActivityError("OPERATORS_DISAGREE");
  const { tx, receipt, block } = first;
  const wallet = inferSender ? lower(tx.from) : initialWallet;
  const amounts: VerifiedTransaction["amounts"] = [];
  let associated = lower(tx.from) === wallet || tx.to?.toLowerCase() === wallet;
  let approvedSpender: string | undefined;
  for (const l of receipt.logs) {
    const contract = lower(l.address),
      token =
        contract === chain.usdc
          ? { symbol: "USDC", decimals: 6 }
          : contract === chain.weth
            ? { symbol: "WETH", decimals: 18 }
            : null;
    if (!token || l.topics.length !== 3 || l.data.length !== 66) continue;
    const topic = lower(l.topics[0]),
      from = "0x" + l.topics[1].slice(-40).toLowerCase(),
      to = "0x" + l.topics[2].slice(-40).toLowerCase();
    if (topic === TRANSFER && (from === wallet || to === wallet)) {
      associated = true;
      amounts.push({
        symbol: token.symbol,
        amount: formatUnits(BigInt(l.data), token.decimals),
        direction: to === wallet ? "in" : "out",
      });
    }
    if (topic === APPROVAL && from === wallet) {
      associated = true;
      approvedSpender = to;
      amounts.push({
        symbol: token.symbol,
        amount: formatUnits(BigInt(l.data), token.decimals),
        direction: "permission",
      });
    }
  }
  if (!associated) throw new ActivityError("ADDRESS_NOT_INVOLVED");
  if (receipt.status === "0x0") amounts.length = 0;
  else if (
    BigInt(tx.value) > 0n &&
    (lower(tx.from) === wallet || tx.to?.toLowerCase() === wallet)
  )
    amounts.push({
      symbol: "ETH",
      amount: formatUnits(BigInt(tx.value), 18),
      direction: tx.to?.toLowerCase() === wallet ? "in" : "out",
    });
  let kind: VerifiedTransaction["kind"] = "Transaction",
    deposit: VerifiedTransaction["deposit"];
  if (
    approvedSpender &&
    [chain.usdc, chain.weth].includes(
      tx.to?.toLowerCase() as typeof chain.usdc,
    ) &&
    tx.input.toLowerCase().startsWith("0x095ea7b3")
  )
    kind = "Approval";
  else if (
    input.chainId === "8453" &&
    tx.to?.toLowerCase() === ROUTER &&
    tx.input.toLowerCase().startsWith("0x5ae401dc")
  )
    kind = "Swap";
  else if (
    input.chainId === "8453" &&
    tx.to?.toLowerCase() === DIAMOND &&
    tx.input.toLowerCase().startsWith("0x1794958f")
  )
    kind = "Bridge";
  else if (amounts.length) kind = "Transfer";
  for (const l of receipt.logs.filter(
    (l) => receipt.status === "0x1" && lower(l.address) === chain.spoke,
  ))
    try {
      const e = decodeEventLog({
        abi: acrossAbi,
        data: l.data as Hex,
        topics: l.topics as [Hex, ...Hex[]],
        strict: true,
      });
      const a = e.args,
        recipient = "0x" + a.recipient.slice(-40).toLowerCase();
      if (recipient !== wallet) continue;
      if (e.eventName === "FilledRelay") {
        const paid = amounts
          .filter((v) => v.symbol === "USDC" && v.direction === "in")
          .reduce((sum, v) => sum + parseUnits(v.amount, 6), 0n);
        if (
          "0x" + a.outputToken.slice(-40).toLowerCase() !== chain.usdc ||
          paid < a.outputAmount ||
          lower(e.args.relayExecutionInfo.updatedRecipient) !==
            lower(a.recipient) ||
          lower(e.args.relayExecutionInfo.updatedMessageHash) !==
            lower(e.args.messageHash) ||
          e.args.relayExecutionInfo.updatedOutputAmount !== a.outputAmount
        )
          continue;
        kind = "Destination settlement";
      }
      deposit = {
        id: a.depositId.toString(),
        origin:
          e.eventName === "FilledRelay"
            ? e.args.originChainId.toString()
            : input.chainId,
        destination:
          e.eventName === "FundsDeposited"
            ? e.args.destinationChainId.toString()
            : input.chainId,
        recipient,
        inputAmount: a.inputAmount.toString(),
        outputAmount: a.outputAmount.toString(),
        inputToken: lower(a.inputToken),
        outputToken: lower(a.outputToken),
        depositor: lower(a.depositor),
        messageHash:
          e.eventName === "FundsDeposited"
            ? e.args.message === "0x"
              ? "0x" + "0".repeat(64)
              : keccak256(e.args.message)
            : lower(e.args.messageHash),
        fillDeadline: a.fillDeadline,
        exclusivityDeadline: a.exclusivityDeadline,
        exclusiveRelayer: lower(a.exclusiveRelayer),
      };
    } catch {
      /* Unknown events do not establish settlement. */
    }
  return {
    address: wallet,
    chainId: input.chainId,
    hash,
    block: BigInt(block.number).toString(),
    blockHash: lower(block.hash),
    timestamp: Number(BigInt(block.timestamp)) * 1000,
    verifiedAt: Date.now(),
    confirmations: (first.confirmations < second.confirmations
      ? first.confirmations
      : second.confirmations
    ).toString(),
    status: receipt.status === "0x1" ? "CONFIRMED" : "FAILED",
    kind,
    from: lower(tx.from),
    to: tx.to ? lower(tx.to) : null,
    explorer: `${chain.explorer}/tx/${hash}`,
    operators: chain.sources.map((s) => s.operator),
    amounts,
    gas:
      receipt.gasUsed && receipt.effectiveGasPrice
        ? {
            gasUsed: BigInt(receipt.gasUsed).toString(),
            effectiveGasPriceWei: BigInt(receipt.effectiveGasPrice).toString(),
            l1FeeWei: receipt.l1Fee ? BigInt(receipt.l1Fee).toString() : null,
            totalFeeWei:
              input.chainId === "8453" &&
              (!receipt.l1Fee ||
                BigInt(receipt.operatorFeeScalar ?? "0x0") !== 0n ||
                BigInt(receipt.operatorFeeConstant ?? "0x0") !== 0n)
                ? null
                : (
                    BigInt(receipt.gasUsed) *
                      BigInt(receipt.effectiveGasPrice) +
                    BigInt(receipt.l1Fee ?? "0x0")
                  ).toString(),
          }
        : undefined,
    spender: approvedSpender,
    deposit,
    coverage: "Imported hash only; no indexed history",
  };
}

/** Hash-only search derives the public sender only after both operators agree on the canonical receipt. */
export function verifyHash(chainId: "8453" | "42161", hash: string) {
  return verifyTransaction(
    { address: "0x" + "0".repeat(40), chainId, hash, consent: true },
    httpsTransport,
    true,
  );
}
