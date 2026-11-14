import { randomUUID } from "node:crypto";
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  type Abi,
  type Hex,
} from "viem";
import { z } from "zod";
import {
  BridgeError,
  CROSS,
  NATIVE,
  ROUTE,
  addressSchema,
  hashSchema,
  recordSchema,
  sameAddress,
  type Health,
  type Quote,
  type TransferRecord,
} from "../core/model";
import { parseAmount } from "../core/amounts";
import {
  verifySettlement,
  type DestinationEvidence,
  type SettlementPolicy,
} from "../core/flow";
import { type TrackingObservation } from "../features/bridge/observation";
import { rpc, boundedRequest } from "./read-only";
import { READ_ONLY_DEPLOYMENT as deployment } from "./deployment";
import { nativeReadAbi } from "./native-abi";
import { bridgeAbi, validateQuote } from "./onebridge";
import {
  blockSchema,
  decodeNativeSource,
  decodeNativeDestination,
  quantitySchema,
  receiptSchema,
  type ReceiptRead,
} from "./native-decoder";

const slot =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const codeSchema = z.string().regex(/^0x(?:[0-9a-f]{2})+$/i);
const uint = z
  .bigint()
  .nonnegative()
  .max(2n ** 256n - 1n);
const pairSchema = z.object({
  localToken: addressSchema,
  remoteToken: addressSchema,
  isOrigin: z.boolean(),
  paused: z.boolean(),
  pendingAmount: uint,
  deposited: uint,
  minted: uint,
});
type Chain = "one" | "bsc";
export const nativePolicy: SettlementPolicy & { finality: "node-finalized" } = {
  sourceContract: deployment.source,
  destinationContract: deployment.destination,
  sourceConfirmations: 1,
  destinationConfirmations: 1,
  finality: "node-finalized",
};
async function head(chain: Chain) {
  const chainId = chain === "one" ? 612055 : 56;
  if (
    BigInt(quantitySchema.parse(await rpc(chain, "eth_chainId"))) !==
    BigInt(chainId)
  )
    throw new BridgeError("CHAIN_MISMATCH");
  const block = blockSchema.parse(
    await rpc(chain, "eth_getBlockByNumber", ["latest", false]),
  );
  const age = Date.now() / 1000 - Number(BigInt(block.timestamp));
  if (!Number.isFinite(age) || age > 180 || age < -30)
    throw new BridgeError("STALE_CHAIN");
  return { chainId, block };
}
async function pin(chain: Chain, block: string) {
  const source = chain === "one";
  const proxy = source ? deployment.source : deployment.destination;
  const implementation = source
    ? deployment.sourceImplementation
    : deployment.destinationImplementation;
  const expectedHash = source
    ? deployment.sourceCodeHash
    : deployment.destinationCodeHash;
  const [storage, proxyCode, implementationCode] = await Promise.all([
    rpc(chain, "eth_getStorageAt", [proxy, slot, block]),
    rpc(chain, "eth_getCode", [proxy, block]),
    rpc(chain, "eth_getCode", [implementation, block]),
  ]);
  const implSlot = z
    .string()
    .regex(/^0x[0-9a-f]{64}$/i)
    .parse(storage);
  if (
    !sameAddress(`0x${implSlot.slice(-40)}`, implementation) ||
    keccak256(codeSchema.parse(implementationCode) as Hex) !== expectedHash
  )
    throw new BridgeError("DEPLOYMENT_CHANGED");
  codeSchema.parse(proxyCode);
  if (
    keccak256(proxyCode as Hex) !==
    (source
      ? deployment.sourceProxyCodeHash
      : deployment.destinationProxyCodeHash)
  )
    throw new BridgeError("DEPLOYMENT_CHANGED");
  return {
    proxy,
    implementation,
    implementationCodeHash: expectedHash,
    proxyCodeHash: keccak256(proxyCode as Hex),
    block,
  };
}
async function view(
  chain: Chain,
  to: string,
  name: string,
  args: readonly unknown[],
  block: string,
) {
  const abi = nativeReadAbi as Abi;
  const data = encodeFunctionData({ abi, functionName: name, args });
  return decodeFunctionResult({
    abi,
    functionName: name,
    data: codeSchema.parse(
      await rpc(chain, "eth_call", [{ to, data }, block]),
    ) as Hex,
  });
}
export async function nativeSnapshot() {
  const [sourceHead, destinationHead] = await Promise.all([
    head("one"),
    head("bsc"),
  ]);
  const [sourcePin, destinationPin] = await Promise.all([
    pin("one", sourceHead.block.number),
    pin("bsc", destinationHead.block.number),
  ]);
  const sourceBlock = sourceHead.block.number,
    destinationBlock = destinationHead.block.number;
  const [
    sourceRaw,
    destinationRaw,
    sourcePaused,
    destinationPaused,
    finalizePaused,
    verifier,
    tokenConfig,
    denominator,
    balanceResult,
  ] = await Promise.all([
    view("one", deployment.source, "getTokenPair", [56n, NATIVE], sourceBlock),
    view(
      "bsc",
      deployment.destination,
      "getTokenPair",
      [612055n, CROSS],
      destinationBlock,
    ),
    view("one", deployment.source, "paused", [], sourceBlock),
    view("bsc", deployment.destination, "paused", [], destinationBlock),
    view(
      "bsc",
      deployment.destination,
      "isTokenFinalizePaused",
      [612055n, CROSS],
      destinationBlock,
    ),
    view("one", deployment.source, "bridgeVerifier", [], sourceBlock),
    view(
      "one",
      deployment.sourceVerifier,
      "getTokenConfig",
      [56n, NATIVE],
      sourceBlock,
    ),
    view("one", deployment.sourceVerifier, "denominator", [], sourceBlock),
    rpc("bsc", "eth_call", [
      {
        to: CROSS,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [deployment.destination],
        }),
      },
      destinationBlock,
    ]),
  ]);
  const sourcePair = pairSchema.parse(sourceRaw),
    destinationPair = pairSchema.parse(destinationRaw);
  if (
    !sameAddress(sourcePair.localToken, NATIVE) ||
    !sameAddress(sourcePair.remoteToken, CROSS) ||
    sourcePair.isOrigin ||
    !sameAddress(destinationPair.localToken, CROSS) ||
    !sameAddress(destinationPair.remoteToken, NATIVE) ||
    !destinationPair.isOrigin ||
    !sameAddress(addressSchema.parse(verifier), deployment.sourceVerifier)
  )
    throw new BridgeError("PAIR_MISMATCH");
  const [minimum, networkFee, feeRate] = z
    .tuple([uint, uint, uint])
    .parse(tokenConfig);
  const feeDenominator = uint.positive().parse(denominator);
  const tokenBalance = uint.parse(
    decodeFunctionResult({
      abi: erc20Abi,
      functionName: "balanceOf",
      data: codeSchema.parse(balanceResult) as Hex,
    }),
  );
  const accounting =
    destinationPair.deposited < tokenBalance
      ? destinationPair.deposited
      : tokenBalance;
  const conservativeReserveBound =
    accounting > destinationPair.pendingAmount
      ? accounting - destinationPair.pendingAmount
      : 0n;
  const maximum =
    sourcePair.minted < conservativeReserveBound
      ? sourcePair.minted
      : conservativeReserveBound;
  const paused =
    z.boolean().parse(sourcePaused) ||
    z.boolean().parse(destinationPaused) ||
    z.boolean().parse(finalizePaused) ||
    sourcePair.paused ||
    destinationPair.paused;
  return {
    at: Date.now(),
    sourceHead,
    destinationHead,
    sourcePin,
    destinationPin,
    sourcePair,
    destinationPair,
    tokenBalance,
    conservativeReserveBound,
    maximum,
    minimum,
    networkFee,
    feeRate,
    feeDenominator,
    paused,
    deploymentEvidence: "RUNTIME_PINNED_SOURCE_BUILD_UNVERIFIED",
    reserveEvidence: "ACCOUNTING_BOUND_SOURCE_BUILD_UNVERIFIED",
  };
}
export async function nativeHealth(): Promise<Health> {
  const health: Health = {
    mode: "mainnet-readonly",
    observedAt: Date.now(),
    status: "blocked",
    reasons: [
      "MAINNET_WRITE_DISABLED",
      "SOURCE_BUILD_MATCH_UNVERIFIED",
      "DESTINATION_BUILD_MATCH_UNVERIFIED",
    ],
  };
  try {
    const snapshot = await nativeSnapshot();
    health.observedAt = snapshot.at;
    for (const [key, value] of [
      ["source", snapshot.sourceHead],
      ["destination", snapshot.destinationHead],
    ] as const)
      health[key] = {
        chainId: value.chainId,
        block: BigInt(value.block.number).toString(),
        timestamp: new Date(
          Number(BigInt(value.block.timestamp)) * 1000,
        ).toISOString(),
      };
    health.limits = {
      minimum: snapshot.minimum.toString(),
      maximumBound: snapshot.maximum.toString(),
      conservativeReserveBound: snapshot.conservativeReserveBound.toString(),
      reserveVerified: false,
      paused: snapshot.paused,
      sourceBlockHash: snapshot.sourceHead.block.hash,
      destinationBlockHash: snapshot.destinationHead.block.hash,
    };
    if (snapshot.paused) health.reasons.push("ROUTE_PAUSED");
  } catch (e) {
    health.reasons.push(e instanceof BridgeError ? e.code : "INVALID_RESPONSE");
  }
  return health;
}
export async function liveQuote(
  account: string,
  rawAmount: string,
): Promise<Quote> {
  addressSchema.parse(account);
  const amount = parseAmount(rawAmount);
  const snapshot = await nativeSnapshot();
  if (snapshot.paused || amount < snapshot.minimum || amount > snapshot.maximum)
    throw new BridgeError("ROUTE_LIMIT_OR_PAUSE");
  const [minimum, networkFee, serviceFee] = z
    .tuple([uint, uint, uint])
    .parse(
      await view(
        "one",
        deployment.sourceVerifier,
        "calculateFee",
        [56n, NATIVE, amount],
        snapshot.sourceHead.block.number,
      ),
    );
  if (
    minimum !== snapshot.minimum ||
    networkFee !== snapshot.networkFee ||
    serviceFee !== (amount * snapshot.feeRate) / snapshot.feeDenominator
  )
    throw new BridgeError("FEE_SOURCE_CHANGED");
  const data = encodeFunctionData({
    abi: bridgeAbi,
    functionName: "bridgeToken",
    args: [56n, NATIVE, account as Hex, amount, networkFee, serviceFee, "0x"],
  });
  const simulation = {
    from: account,
    to: deployment.source,
    data,
    value: `0x${(amount + networkFee + serviceFee).toString(16)}`,
  };
  const [balance, accountCode, destinationAccountCode] = await Promise.all([
    rpc("one", "eth_getBalance", [account, snapshot.sourceHead.block.number]),
    rpc("one", "eth_getCode", [account, snapshot.sourceHead.block.number]),
    rpc("bsc", "eth_getCode", [account, snapshot.destinationHead.block.number]),
  ]);
  if (accountCode !== "0x" || destinationAccountCode !== "0x")
    throw new BridgeError("UNSUPPORTED_ACCOUNT");
  if (amount + networkFee + serviceFee > BigInt(quantitySchema.parse(balance)))
    throw new BridgeError("INSUFFICIENT_GAS_OR_BALANCE");
  const [estimatedGas, gasPrice, result] = await Promise.all([
    rpc("one", "eth_estimateGas", [simulation]),
    rpc("one", "eth_gasPrice"),
    rpc("one", "eth_call", [simulation, snapshot.sourceHead.block.number]),
  ]);
  if (
    decodeFunctionResult({
      abi: bridgeAbi,
      functionName: "bridgeToken",
      data: codeSchema.parse(result) as Hex,
    }) !== true
  )
    throw new BridgeError("SIMULATION_FAILED");
  // A 20% explicit gas margin above a successful estimate; no fixed fallback.
  const gasBudget =
    ((BigInt(quantitySchema.parse(estimatedGas)) * 120n + 99n) / 100n) *
    BigInt(quantitySchema.parse(gasPrice));
  if (
    amount + networkFee + serviceFee + gasBudget >
    BigInt(quantitySchema.parse(balance))
  )
    throw new BridgeError("INSUFFICIENT_GAS_OR_BALANCE");
  const at = Date.now();
  const quote: Quote = {
    id: randomUUID(),
    mode: "mainnet-readonly",
    account,
    recipient: account,
    route: ROUTE.id,
    config: ROUTE.version,
    sourceChain: 612055,
    destinationChain: 56,
    token: CROSS,
    amount,
    networkFee,
    serviceFee,
    gasBudget,
    expected: amount,
    min: minimum,
    max: snapshot.maximum,
    observedAt: at,
    expiresAt: at + 30000,
  };
  validateQuote(quote, account, 612055, at, amount);
  return quote;
}
async function receiptRead(
  chain: Chain,
  hash: string,
): Promise<ReceiptRead | undefined> {
  const chainId = chain === "one" ? 612055 : 56;
  const [receiptRaw, transaction] = await Promise.all([
    rpc(chain, "eth_getTransactionReceipt", [hash]),
    rpc(chain, "eth_getTransactionByHash", [hash]),
  ]);
  if (receiptRaw === null) return undefined;
  const receipt = receiptSchema.parse(receiptRaw);
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase())
    throw new BridgeError("UNRELATED_RECEIPT");
  const [block, finalized] = await Promise.all([
    rpc(chain, "eth_getBlockByNumber", [receipt.blockNumber, false]),
    rpc(chain, "eth_getBlockByNumber", ["finalized", false]),
  ]);
  return { receipt, transaction, block, finalized, chainId };
}
async function destinationHint(record: TransferRecord) {
  const itemSchema = z.object({
    source: z.literal("bridge"),
    fromChainID: z.literal(612055),
    toChainID: z.literal(56),
    index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    fromToken: addressSchema,
    toToken: addressSchema,
    from: addressSchema,
    to: addressSchema,
    value: z.string(),
    initiatedTxHash: hashSchema,
    finalizedTxHash: hashSchema.nullable(),
  });
  // Public history locates a receipt; its status is never settlement proof.
  for (let page = 1; page <= 3; page++) {
    const response = z
      .object({
        code: z.literal(200),
        data: z.object({ histories: z.array(z.unknown()).max(20) }),
      })
      .parse(
        await boundedRequest(
          "https://bridge-api.crosstoken.io/bridge/history",
          {
            owner: record.account,
            page,
            size: 20,
            sort: "desc",
          },
        ),
      );
    const matches = response.data.histories
      .map((h) => itemSchema.safeParse(h))
      .filter(
        (h) =>
          h.success &&
          h.data.initiatedTxHash.toLowerCase() ===
            record.sourceHash?.toLowerCase() &&
          h.data.index.toString() === record.index &&
          sameAddress(h.data.from, record.account) &&
          sameAddress(h.data.to, record.recipient) &&
          h.data.value === record.amount &&
          sameAddress(h.data.fromToken, NATIVE) &&
          sameAddress(h.data.toToken, CROSS),
      );
    if (matches.length > 1) throw new BridgeError("AMBIGUOUS_DESTINATION_HINT");
    if (matches.length === 1 && matches[0].success)
      return {
        hash: matches[0].data.finalizedTxHash ?? undefined,
        exhausted: false,
      };
    if (response.data.histories.length < 20)
      return { hash: undefined, exhausted: false };
  }
  return { hash: undefined, exhausted: true };
}
export async function nativeTrack(
  rawRecord: TransferRecord,
): Promise<TrackingObservation> {
  let record = recordSchema.parse(rawRecord);
  if (record.mode !== "mainnet-readonly")
    throw new BridgeError("MODE_MISMATCH");
  const at = Date.now();
  if (!record.sourceHash)
    return {
      kind: "chain",
      observedAt: at,
      record: {
        ...record,
        state: "SUBMISSION_UNKNOWN",
        error: "MANUAL_ACTION_REQUIRED",
      },
      evidence: { policy: nativePolicy },
    };
  const [sourceHead, destinationHead] = await Promise.all([
    head("one"),
    head("bsc"),
  ]);
  await Promise.all([
    pin("one", sourceHead.block.number),
    pin("bsc", destinationHead.block.number),
  ]);
  const sourceRead = await receiptRead("one", record.sourceHash);
  const source = sourceRead && decodeNativeSource(record, sourceRead);
  if (source?.index) record = { ...record, index: source.index };
  let destination: DestinationEvidence | undefined;
  let discoveryError: string | undefined;
  const sourceState = verifySettlement(record, source, undefined, nativePolicy);
  if (sourceState === "SETTLEMENT_PENDING" && source) {
    const tryHint = async (hint: string) => {
      const read = await receiptRead("bsc", hint);
      if (!read) return false;
      destination = decodeNativeDestination(record, source, read);
      record = { ...record, destinationHash: hint };
      return true;
    };
    // Storage/import hashes are hints too. An absent or unrelated hint cannot
    // permanently suppress a fresh public lookup, but RPC failures remain errors.
    if (record.destinationHash) {
      try {
        await tryHint(record.destinationHash);
      } catch (e) {
        if (
          !(e instanceof z.ZodError) &&
          !(
            e instanceof BridgeError &&
            /^(UNRELATED_|AMBIGUOUS_|DESTINATION_EVENT_REQUIRED|INVALID_BLOCK)/.test(
              e.code,
            )
          )
        )
          throw e;
      }
    }
    if (
      verifySettlement(record, source, destination, nativePolicy) !==
      "COMPLETED"
    ) {
      const discovery = await destinationHint(record);
      if (discovery.exhausted) discoveryError = "DESTINATION_DISCOVERY_BOUNDED";
      if (
        discovery.hash &&
        discovery.hash.toLowerCase() !== record.destinationHash?.toLowerCase()
      )
        await tryHint(discovery.hash);
    }
  }
  const observedAt = Date.now();
  return {
    kind: "chain",
    observedAt,
    record: {
      ...record,
      state: verifySettlement(record, source, destination, nativePolicy),
      updatedAt: observedAt,
      error: discoveryError,
    },
    evidence: { source, destination, policy: nativePolicy },
  };
}
