// G7 pilot transaction, owner intent and owner-scope bounds (pure; no I/O, no wallet, no signer).
// The digest binds every transaction-determining byte (to, value, calldata, gas limit, fee caps, chain) plus the
// pinned route/trust sets; quote time/block are deliberately outside it, so a fresh final quote that produces the
// byte-identical transaction reproduces the digest the owner reviewed, and ANY change produces a different digest.
import { decodeBridgeTokenIndependent, keccakHex } from "../../src/g7/decoder";
import {
  canonicalJson,
  formatUnits18,
  sha256Hex,
  type Gate,
  type GasPlan,
  type Quote,
  type SideRead,
} from "../../src/g7/prep";
import {
  PILOT_BOUNDS,
  PILOT_SCHEMA,
  PILOT_SCOPE,
  QUOTE_MAX_AGE_AT_WALLET_MS,
} from "./policy";

const lc = (s: string) => s.toLowerCase();
const same = (a: string, b: string) => lc(a) === lc(b);
const hex = (n: bigint) => "0x" + n.toString(16);

// Live fee reads at the fixed pilot principal (calculateFee(56, native, 5 ONE)) plus the route minimum.
export interface PilotFees {
  minimum: bigint;
  networkFee: bigint;
  serviceFee: bigint;
}

// The principal is ALWAYS exactly 5 ONE; only the fees come from the fresh read. expiresAt uses the pilot's 20 s
// wallet window, so the existing firewall/P19 checks enforce the stricter pilot freshness too.
export function pilotQuote(
  fees: PilotFees,
  observedAt: number,
  side: Pick<SideRead, "block" | "blockHash" | "blockTimestamp">,
): Quote {
  const amount = PILOT_SCOPE.principal;
  return {
    amount,
    networkFee: fees.networkFee,
    serviceFee: fees.serviceFee,
    value: amount + fees.networkFee + fees.serviceFee,
    observedAt,
    expiresAt: observedAt + QUOTE_MAX_AGE_AT_WALLET_MS,
    sourceBlock: side.block,
    sourceBlockHash: side.blockHash,
    sourceBlockTimestamp: side.blockTimestamp,
  };
}

// Exactly the EIP-1193 send-transaction parameter object the browser will hand to the injected wallet.
// No nonce (the wallet owns it), no gasPrice (EIP-1559 caps only), chainId so the wallet refuses another chain.
export interface WalletTx {
  from: string;
  to: string;
  value: string;
  data: string;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  chainId: string;
}
export function maximumWalletDebit(quote: Quote, gas: GasPlan) {
  return quote.value + gas.recommendedGasLimit * gas.priceCap;
}
export function walletTx(
  quote: Quote,
  gas: GasPlan,
  calldata: string,
): WalletTx {
  return {
    from: PILOT_SCOPE.account,
    to: PILOT_SCOPE.contract,
    value: hex(quote.value),
    data: calldata,
    gas: hex(gas.recommendedGasLimit),
    maxFeePerGas: hex(gas.maxFeePerGas),
    maxPriorityFeePerGas: hex(gas.maxPriorityFeePerGas),
    chainId: PILOT_SCOPE.sourceChainIdHex,
  };
}

const trustOf = (s: SideRead) => ({
  threshold: s.threshold,
  validators: [...(s.bridgeRoles.VALIDATOR_ROLE ?? [])].map(lc).sort(),
  admins: [
    ...new Set(
      [
        ...(s.bridgeRoles.DEFAULT_ADMIN_ROLE ?? []),
        ...(s.bridgeRoles.ADMIN_ROLE ?? []),
      ].map(lc),
    ),
  ].sort(),
  verifierRole: [...(s.bridgeRoles.VERIFIER_ROLE ?? [])].map(lc).sort(),
});

// Normalized owner intent. Derived from the wallet transaction itself (calldata re-decoded with the independent
// codec) plus the observed pins, so the browser and the server can both recompute and compare it.
export function pilotIntent(
  tx: WalletTx,
  gas: GasPlan,
  one: SideRead,
  bsc: SideRead,
) {
  const d = decodeBridgeTokenIndependent(tx.data);
  const value = BigInt(tx.value);
  const gasLimit = BigInt(tx.gas);
  return {
    schema: PILOT_SCHEMA,
    scope: PILOT_SCOPE.label,
    sourceChainId: Number(BigInt(tx.chainId)),
    destinationChainId: Number(d.toChainID),
    from: lc(tx.from),
    to: lc(tx.to),
    recipient: lc(d.to),
    sourceToken: lc(d.fromToken),
    function: PILOT_SCOPE.signature,
    selector: d.selector,
    principal: d.value.toString(),
    networkFee: d.networkFee.toString(),
    serviceFee: d.exFee.toString(),
    otherbridgeFee: "0",
    extraData: d.extraData,
    value: value.toString(),
    calldata: lc(tx.data),
    calldataKeccak256: keccakHex(lc(tx.data)),
    gasLimit: gasLimit.toString(),
    maxFeePerGas: BigInt(tx.maxFeePerGas).toString(),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas).toString(),
    priceCapForExposure: gas.priceCap.toString(),
    maximumWalletDebit: (value + gasLimit * gas.priceCap).toString(),
    expectedReceive: {
      chainId: 56,
      token: lc(PILOT_SCOPE.destinationToken),
      amount: d.value.toString(),
    },
    approval: null,
    routePins: {
      source: {
        proxy: lc(PILOT_SCOPE.contract),
        proxyCodeHash: lc(one.proxyCodeHash),
        implementation: lc(one.implementation),
        implementationCodeHash: lc(one.implementationCodeHash),
        verifier: lc(one.verifier),
        verifierCodeHash: lc(one.verifierCodeHash),
      },
      destination: {
        implementation: lc(bsc.implementation),
        implementationCodeHash: lc(bsc.implementationCodeHash),
        proxyCodeHash: lc(bsc.proxyCodeHash),
        token: lc(bsc.token?.address ?? ""),
        tokenCodeHash: lc(bsc.token?.codeHash ?? ""),
      },
    },
    trust: { source: trustOf(one), destination: trustOf(bsc) },
    trustModelAccepted: true,
  };
}
export type PilotIntent = ReturnType<typeof pilotIntent>;
export const pilotIntentDigest = (intent: PilotIntent) =>
  sha256Hex(canonicalJson(intent));

