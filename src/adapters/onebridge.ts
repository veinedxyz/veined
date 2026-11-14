import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  type Hex,
} from "viem";
import {
  BridgeError,
  CROSS,
  NATIVE,
  ROUTE,
  sameAddress,
  type Quote,
} from "../core/model";
// bridgeToken selector/ABI of the exact live ONE build (CrossBridge @ b3b0258, reproduced byte-for-byte in V1.6).
// Writes remain disabled: matching the ABI is not an execution approval.
export const bridgeAbi = parseAbi([
  "function bridgeToken(uint256 toChainID,address fromToken,address to,uint256 value,uint256 networkFee,uint256 exFee,bytes extraData) payable returns (bool)",
]);
export interface Deployment {
  mode: "local-test" | "mainnet-readonly";
  source: string;
  destination: string;
  verified: boolean;
  nativeSentinel: string;
  sourceChain: number;
  destinationChain: number;
  config: string;
}
export interface Unsigned {
  to: string;
  data: Hex;
  value: bigint;
  chainId: number;
  account: string;
}
export function validateQuote(
  q: Quote,
  account: string,
  chain: number,
  now = Date.now(),
  formAmount = q.amount,
) {
  if (
    q.amount !== formAmount ||
    !sameAddress(q.account, account) ||
    !sameAddress(q.recipient, account) ||
    q.sourceChain !== chain ||
    q.route !== ROUTE.id ||
    q.config !== ROUTE.version ||
    !sameAddress(q.token, CROSS)
  )
    throw new BridgeError("IDENTITY_CHANGED");
  if (q.expiresAt <= now || q.observedAt > now || now - q.observedAt > 60000)
    throw new BridgeError("QUOTE_EXPIRED");
  if (
    q.amount <= 0n ||
    q.amount < q.min ||
    q.amount > q.max ||
    q.networkFee < 0n ||
    q.serviceFee < 0n ||
    q.gasBudget <= 0n ||
    q.expected !== q.amount
  )
    throw new BridgeError("INVALID_QUOTE");
  const pair = q.mode === "local-test" ? [31337, 31338] : [612055, 56];
  if (q.sourceChain !== pair[0] || q.destinationChain !== pair[1])
    throw new BridgeError("UNSUPPORTED_ROUTE");
}
export function prepare(q: Quote, deployment: Deployment): Unsigned {
  validateQuote(q, q.account, q.sourceChain);
  if (
    !deployment.verified ||
    deployment.mode !== q.mode ||
    deployment.config !== q.config ||
    deployment.sourceChain !== q.sourceChain ||
    deployment.destinationChain !== q.destinationChain ||
    deployment.nativeSentinel !== NATIVE
  )
    throw new BridgeError("DEPLOYMENT_UNVERIFIED");
  return {
    to: deployment.source,
    account: q.account,
    chainId: q.sourceChain,
    value: q.amount + q.networkFee + q.serviceFee,
    data: encodeFunctionData({
      abi: bridgeAbi,
      functionName: "bridgeToken",
      args: [
        BigInt(q.destinationChain),
        NATIVE,
        q.recipient as Hex,
        q.amount,
        q.networkFee,
        q.serviceFee,
        "0x",
      ],
    }),
  };
}
export function validateUnsigned(
  tx: Unsigned,
  q: Quote,
  deployment: Deployment,
) {
  const expected = prepare(q, deployment);
  if (
    !sameAddress(tx.to, expected.to) ||
    !sameAddress(tx.account, q.account) ||
    tx.chainId !== q.sourceChain ||
    tx.value !== expected.value ||
    tx.data !== expected.data
  )
    throw new BridgeError("PAYLOAD_MISMATCH");
  const decoded = decodeFunctionData({ abi: bridgeAbi, data: tx.data });
  if (decoded.functionName !== "bridgeToken" || decoded.args[6] !== "0x")
    throw new BridgeError("UNEXPECTED_CALL");
}
export function preflight(
  q: Quote,
  d: Deployment,
  context: {
    account: string;
    chain: number;
    balance: bigint;
    sourceCode: string;
    destinationCode: string;
    healthFresh: boolean;
    reserveKnown: boolean;
    paused: boolean;
    simulation: boolean;
  },
) {
  validateQuote(q, context.account, context.chain);
  if (context.sourceCode !== "0x" || context.destinationCode !== "0x")
    throw new BridgeError("UNSUPPORTED_ACCOUNT");
  if (!context.healthFresh || !context.reserveKnown || context.paused)
    throw new BridgeError("ROUTE_UNAVAILABLE");
  if (q.amount + q.networkFee + q.serviceFee + q.gasBudget > context.balance)
    throw new BridgeError("INSUFFICIENT_GAS_OR_BALANCE");
  if (!context.simulation) throw new BridgeError("SIMULATION_FAILED");
  return prepare(q, d);
}
