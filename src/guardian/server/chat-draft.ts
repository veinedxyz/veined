// Server-side Guardian review of a chat draft (SERVER ONLY). The chat engine in the browser only understands words;
// identity and safety are decided here, from VEINED's own data: a symbol is resolved to an exact contract only through
// the asset registry (canonical and curated entries), an exact contract is looked up as given, and the draft is then
// reviewed by the same deterministic Guardian rules as Swap, Bridge and the NEAR route. The client can never send a
// level, a decision or an identity it wants trusted (the request schema is strict). This path reads local data only:
// it makes no upstream request (no RPC, no price, no DEX, no AI), so it works offline and costs nothing per request.
import { knownAsset, registryFor } from "../../assets/registry";
import type { RegistryAsset } from "../../assets/model";
import { displayText } from "../support";
import {
  finding,
  type AssetFacts,
  type Finding,
  type SafeStep,
} from "../model";
import { review, reviewAsset, reviewIntents } from "../verdict";
import { INTENTS_KNOWN_ASSETS, type IntentsRouteFacts } from "../intents";
import { swapAssetFacts } from "./swap-gate";
import {
  CHAT_CHAINS,
  CHAT_DRAFT_POLICY,
  compareDecimal,
  decisionOf,
  draftLimit,
  toUnits,
  type ChainKey,
  type ChatDraft,
  type ChatDraftRequest,
  type ChatDraftResult,
  type ChatTokenRequest,
  type ChatTokenResult,
  type DraftNeed,
  type ResolvedToken,
  type TokenOption,
} from "../chat/model";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonical } from "../support";

type Ref = ChatDraftRequest["pay"];
const TRUSTED = new Set(["CANONICAL", "CURATED"]);
const option = (a: RegistryAsset): TokenOption => ({
  symbol: a.symbol,
  name: a.name,
  address: a.address,
  level: a.level,
});
const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
/** `a` appears in `b` in order (USDC in USDbC, axlUSDC, USDC.e): a similar name, never the same asset. */
function within(a: string, b: string) {
  let i = 0;
  for (const ch of b) if (ch === a[i]) i++;
  return i === a.length;
}

/** Resolve one token reference on one EVM network: exact contract as given, or a symbol through the registry. */
export function resolveToken(
  chain: ChainKey,
  ref: Ref,
  slot: "pay" | "receive",
): { token: ResolvedToken } | { need: DraftNeed } {
  const c = CHAT_CHAINS[chain];
  if (ref.address) {
    const known = knownAsset(c.id, ref.address, false);
    return {
      token: {
        chainId: c.id,
        address: ref.address.toLowerCase(),
        // The registry's name for a known contract; otherwise the name the user claimed (display text only).
        symbol: known?.symbol ?? (displayText(ref.symbol ?? "", 16) || "?"),
        name: known?.name ?? null,
        decimals: known?.decimals ?? null,
        native: false,
        level: known?.level ?? null,
      },
    };
  }
  const q = (ref.symbol ?? "").toUpperCase();
  if (q === c.native) {
    const native = knownAsset(c.id, "", true);
    return {
      token: {
        chainId: c.id,
        address: native?.address ?? "native",
        symbol: c.native,
        name: native?.name ?? null,
        decimals: native?.decimals ?? 18,
        native: true,
        level: "CANONICAL",
      },
    };
  }
  const trusted = registryFor(c.id).filter(
    (a) => TRUSTED.has(a.level) && !a.native,
  );
  const exact = trusted.filter((a) => a.symbol.toUpperCase() === q);
  if (exact.length === 1) {
    const a = exact[0];
    return {
      token: {
        chainId: c.id,
        address: a.address,
        symbol: a.symbol,
        name: a.name,
        decimals: a.decimals,
        native: false,
        level: a.level,
      },
    };
  }
  if (exact.length > 1)
    return {
      need: {
        slot,
        reason: "AMBIGUOUS",
        symbol: displayText(ref.symbol ?? "", 16),
        chain,
        options: exact.slice(0, 4).map(option),
      },
    };
  // No verified token carries this name here. Similar names are different assets: offered, never substituted.
  const qq = alnum(q);
  const similar =
    qq.length >= 3
      ? trusted.filter((a) => {
          const s = alnum(a.symbol);
          return (
            s.length >= 3 &&
            Math.abs(s.length - qq.length) <= 3 &&
            (within(qq, s) || within(s, qq))
          );
        })
      : [];
  return {
    need: {
      slot,
      reason: "UNKNOWN_SYMBOL",
      symbol: displayText(ref.symbol ?? "", 16),
      chain,
      options: similar.slice(0, 4).map(option),
    },
  };
}

