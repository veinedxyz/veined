import { expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
} from "viem";

const audit = vi.hoisted(() => ({
  calls: [] as {
    chain: string;
    endpoint: string;
    request: { jsonrpc: string; id: number; method: string; params: unknown[] };
    startedAt: string;
    finishedAt?: string;
    attempt: number;
    response?: { result: unknown } | { error: unknown };
    transportError?: string;
  }[],
}));

// Passive result/cause recorder: every attempt invokes the unchanged real RPC.
// No synthetic balance, state override, successful response or wallet provider.
vi.mock("../../src/adapters/read-only", async (original) => {
  const real = await original<typeof import("../../src/adapters/read-only")>();
  return {
    ...real,
    rpc: async (
      chain: "one" | "bsc",
      method: string,
      params: unknown[] = [],
    ) => {
      real.validateRpc(method, params);
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (audit.calls.length >= 96) throw Error("RPC_ATTEMPT_LIMIT");
        const entry: (typeof audit.calls)[number] = {
          chain,
          endpoint: real.ENDPOINTS[chain],
          request: { jsonrpc: "2.0", id: 1, method, params },
          startedAt: new Date().toISOString(),
          attempt,
        };
        audit.calls.push(entry);
        try {
          const result = await real.rpc(chain, method, params);
          entry.response = { result };
          return result;
        } catch (caught) {
          const error = caught as Error & { code?: string };
          entry.transportError = error.code ?? error.message;
          if (error.cause !== undefined)
            entry.response = { error: error.cause };
          const transient =
            /^(UPSTREAM_TIMEOUT|UPSTREAM_UNAVAILABLE|RATE_LIMITED)$/.test(
              entry.transportError,
            ) ||
            (entry.transportError === "RPC_ERROR" &&
              /timeout|temporarily|rate limit|too many requests|header not found/i.test(
                JSON.stringify(error.cause),
              ));
          if (attempt === 2 || !transient) throw error;
        } finally {
          entry.finishedAt = new Date().toISOString();
        }
      }
      throw Error("RPC_RETRY_EXHAUSTED");
    },
  };
});

import { rpc } from "../../src/adapters/read-only";
import { nativeSnapshot } from "../../src/adapters/native-service";
import { nativeReadAbi } from "../../src/adapters/native-abi";
import { bridgeAbi } from "../../src/adapters/onebridge";
import { READ_ONLY_DEPLOYMENT as deployment } from "../../src/adapters/deployment";
import { addressSchema, ROUTE, sameAddress } from "../../src/core/model";
import { blockSchema, quantitySchema } from "../../src/adapters/native-decoder";
import { executionGate as productionExecutionGate } from "../../src/routing/model";

const account = "0x28136a77ec8ba3d918114712a588b4095ba12a6b" as const;
const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
// Candidate custom-error signatures are diagnostic labels, not build equivalence.
const errorAbi = parseAbi([
  "error BaseBridgeInvalidAmount()",
  "error BaseBridgeInvalidValue(uint256 expected,uint256 actual)",
  "error RegistryChainPaused(uint256 remoteChainID)",
  "error RegistryTokenPaused(address token)",
  "error RegistryNotExistToken(address token)",
  "error EnforcedPause()",
]);
function decodeRevert(cause: unknown) {
  const values: string[] = [];
  function visit(value: unknown) {
    if (typeof value === "string" && /^0x(?:[a-f0-9]{2}){4,}$/i.test(value))
      values.push(value);
    else if (typeof value === "object" && value !== null)
      Object.values(value).forEach(visit);
  }
  visit(cause);
  for (const data of values) {
    try {
      return {
        data,
        ...decodeErrorResult({ abi: errorAbi, data: data as Hex }),
        provenance:
          "Decoded standard error or observed candidate signature; deployed build remains unverified",
      };
    } catch {
      /* Preserve unknown selector and full RPC cause below. */
    }
  }
  return {
    data: values[0] ?? null,
    selector: values[0]?.slice(0, 10) ?? null,
    decode: "UNKNOWN_OR_ABSENT_REVERT_DATA",
    cause,
  };
}
type Outcome =
  | { ok: true; result: unknown }
  | {
      ok: false;
      code: string;
      cause: unknown;
      revert: ReturnType<typeof decodeRevert>;
    };
async function outcome(method: string, params: unknown[]): Promise<Outcome> {
  try {
    return { ok: true, result: await rpc("one", method, params) };
  } catch (caught) {
    const error = caught as Error & { code?: string };
    return {
      ok: false,
      code: error.code ?? error.message,
      cause: error.cause,
      revert: decodeRevert(error.cause),
    };
  }
}