// Owner-scope gates S1-S6, evaluated on top of the prep gates P1-P20 (which stay byte-for-byte the reviewed logic).
export function pilotScopeGates(i: {
  fees: PilotFees;
  quote: Quote;
  gas: GasPlan;
  tx: WalletTx;
}): Gate[] {
  const gates: Gate[] = [];
  const add = (
    id: string,
    name: string,
    fail: string[],
    reapproval: string[] = [],
  ) =>
    gates.push({
      id,
      name,
      status: fail.length
        ? "FAIL"
        : reapproval.length
          ? "OWNER_REAPPROVAL_REQUIRED"
          : "PASS",
      reasons: [...fail, ...reapproval],
    });
  let d: ReturnType<typeof decodeBridgeTokenIndependent> | null = null;
  try {
    d = decodeBridgeTokenIndependent(i.tx.data);
  } catch (e) {
    void e;
  }
  {
    const r: string[] = [];
    if (!d) r.push("CALLDATA_NOT_CANONICAL_BRIDGE_TOKEN");
    if (i.tx.chainId !== PILOT_SCOPE.sourceChainIdHex)
      r.push("CHAIN_NOT_612055");
    if (!same(i.tx.from, PILOT_SCOPE.account)) r.push("FROM_NOT_OWNER_EOA");
    if (!same(i.tx.to, PILOT_SCOPE.contract)) r.push("TO_NOT_PINNED_ONE_PROXY");
    if (d) {
      if (d.selector !== PILOT_SCOPE.selector)
        r.push("SELECTOR_NOT_BRIDGE_TOKEN");
      if (d.toChainID !== BigInt(PILOT_SCOPE.destinationChainId))
        r.push("DESTINATION_NOT_BSC_56");
      if (!same(d.fromToken, PILOT_SCOPE.sourceToken))
        r.push("SOURCE_TOKEN_NOT_NATIVE_SENTINEL");
      if (!same(d.to, PILOT_SCOPE.recipient)) r.push("RECIPIENT_NOT_OWNER_EOA");
      if (d.extraData !== PILOT_SCOPE.extraData) r.push("EXTRA_DATA_NOT_EMPTY");
      if (BigInt(i.tx.value) !== d.value + d.networkFee + d.exFee)
        r.push("MSG_VALUE_NOT_EXACT_SUM");
      if (d.networkFee !== i.quote.networkFee || d.exFee !== i.quote.serviceFee)
        r.push("CALLDATA_FEES_NOT_FROM_FRESH_QUOTE");
    }
    add("S1", "OWNER_SCOPE_FIXED_FIELDS", r);
  }
  add(
    "S2",
    "PRINCIPAL_EXACTLY_5_ONE",
    i.quote.amount !== PILOT_SCOPE.principal ||
      (d && d.value !== PILOT_SCOPE.principal)
      ? ["PRINCIPAL_NOT_EXACTLY_5_ONE"]
      : [],
  );
  add(
    "S3",
    "MINIMUM_AT_MOST_5_ONE",
    [],
    i.fees.minimum > PILOT_BOUNDS.maxMinimum
      ? [`MINIMUM_ABOVE_5_ONE:${formatUnits18(i.fees.minimum)}`]
      : [],
  );
  add(
    "S4",
    "NETWORK_FEE_AT_MOST_0_18_ONE",
    [],
    i.fees.networkFee > PILOT_BOUNDS.maxNetworkFee
      ? [`NETWORK_FEE_ABOVE_0_18_ONE:${formatUnits18(i.fees.networkFee)}`]
      : [],
  );
  add(
    "S5",
    "SERVICE_FEE_ZERO",
    [],
    i.fees.serviceFee > PILOT_BOUNDS.maxServiceFee
      ? [`SERVICE_FEE_ABOVE_0:${formatUnits18(i.fees.serviceFee)}`]
      : [],
  );
  {
    const debit = maximumWalletDebit(i.quote, i.gas);
    const txDebit = BigInt(i.tx.value) + BigInt(i.tx.gas) * i.gas.priceCap;
    add(
      "S6",
      "MAX_WALLET_DEBIT_AT_MOST_5_18075931_ONE",
      txDebit !== debit ? ["DEBIT_NOT_FROM_GAS_PLAN"] : [],
      debit > PILOT_BOUNDS.maxWalletDebit
        ? [`MAX_WALLET_DEBIT_ABOVE_BOUND:${formatUnits18(debit)}`]
        : [],
    );
  }
  return gates;
}