const assetFacts = (t: ResolvedToken): AssetFacts =>
  swapAssetFacts(t.chainId, {
    chain: t.chainId,
    address: t.address,
    decimals: t.decimals ?? 18,
    symbol: t.symbol,
    native: t.native,
  });

/** Chat-draft amount policy: findings that can only add caution, never remove any. */
function amountPolicy(
  r: ChatDraftRequest,
  pay: ResolvedToken,
): { findings: Finding[]; steps: SafeStep[] } {
  const findings: Finding[] = [],
    steps: SafeStep[] = [];
  const trusted = pay.native || (pay.level !== null && TRUSTED.has(pay.level));
  const limit = trusted ? draftLimit(pay.symbol) : undefined;
  if (limit && compareDecimal(r.amount, limit.limit) >= 0) {
    findings.push(
      finding("DRAFT_LARGE_AMOUNT", "WARNING", "EXECUTION", {
        amount: r.amount,
        symbol: displayText(pay.symbol, 16),
        limit: limit.limit,
      }),
    );
    steps.push("REDUCE_AMOUNT", "TEST_TRANSFER");
  }
  if (r.balance !== undefined && compareDecimal(r.amount, r.balance) > 0) {
    findings.push(
      finding("DRAFT_EXCEEDS_BALANCE", "WARNING", "EXECUTION", {
        symbol: displayText(pay.symbol, 16),
      }),
    );
    steps.push("REDUCE_AMOUNT");
  }
  return { findings, steps };
}

const NEAR_ASSETS: Record<string, string> = {
  WNEAR: "nep141:wrap.near",
  NEAR: "nep141:wrap.near",
  USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  USDT: "nep141:usdt.tether-token.near",
};
function intentsToken(assetId: string): ResolvedToken | null {
  const t = INTENTS_KNOWN_ASSETS.find((a) => a.assetId === assetId);
  if (!t) return null;
  return {
    chainId: t.blockchain,
    address: t.contractAddress ?? assetId,
    symbol: t.symbol,
    name: null,
    decimals: t.decimals,
    native: t.blockchain !== "near",
    level: "CURATED",
    assetId: t.assetId,
  };
}

const draftId = (value: unknown) =>
  bytesToHex(sha256(utf8ToBytes(canonical(value)))).slice(0, 16);

