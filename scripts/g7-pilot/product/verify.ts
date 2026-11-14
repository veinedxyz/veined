// Browser-side independent verification of the pilot review (local product pilot). Own copy of the owner-approved
// scope (a unit test proves it equals the server policy), own bridgeToken calldata decoder, own bounds and the
// intent digest recomputed with WebCrypto. The wallet request is only possible when this returns ok.
export const EXPECT = Object.freeze({
  schema: "otherbridge.g7.pilot-intent.v1",
  chainId: 612055,
  chainIdHex: "0x956d7",
  account: "0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c",
  accountDisplay: "0xb6Ded1B18464aED61DB794dFC5cb031B45a7cA2c",
  contract: "0xb81d6e000000000000000000000000000000c0de",
  nativeSentinel: "0x0000000000000000000000000000000000000001",
  cross: "0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510",
  selector: "0x5fd262de",
  signature:
    "bridgeToken(uint256,address,address,uint256,uint256,uint256,bytes)",
  principal: 5000000000000000000n,
  maxNetworkFee: 180000000000000000n,
  maxServiceFee: 0n,
  maxWalletDebit: 5180759310000000000n,
  quoteMaxAgeAtWalletMs: 20000,
  phrase: "G7 5 ONE",
  mockFlag: "isOtherbridgeG7Mock",
  // V1.9: with the Privy layer the page sees the active wallet's EIP-6963 rdns (Privy wallet id), not the raw
  // injected provider object; fixture data may only reach the wallet announcing this rdns (tests only).
  mockRdns: "invalid.otherbridge.g7-mock",
});

export interface PilotTx {
  from: string;
  to: string;
  value: string;
  data: string;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  chainId: string;
}
export interface PilotIntentView {
  schema: string;
  sourceChainId: number;
  destinationChainId: number;
  from: string;
  to: string;
  recipient: string;
  sourceToken: string;
  function: string;
  selector: string;
  principal: string;
  networkFee: string;
  serviceFee: string;
  otherbridgeFee: string;
  extraData: string;
  value: string;
  calldata: string;
  calldataKeccak256: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  priceCapForExposure: string;
  maximumWalletDebit: string;
  expectedReceive: { chainId: number; token: string; amount: string };
  approval: null;
  routePins: {
    source: Record<string, string>;
    destination: Record<string, string>;
  };
  trust: {
    source: TrustView;
    destination: TrustView;
  };
  trustModelAccepted: boolean;
}
export interface TrustView {
  threshold: number;
  validators: string[];
  admins: string[];
  verifierRole: string[];
}
export interface PilotReview {
  intent: PilotIntentView;
  intentDigest: string;
  tx: PilotTx;
}

const TX_KEYS =
  "chainId,data,from,gas,maxFeePerGas,maxPriorityFeePerGas,to,value";
const lc = (s: unknown) => String(s ?? "").toLowerCase();
const eq = (a: unknown, b: unknown) => lc(a) === lc(b);

