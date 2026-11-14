import { createHash } from "node:crypto";
import type { PointsEngine } from "./engine";
import type { Category, VerifiedActivity } from "./model";
// Isolated playtest fixtures (VEINED_POINTS_SIMULATION=1 only). Deterministic accounts and simulated verifier
// events; nothing here touches a wallet, an RPC or any real execution path.

const hex = (seed: string, length: number) => {
  let out = "";
  for (let i = 0; out.length < length; i++)
    out += createHash("sha256").update(`${seed}:${i}`).digest("hex");
  return out.slice(0, length);
};
export const fixtureAccount = (name: string) =>
  `0x${hex(`account:${name}`, 40)}`;

export function simulatedEvent(input: {
  id: string;
  account: string;
  category: Category;
  occurredAt: string;
  usd: number;
  outcome?: VerifiedActivity["outcome"];
  operation?: string;
  confirmations?: number;
  finalized?: boolean;
  referralCode?: string;
  chainId?: string;
  verifier?: string;
}): VerifiedActivity {
  const chainId =
    input.chainId ?? (input.category === "BRIDGE" ? "612055" : "56");
  return {
    eventId: input.id,
    verifier: input.verifier ?? "simulated-verifier",
    category: input.category,
    operationKey: `evm:${chainId}:0x${hex(`op:${input.operation ?? input.id}`, 64)}`,
    account: input.account,
    outcome:
      input.outcome ?? (input.category === "BRIDGE" ? "COMPLETED" : "SETTLED"),
    occurredAt: input.occurredAt,
    chainId,
    volumeUsdMicros: BigInt(Math.round(input.usd * 1_000_000)).toString(),
    finality: {
      blockNumber: String(
        1_000_000 + (parseInt(hex(`blk:${input.id}`, 6), 16) % 9_000_000),
      ),
      blockHash: `0x${hex(`block:${input.id}`, 64)}`,
      confirmations: input.confirmations ?? 64,
      finalized: input.finalized ?? true,
    },
    ...(input.category === "BRIDGE"
      ? {
          bridge: {
            destinationChainId: "56",
            destinationTx: `0x${hex(`dst:${input.id}`, 64)}`,
            destinationVerified: true,
          },
        }
      : {}),
    ...(input.referralCode
      ? { attribution: { referralCode: input.referralCode } }
      : {}),
  };
}