/** Review one chat draft. Pure over local data; `now` only decides freshness. */
export function chatDraft(
  r: ChatDraftRequest,
  now = Date.now(),
): ChatDraftResult {
  const src = CHAT_CHAINS[r.source],
    dst = CHAT_CHAINS[r.destination];
  if (r.kind === "swap") {
    if (!src.swap) return { state: "UNSUPPORTED", reason: "SWAP_CHAIN" };
    if (r.source !== r.destination)
      return { state: "UNSUPPORTED", reason: "SAME_CHAIN" };
  } else if (r.kind === "bridge") {
    if (!src.bridge || !dst.bridge)
      return { state: "UNSUPPORTED", reason: "BRIDGE_CHAIN" };
    if (r.source === r.destination)
      return { state: "UNSUPPORTED", reason: "SAME_CHAIN" };
  } else if (
    r.destination !== "near" ||
    !src.intents ||
    src.intents === "near" ||
    r.source === "near"
  )
    return { state: "UNSUPPORTED", reason: "INTENTS_ORIGIN" };
  if (compareDecimal(r.amount, "0") <= 0)
    return {
      state: "NEEDS",
      needs: [
        {
          slot: "amount",
          reason: "AMOUNT_PRECISION",
          chain: r.source,
          options: [],
        },
      ],
    };

  let pay: ResolvedToken, receive: ResolvedToken;
  if (r.kind === "near") {
    // Routes toward NEAR use only the reviewed NEAR Intents assets (exact asset ids, never a symbol match upstream).
    if (r.pay.address || (r.pay.symbol ?? "").toUpperCase() !== "ETH")
      return { state: "UNSUPPORTED", reason: "INTENTS_ASSET" };
    const origin = INTENTS_KNOWN_ASSETS.find(
      (a) => a.blockchain === src.intents && a.symbol === "ETH",
    );
    const target = NEAR_ASSETS[(r.receive.symbol ?? "").toUpperCase()];
    if (!origin || !target || r.receive.address)
      return { state: "UNSUPPORTED", reason: "TOKEN_ON_NEAR" };
    pay = intentsToken(origin.assetId)!;
    receive = intentsToken(target)!;
  } else {
    const needs: DraftNeed[] = [];
    const a = resolveToken(r.source, r.pay, "pay");
    const b = resolveToken(r.destination, r.receive, "receive");
    if ("need" in a) needs.push(a.need);
    if ("need" in b) needs.push(b.need);
    if (needs.length || !("token" in a) || !("token" in b))
      return { state: "NEEDS", needs };
    pay = a.token;
    receive = b.token;
  }
  const raw = pay.decimals === null ? null : toUnits(r.amount, pay.decimals);
  if (pay.decimals !== null && raw === null)
    return {
      state: "NEEDS",
      needs: [
        {
          slot: "amount",
          reason: "AMOUNT_PRECISION",
          chain: r.source,
          options: [],
        },
      ],
    };
  const policy = amountPolicy(r, pay);
  const sender = r.sender ?? "";
  let verdict;
  if (r.kind === "near") {
    const facts: IntentsRouteFacts = {
      origin: {
        assetId: pay.assetId!,
        blockchain: pay.chainId,
        symbol: pay.symbol,
      },
      destination: {
        assetId: receive.assetId!,
        blockchain: "near",
        symbol: receive.symbol,
        contractAddress: receive.address,
      },
      sender,
      refundTo: sender,
      recipient: r.recipient ?? "",
    };
    verdict = reviewIntents(facts, now, policy.findings, policy.steps);
  } else if (r.kind === "swap") {
    verdict = review(
      {
        kind: "swap",
        chainId: src.id,
        ecosystem: "EVM",
        sender,
        recipient: r.recipient ?? sender,
        pay: assetFacts(pay),
        receive: assetFacts(receive),
        known: sender ? [sender] : [],
      },
      now,
      policy.findings,
      policy.steps,
    );
  } else {
    verdict = review(
      {
        kind: "bridge",
        sourceChain: src.id,
        destinationChain: dst.id,
        sender,
        recipient: r.recipient ?? sender,
        pay: assetFacts(pay),
        receive: assetFacts(receive),
        known: sender ? [sender] : [],
      },
      now,
      policy.findings,
      policy.steps,
    );
  }
  const draft: ChatDraft = {
    id: draftId({ r, digest: verdict.digest }),
    kind: r.kind,
    source: r.source,
    destination: r.destination,
    pay,
    receive,
    amount: r.amount,
    rawAmount: raw === null ? null : raw.toString(),
    recipient: r.recipient ?? null,
    sender: r.sender ?? null,
    executable: false,
  };
  return {
    state: "DRAFT",
    draft,
    verdict,
    decision: decisionOf(verdict.level),
    policy: CHAT_DRAFT_POLICY.version,
  };
}

/** "Is this token safe?": registry evidence for one exact token, reviewed by Guardian's asset rules. */
export function chatToken(r: ChatTokenRequest): ChatTokenResult {
  if (r.chain === "near") return { token: null };
  const resolved = resolveToken(r.chain, r.token, "pay");
  if ("need" in resolved) return { token: null, needs: resolved.need };
  return {
    token: resolved.token,
    verdict: reviewAsset(assetFacts(resolved.token)),
  };
}