export function decodeBridgeToken(data: string) {
  if (typeof data !== "string" || !/^0x[0-9a-f]+$/.test(data))
    throw new Error("CALLDATA_NOT_LOWERCASE_HEX");
  if (data.length !== 2 + 8 + 64 * 8)
    throw new Error("CALLDATA_LENGTH_NOT_260_BYTES");
  if (data.slice(0, 10) !== EXPECT.selector)
    throw new Error("SELECTOR_NOT_BRIDGE_TOKEN");
  const w = (i: number) => data.slice(10 + 64 * i, 10 + 64 * (i + 1));
  const addr = (i: number) => {
    if (!/^0{24}/.test(w(i))) throw new Error("DIRTY_ADDRESS_WORD");
    return "0x" + w(i).slice(24);
  };
  if (BigInt("0x" + w(6)) !== 224n) throw new Error("NON_CANONICAL_OFFSET");
  if (BigInt("0x" + w(7)) !== 0n) throw new Error("EXTRA_DATA_NOT_EMPTY");
  return {
    toChainID: BigInt("0x" + w(0)),
    fromToken: addr(1),
    to: addr(2),
    value: BigInt("0x" + w(3)),
    networkFee: BigInt("0x" + w(4)),
    exFee: BigInt("0x" + w(5)),
  };
}
export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonicalize((v as Record<string, unknown>)[k])]),
    );
  return v;
}
export async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function verifyReview(review: PilotReview) {
  const f: string[] = [];
  try {
    const { intent, tx } = review;
    if (Object.keys(tx).sort().join(",") !== TX_KEYS) f.push("TX_KEYS");
    if (tx.chainId !== EXPECT.chainIdHex) f.push("CHAIN_NOT_612055");
    if (!eq(tx.from, EXPECT.account)) f.push("FROM_NOT_PILOT_EOA");
    if (!eq(tx.to, EXPECT.contract)) f.push("TO_NOT_PINNED_PROXY");
    const d = decodeBridgeToken(tx.data);
    if (d.toChainID !== 56n) f.push("DESTINATION_NOT_BSC_56");
    if (!eq(d.fromToken, EXPECT.nativeSentinel))
      f.push("SOURCE_TOKEN_NOT_NATIVE");
    if (!eq(d.to, EXPECT.account)) f.push("RECIPIENT_NOT_PILOT_EOA");
    if (d.value !== EXPECT.principal) f.push("PRINCIPAL_NOT_EXACTLY_5_ONE");
    if (d.networkFee > EXPECT.maxNetworkFee)
      f.push("NETWORK_FEE_ABOVE_0_18_ONE");
    if (d.exFee > EXPECT.maxServiceFee) f.push("SERVICE_FEE_ABOVE_0");
    const value = BigInt(tx.value);
    if (value !== d.value + d.networkFee + d.exFee)
      f.push("MSG_VALUE_NOT_EXACT_SUM");
    const gas = BigInt(tx.gas);
    const maxFee = BigInt(tx.maxFeePerGas);
    const prio = BigInt(tx.maxPriorityFeePerGas);
    const cap = BigInt(intent.priceCapForExposure);
    if (cap < maxFee) f.push("PRICE_CAP_BELOW_MAX_FEE");
    if (prio > maxFee) f.push("PRIORITY_FEE_ABOVE_MAX_FEE");
    const debit = value + gas * cap;
    if (debit > EXPECT.maxWalletDebit)
      f.push("MAX_WALLET_DEBIT_ABOVE_5_18075931_ONE");
    if (String(debit) !== intent.maximumWalletDebit)
      f.push("MAX_WALLET_DEBIT_MISMATCH");
    const checks: [boolean, string][] = [
      [intent.schema === EXPECT.schema, "INTENT_SCHEMA"],
      [
        intent.sourceChainId === EXPECT.chainId &&
          intent.destinationChainId === 56,
        "INTENT_CHAINS",
      ],
      [
        eq(intent.from, tx.from) &&
          eq(intent.to, tx.to) &&
          eq(intent.recipient, d.to),
        "INTENT_ADDRESSES",
      ],
      [eq(intent.sourceToken, EXPECT.nativeSentinel), "INTENT_SOURCE_TOKEN"],
      [
        intent.selector === EXPECT.selector &&
          intent.function === EXPECT.signature,
        "INTENT_FUNCTION",
      ],
      [
        intent.principal === String(d.value) &&
          intent.networkFee === String(d.networkFee) &&
          intent.serviceFee === String(d.exFee),
        "INTENT_AMOUNTS",
      ],
      [
        intent.otherbridgeFee === "0" &&
          intent.extraData === "0x" &&
          intent.approval === null,
        "INTENT_NO_EXTRAS",
      ],
      [
        intent.value === String(value) && eq(intent.calldata, tx.data),
        "INTENT_VALUE_OR_CALLDATA",
      ],
      [
        intent.gasLimit === String(gas) &&
          intent.maxFeePerGas === String(maxFee) &&
          intent.maxPriorityFeePerGas === String(prio),
        "INTENT_GAS",
      ],
      [
        intent.expectedReceive.chainId === 56 &&
          eq(intent.expectedReceive.token, EXPECT.cross) &&
          intent.expectedReceive.amount === String(EXPECT.principal),
        "INTENT_EXPECTED_RECEIVE",
      ],
      [
        intent.trustModelAccepted === true &&
          eq(intent.routePins.source.proxy, EXPECT.contract),
        "INTENT_SCOPE",
      ],
    ];
    for (const [ok, name] of checks) if (!ok) f.push(name);
    const digest = await sha256Hex(JSON.stringify(canonicalize(intent)));
    if (digest !== review.intentDigest) f.push("INTENT_DIGEST_MISMATCH");
    return { ok: f.length === 0, failures: f, digest };
  } catch (e) {
    return {
      ok: false,
      failures: [...f, `VERIFY_ERROR:${(e as Error)?.message ?? e}`],
      digest: null,
    };
  }
}
export const exactTx = (tx: PilotTx): PilotTx => ({
  from: tx.from,
  to: tx.to,
  value: tx.value,
  data: tx.data,
  gas: tx.gas,
  maxFeePerGas: tx.maxFeePerGas,
  maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
  chainId: tx.chainId,
});
export const sameTx = (a: PilotTx, b: PilotTx) =>
  TX_KEYS.split(",").every(
    (k) =>
      typeof a[k as keyof PilotTx] === "string" &&
      a[k as keyof PilotTx] === b[k as keyof PilotTx],
  );
export function units(wei: string | bigint, decimals = 18n) {
  const v = BigInt(wei);
  const base = 10n ** decimals;
  const frac = (v % base)
    .toString()
    .padStart(Number(decimals), "0")
    .replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}