/** Seeds a realistic live season 1, including every class of activity that must NOT earn weight. */
export async function seedSimulation(engine: PointsEngine) {
  const start = Date.parse(engine.config.schedule.seasonOneStartsAt);
  const now = engine.now().getTime();
  const span = Math.max(60_000, now - start - 60_000);
  const at = (fraction: number) =>
    new Date(start + Math.floor(span * fraction)).toISOString();
  const ingest = (e: VerifiedActivity) => engine.ingest(e, e.verifier);
  const names = [
    "atlas",
    "boreal",
    "cinder",
    "delta",
    "ember",
    "fjord",
    "garnet",
    "harbor",
  ];
  const acct = Object.fromEntries(names.map((n) => [n, fixtureAccount(n)]));
  let n = 0;
  const id = (tag: string) => `fx-${tag}-${++n}`;
  await ingest(
    simulatedEvent({
      id: id("swap"),
      account: acct.atlas,
      category: "SWAP",
      occurredAt: at(0.05),
      usd: 2_500,
    }),
  );
  await ingest(
    simulatedEvent({
      id: id("bridge"),
      account: acct.atlas,
      category: "BRIDGE",
      occurredAt: at(0.1),
      usd: 8_000,
    }),
  );
  const atlasCode = (await engine.referralCode(acct.atlas, true))!.code;
  await ingest(
    simulatedEvent({
      id: id("swap"),
      account: acct.boreal,
      category: "SWAP",
      occurredAt: at(0.15),
      usd: 900,
      referralCode: atlasCode,
    }),
  );
  await ingest(
    simulatedEvent({
      id: id("trade"),
      account: acct.boreal,
      category: "TRADE",
      occurredAt: at(0.2),
      usd: 4_200,
    }),
  );
  await ingest(
    simulatedEvent({
      id: id("swap"),
      account: acct.cinder,
      category: "SWAP",
      occurredAt: at(0.25),
      usd: 150,
      referralCode: atlasCode,
    }),
  );
  // A very large swap: volume is capped per activity and sqrt-weighted, so it cannot dominate the pool.
  await ingest(
    simulatedEvent({
      id: id("whale"),
      account: acct.delta,
      category: "SWAP",
      occurredAt: at(0.3),
      usd: 25_000_000,
    }),
  );
  await ingest(
    simulatedEvent({
      id: id("bridge"),
      account: acct.ember,
      category: "BRIDGE",
      occurredAt: at(0.35),
      usd: 640,
    }),
  );
  const emberCode = (await engine.referralCode(acct.ember, true))!.code;
  await ingest(
    simulatedEvent({
      id: id("swap"),
      account: acct.fjord,
      category: "SWAP",
      occurredAt: at(0.4),
      usd: 75,
      referralCode: emberCode,
    }),
  );
  // Ineligible on purpose: failed, quote, unsigned intent, cancelled, below minimum, unverified bridge destination.
  await ingest(
    simulatedEvent({
      id: id("failed"),
      account: acct.garnet,
      category: "SWAP",
      occurredAt: at(0.45),
      usd: 500,
      outcome: "FAILED",
    }),
  );
  await ingest(
    simulatedEvent({
      id: id("quote"),
      account: acct.garnet,
      category: "SWAP",
      occurredAt: at(0.46),
      usd: 500,
      outcome: "QUOTE",
    }),
  );
  await ingest(
    simulatedEvent({
      id: id("intent"),
      account: acct.garnet,
      category: "TRADE",
      occurredAt: at(0.47),
      usd: 500,
      outcome: "UNSIGNED_INTENT",
    }),
  );
  await ingest(
    simulatedEvent({
      id: id("cancel"),
      account: acct.garnet,
      category: "TRADE",
      occurredAt: at(0.48),
      usd: 500,
      outcome: "CANCELLED",
    }),
  );
  await ingest(
    simulatedEvent({
      id: id("dust"),
      account: acct.garnet,
      category: "SWAP",
      occurredAt: at(0.49),
      usd: 2,
    }),
  );
  const bridge = simulatedEvent({
    id: id("bridge-unverified"),
    account: acct.garnet,
    category: "BRIDGE",
    occurredAt: at(0.5),
    usd: 300,
  });
  await ingest({
    ...bridge,
    bridge: { ...bridge.bridge!, destinationVerified: false },
  });
  // The same settlement reported as a swap and again as a trade: counted once.
  await ingest(
    simulatedEvent({
      id: id("dup-a"),
      account: acct.harbor,
      category: "SWAP",
      occurredAt: at(0.55),
      usd: 1_200,
      operation: "harbor-op",
    }),
  );
  await ingest(
    simulatedEvent({
      id: id("dup-b"),
      account: acct.harbor,
      category: "TRADE",
      occurredAt: at(0.55),
      usd: 1_200,
      operation: "harbor-op",
    }),
  );
  // Exact replay of an accepted event: a no-op.
  const replay = simulatedEvent({
    id: id("replay"),
    account: acct.harbor,
    category: "SWAP",
    occurredAt: at(0.6),
    usd: 300,
  });
  await ingest(replay);
  await ingest(replay);
  // Self-referral attempt is refused (the account already has activity and its own code).
  await ingest(
    simulatedEvent({
      id: id("self"),
      account: acct.ember,
      category: "SWAP",
      occurredAt: at(0.65),
      usd: 220,
      referralCode: emberCode,
    }),
  );
  // Pending finality, then a reorganisation of another event.
  await ingest(
    simulatedEvent({
      id: id("pending"),
      account: acct.cinder,
      category: "SWAP",
      occurredAt: at(0.7),
      usd: 600,
      confirmations: 2,
      finalized: false,
    }),
  );
  const reorged = simulatedEvent({
    id: id("reorg"),
    account: acct.boreal,
    category: "SWAP",
    occurredAt: at(0.75),
    usd: 3_000,
  });
  await ingest(reorged);
  await engine.reverse(
    reorged.eventId,
    "REORG_BLOCK_CHANGED",
    reorged.verifier,
  );
  return { accounts: acct, codes: { atlas: atlasCode, ember: emberCode } };
}
