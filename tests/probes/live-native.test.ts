import { expect, it, vi } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const audit = vi.hoisted(() => ({
  calls: [] as {
    chain: string;
    method: string;
    params: unknown[];
    at: string;
    result?: unknown;
    error?: unknown;
  }[],
  active: [] as Promise<unknown>[],
}));
vi.mock("../../src/adapters/read-only", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/adapters/read-only")>();
  return {
    ...real,
    rpc: (chain: "one" | "bsc", method: string, params: unknown[] = []) => {
      const call: (typeof audit.calls)[number] = {
        chain,
        method,
        params,
        at: new Date().toISOString(),
      };
      audit.calls.push(call);
      const operation = real.rpc(chain, method, params).then(
        (result) => {
          call.result = result;
          return result;
        },
        (error) => {
          call.error = {
            code: error.code ?? error.message,
            cause: error.cause,
          };
          throw error;
        },
      );
      audit.active.push(operation);
      return operation;
    },
  };
});
import {
  nativeHealth,
  liveQuote,
  nativeTrack,
} from "../../src/adapters/native-service";
import { validateObservation } from "../../src/features/bridge/observation";
import { CROSS, type TransferRecord } from "../../src/core/model";
import { decodeEventLog, toEventSelector, toHex, type Hex } from "viem";
import { rpc } from "../../src/adapters/read-only";
import { nativeReadAbi } from "../../src/adapters/native-abi";
import { READ_ONLY_DEPLOYMENT } from "../../src/adapters/deployment";
import { logSchema } from "../../src/adapters/native-decoder";
it("opt-in actual native reader: public account only, no wallet/provider/signing/deploy", async () => {
  const base =
    process.env.OTHERBRIDGE_EVIDENCE_ROOT ??
    "evidence/otherbridge-v1/repair-r1/native-live-a";
  await mkdir(base, { recursive: true });
  const recorded = JSON.parse(
    await readFile(
      "evidence/otherbridge-v1/repair-r1/live/public-settlement.json",
      "utf8",
    ),
  );
  const raw = recorded.sample;
  const claim: TransferRecord = {
    schema: 1,
    id: "public-native-current-read",
    mode: "mainnet-readonly",
    route: "one-native-to-bsc-cross",
    config: "1",
    sourceChain: 612055,
    destinationChain: 56,
    account: raw.sourceTransaction.from,
    recipient: raw.sourceTransaction.from,
    sourceAsset: "native:ONE",
    token: CROSS,
    amount: "12094599106825003813",
    expected: "12094599106825003813",
    sourceHash: raw.sourceTransaction.hash,
    state: "UNVERIFIED_COMPLETION",
    updatedAt: Date.now(),
  };
  const startedAt = new Date().toISOString();
  const health = await nativeHealth();
  let quote, quoteError, observation, observationError;
  const publicQuoteAttempts: {
    account: string;
    quote?: unknown;
    error?: unknown;
  }[] = [];
  let publicDiscoveryError;
  try {
    quote = await liveQuote(claim.account, "12");
  } catch (e) {
    const error = e as Error & { code?: string };
    quoteError = { code: error.code ?? error.message, cause: error.cause };
  }
  // At most two recent source log pages and three public account candidates.
  // Reading a public EOA's simulation never opens or controls its wallet.
  if (!quote && health.source) {
    try {
      const topic = toEventSelector(
        nativeReadAbi.find(
          (entry) => entry.type === "event" && entry.name === "BridgeInitiated",
        )!,
      );
      const seen = new Set<string>([claim.account.toLowerCase()]);
      const latest = BigInt(health.source.block);
      outer: for (let page = 0; page < 2; page++) {
        const end = latest - BigInt(page * 1000);
        const logs = await rpc("one", "eth_getLogs", [
          {
            address: READ_ONLY_DEPLOYMENT.source,
            fromBlock: toHex(end - 999n),
            toBlock: toHex(end),
            topics: [topic],
          },
        ]);
        if (!Array.isArray(logs) || logs.length > 20)
          throw Error("PUBLIC_SAMPLE_PAGE_LIMIT");
        for (const item of logs.slice().reverse()) {
          const log = logSchema.parse(item);
          const event = decodeEventLog({
            abi: nativeReadAbi,
            topics: log.topics as [Hex, ...Hex[]],
            data: log.data as Hex,
            strict: true,
          });
          if (
            event.eventName !== "BridgeInitiated" ||
            event.args.toChainID !== 56n ||
            event.args.fromToken.toLowerCase() !==
              "0x0000000000000000000000000000000000000001" ||
            event.args.from.toLowerCase() !== event.args.to.toLowerCase()
          )
            continue;
          const account = event.args.from;
          if (seen.has(account.toLowerCase())) continue;
          seen.add(account.toLowerCase());
          const attempt: (typeof publicQuoteAttempts)[number] = { account };
          publicQuoteAttempts.push(attempt);
          try {
            const balance = BigInt(
              String(await rpc("one", "eth_getBalance", [account, "latest"])),
            );
            if (balance < 6n * 10n ** 18n)
              throw Error("PUBLIC_ACCOUNT_BALANCE_BELOW_PROBE_AMOUNT");
            attempt.quote = await liveQuote(account, "5");
          } catch (e) {
            const error = e as Error & { code?: string };
            attempt.error = {
              code: error.code ?? error.message,
              cause: error.cause,
            };
          }
          if (attempt.quote || publicQuoteAttempts.length === 3) break outer;
        }
      }
    } catch (e) {
      const error = e as Error & { code?: string };
      publicDiscoveryError = {
        code: error.code ?? error.message,
        cause: error.cause,
      };
    }
  }
  try {
    observation = validateObservation(claim, await nativeTrack(claim));
  } catch (e) {
    const error = e as Error & { code?: string };
    observationError = {
      code: error.code ?? error.message,
      cause: error.cause,
    };
  }
  await Promise.allSettled(audit.active);
  await writeFile(
    `${base}/native-live-readonly.json`,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        health,
        quote,
        quoteError,
        publicQuoteAttempts,
        publicDiscoveryError,
        publicQuoteProbeBounds: {
          sourceLogPages: 2,
          blocksPerPage: 1000,
          maximumCandidates: 3,
        },
        observation,
        observationError,
        calls: audit.calls,
        signatures: 0,
        broadcasts: 0,
        deployments: 0,
        note: "Current application reader on public historical transfer; reserve/build readiness remains separate. Quote failure is recorded, never replaced with a synthetic result.",
      },
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      healthReasons: health.reasons,
      quote: Boolean(quote),
      quoteError,
      observationState: observation?.record.state,
      observationError,
      calls: audit.calls.length,
    }),
  );
  expect(
    audit.calls.every((call) => !/send|sign|deploy|permit/i.test(call.method)),
  ).toBe(true);
  expect(observation?.record.state).toBe("COMPLETED");
});