it("G5-A5 funded public address: actual pinned read-only simulation and adversarial rejection", async () => {
  const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
  if (
    !base ||
    !/^evidence\/otherbridge-v1-2\/g5-funded-address-\d{8}T\d{9}Z$/.test(base)
  )
    throw Error("EXPLICIT_UNIQUE_EVIDENCE_ROOT_REQUIRED");
  const startedAt = new Date().toISOString();
  const report: Record<string, unknown> = {
    startedAt,
    account,
    recipient: account,
    classification: "RPC/OBSERVABILITY_BLOCKED",
    g5A5: "BLOCKED",
    overallG5: "BLOCKED",
    bounds: {
      maximumAttemptsPerRead: 2,
      maximumRpcAttempts: 96,
      dnsTimeoutMs: 8000,
      httpTimeoutMs: 8000,
      responseBytes: 1048576,
      accounts: 1,
      historyScans: 0,
      stateOverrides: 0,
    },
    signatures: 0,
    approvals: 0,
    broadcasts: 0,
    deploys: 0,
    remainingBlockers: [
      "EXACT_DEPLOYMENT_SOURCE_BUILD_UNVERIFIED",
      "SPENDABLE_RESERVE_AND_OBLIGATION_RECONCILIATION_UNVERIFIED",
      "SECOND_PAYOUT_CANONICAL_ONE_ARCHIVE_PROOF_MISSING",
    ],
    note: "RPC responses contain adapter-extracted result/error payloads, not invented wire envelopes. A simulation is not a destination payout or release authorization.",
  };
  const save = (name: string, data: unknown) =>
    writeFile(`${base}/${name}.json`, json(data), { flag: "wx" });
  try {
    addressSchema.parse(account);
    const snapshot = await nativeSnapshot();
    const sourceBlock = snapshot.sourceHead.block.number;
    const destinationBlock = snapshot.destinationHead.block.number;
    report.snapshot = snapshot;
    await save("pinned-block", {
      source: snapshot.sourceHead,
      destination: snapshot.destinationHead,
      sourcePin: snapshot.sourcePin,
      destinationPin: snapshot.destinationPin,
    });
    await save("pair-reads", {
      sourceBlock,
      destinationBlock,
      sourcePair: snapshot.sourcePair,
      destinationPair: snapshot.destinationPair,
      nativeSentinel: snapshot.sourcePair.localToken,
      registeredBscRoute: sameAddress(
        snapshot.sourcePair.remoteToken,
        snapshot.destinationPair.localToken,
      ),
      combinedPaused: snapshot.paused,
      pauseReadNote:
        "Individual raw pause results are retained in request-response.json; combined flag includes both proxies, pair flags and destination finalize pause.",
      reserveAssessment: snapshot.reserveAssessment,
    });
    const native = snapshot.sourcePair.localToken as Hex;
    const amount = snapshot.minimum;
    if (amount <= 1n || snapshot.paused)
      throw Error("CURRENT_MINIMUM_OR_ROUTE_PAUSE_INVALID");
    const feeData = encodeFunctionData({
      abi: nativeReadAbi,
      functionName: "calculateFee",
      args: [56n, native, amount],
    });
    const [
      feeRaw,
      balanceRaw,
      sourceCode,
      destinationCode,
      gasPriceRaw,
      verifierCode,
    ] = await Promise.all([
      rpc("one", "eth_call", [
        { to: deployment.sourceVerifier, data: feeData },
        sourceBlock,
      ]),
      rpc("one", "eth_getBalance", [account, sourceBlock]),
      rpc("one", "eth_getCode", [account, sourceBlock]),
      rpc("bsc", "eth_getCode", [account, destinationBlock]),
      rpc("one", "eth_gasPrice"),
      rpc("one", "eth_getCode", [deployment.sourceVerifier, sourceBlock]),
    ]);
    const [minimum, networkFee, serviceFee] = decodeFunctionResult({
      abi: nativeReadAbi,
      functionName: "calculateFee",
      data: feeRaw as Hex,
    });
    if (
      minimum !== amount ||
      networkFee !== snapshot.networkFee ||
      serviceFee !== (amount * snapshot.feeRate) / snapshot.feeDenominator
    )
      throw Error("LIVE_FEE_CONFIG_DISAGREEMENT");
    if (verifierCode === "0x") throw Error("VERIFIER_NO_CODE");
    const balance = BigInt(quantitySchema.parse(balanceRaw));
    const gasPrice = BigInt(quantitySchema.parse(gasPriceRaw));
    const exactValue = amount + networkFee + serviceFee;
    report.address = {
      validEvmAddress: true,
      observedOnChain: 612055,
      block: sourceBlock,
      code: sourceCode,
      kind:
        sourceCode === "0x"
          ? "EOA_EMPTY_CODE_AT_PINNED_BLOCK"
          : "CONTRACT_OR_DELEGATED_ACCOUNT",
      destinationCode,
      ownershipOrKeyControlProven: false,
    };
    await save("balance", {
      account,
      sourceBlock,
      balanceHex: balanceRaw,
      balanceBaseUnits: balance,
      balanceONE: formatUnits(balance, 18),
      ...(report.address as object),
    });
    const fees = {
      sourceBlock,
      verifier: deployment.sourceVerifier,
      verifierCodeHash: keccak256(verifierCode as Hex),
      minimum,
      networkFee,
      serviceFee,
      feeRate: snapshot.feeRate,
      denominator: snapshot.feeDenominator,
      minimumONE: formatUnits(minimum, 18),
      networkFeeONE: formatUnits(networkFee, 18),
      serviceFeeONE: formatUnits(serviceFee, 18),
      calculationResponse: feeRaw,
    };
    report.fees = fees;
    await save("fee-reads", fees);
    const transaction = (value: bigint, network: bigint, service: bigint) => ({
      from: account,
      to: deployment.source,
      data: encodeFunctionData({
        abi: bridgeAbi,
        functionName: "bridgeToken",
        args: [56n, native, account, value, network, service, "0x"],
      }),
      value: toHex(value + network + service),
    });
    const tx = transaction(amount, networkFee, serviceFee);
    report.transaction = {
      ...tx,
      sourceChainId: 612055,
      destinationChainId: 56,
      block: sourceBlock,
      extraData: "0x",
      exactValueBaseUnits: exactValue,
      exactValueONE: formatUnits(exactValue, 18),
    };
    await save("calldata", report.transaction);
    const [call, estimate] = await Promise.all([
      outcome("eth_call", [tx, sourceBlock]),
      outcome("eth_estimateGas", [tx, sourceBlock]),
    ]);
    report.ethCall = call;
    report.ethEstimateGas = estimate;
    await save("eth-call", {
      transaction: tx,
      block: sourceBlock,
      outcome: call,
    });
    await save("eth-estimateGas", {
      transaction: tx,
      block: sourceBlock,
      outcome: estimate,
    });
    const estimatedGas = estimate.ok
      ? BigInt(quantitySchema.parse(estimate.result))
      : null;
    const estimatedGasCost =
      estimatedGas === null ? null : estimatedGas * gasPrice;
    const gasWith20PercentMargin =
      estimatedGas === null ? null : (estimatedGas * 120n + 99n) / 100n;
    const requiredWithMargin =
      gasWith20PercentMargin === null
        ? null
        : exactValue + gasWith20PercentMargin * gasPrice;
    const funding = {
      amount,
      networkFee,
      serviceFee,
      formula:
        "msg.value = amount + CURRENT network fee + CURRENT service fee; gas is separate",
      exactValue,
      exactValueHex: tx.value,
      balance,
      gasPrice,
      gasPriceBlockContext:
        "eth_gasPrice is the current node suggestion; it has no block-tag parameter",
      estimatedGas,
      estimatedGasCost,
      gasWith20PercentMargin,
      requiredWithMargin,
      requiredWithoutMargin:
        estimatedGasCost === null ? null : exactValue + estimatedGasCost,
      canCoverValue: balance >= exactValue,
      canCoverEstimatedGas:
        estimatedGasCost === null
          ? null
          : balance >= exactValue + estimatedGasCost,
      canCover20PercentMargin:
        requiredWithMargin === null ? null : balance >= requiredWithMargin,
      marginFormula:
        "ceil(estimatedGas * 1.20), matching the existing liveQuote gas budget",
    };
    report.funding = funding;
    await save("exact-msg-value", funding);
    const returnedTrue =
      call.ok &&
      decodeFunctionResult({
        abi: bridgeAbi,
        functionName: "bridgeToken",
        data: call.result as Hex,
      }) === true;
    const errors = [call, estimate].filter((r) => !r.ok);
    const insufficient =
      balance < exactValue ||
      (estimatedGasCost !== null && balance < exactValue + estimatedGasCost);
    const routeRevert = errors.some(
      (r) =>
        !r.ok &&
        (r.revert.data !== null ||
          /execution reverted/i.test(JSON.stringify(r.cause))),
    );
    if (insufficient) report.classification = "INSUFFICIENT_BALANCE";
    else if (routeRevert || (call.ok && !returnedTrue))
      report.classification = "CONTRACT/ROUTE_REVERT";
    else if (
      returnedTrue &&
      estimatedGas !== null &&
      estimatedGas > 21000n &&
      funding.canCover20PercentMargin
    ) {
      const negativeAmount = minimum - 1n;
      const negativeFeeRaw = await rpc("one", "eth_call", [
        {
          to: deployment.sourceVerifier,
          data: encodeFunctionData({
            abi: nativeReadAbi,
            functionName: "calculateFee",
            args: [56n, native, negativeAmount],
          }),
        },
        sourceBlock,
      ]);
      const [negativeMinimum, negativeNetwork, negativeService] =
        decodeFunctionResult({
          abi: nativeReadAbi,
          functionName: "calculateFee",
          data: negativeFeeRaw as Hex,
        });
      const negativeTx = transaction(
        negativeAmount,
        negativeNetwork,
        negativeService,
      );
      const [negativeCall, negativeEstimate] = await Promise.all([
        outcome("eth_call", [negativeTx, sourceBlock]),
        outcome("eth_estimateGas", [negativeTx, sourceBlock]),
      ]);
      const rejected =
        !negativeCall.ok &&
        negativeCall.revert.data !== null &&
        !negativeEstimate.ok &&
        negativeEstimate.revert.data !== null;
      const negative = {
        control: "minimum minus one base unit",
        amount: negativeAmount,
        minimum: negativeMinimum,
        networkFee: negativeNetwork,
        serviceFee: negativeService,
        transaction: negativeTx,
        block: sourceBlock,
        call: negativeCall,
        estimateGas: negativeEstimate,
        contractRejected: rejected,
      };
      report.negativeControl = negative;
      await save("negative-control", negative);
      // Bracket all pinned reads with canonical header rereads, not a latest-state estimate.
      const [sourceAgain, destinationAgain] = await Promise.all([
        rpc("one", "eth_getBlockByNumber", [sourceBlock, false]),
        rpc("bsc", "eth_getBlockByNumber", [destinationBlock, false]),
      ]);
      const canonical =
        blockSchema.parse(sourceAgain).hash ===
          snapshot.sourceHead.block.hash &&
        blockSchema.parse(destinationAgain).hash ===
          snapshot.destinationHead.block.hash;
      report.canonicalRecheck = { sourceAgain, destinationAgain, canonical };
      await save("canonical-recheck", report.canonicalRecheck);
      if (rejected && canonical) {
        report.classification = "POSITIVE_SIMULATION";
        report.g5A5 = "PASS_READ_ONLY_SIMULATION";
      } else
        report.exactBlocker = rejected
          ? "PINNED_BLOCK_CANONICAL_RECHECK_FAILED"
          : "NEGATIVE_CONTROL_NOT_PROVEN";
    }
    if (!report.negativeControl) {
      report.negativeControl = {
        status: "NOT_RUN",
        reason: "Positive simulation prerequisites not met",
      };
      await save("negative-control", report.negativeControl);
    }
  } catch (caught) {
    const error = caught as Error & { code?: string };
    report.exactBlocker = {
      code: error.code ?? error.message,
      cause: error.cause,
      revert: decodeRevert(error.cause),
    };
  } finally {
    report.finishedAt = new Date().toISOString();
    report.rpcAttempts = audit.calls.length;
    report.productionGate = productionExecutionGate;
    report.writeRegistry = {
      sourceContract: ROUTE.sourceContract,
      destinationContract: ROUTE.destinationContract,
    };
    await save("request-response", {
      payloadNote:
        "Exact RPC requests and real adapter-extracted response result/error payloads. No credentials or private material were accessed.",
      calls: audit.calls,
    });
    await save("result", report);
  }
  expect(
    audit.calls.every((c) =>
      [
        "eth_chainId",
        "eth_getBlockByNumber",
        "eth_getStorageAt",
        "eth_getCode",
        "eth_getBalance",
        "eth_gasPrice",
        "eth_call",
        "eth_estimateGas",
      ].includes(c.request.method),
    ),
  ).toBe(true);
  expect(productionExecutionGate).toEqual({
    enabled: false,
    sign: null,
    approve: null,
    broadcast: null,
    deploy: null,
  });
  expect(ROUTE.sourceContract).toBeNull();
  expect(ROUTE.destinationContract).toBeNull();
  // Test PASS means the bounded read-only evidence was recorded, not G5 PASS.
  console.log(
    json({
      evidence: base,
      classification: report.classification,
      g5A5: report.g5A5,
      overallG5: report.overallG5,
      rpcAttempts: audit.calls.length,
      exactBlocker: report.exactBlocker,
    }),
  );
  const original = JSON.parse(await readFile(`${base}/preflight.json`, "utf8"));
  expect(original.acceptedChanged).toEqual([]);
});
