// Guardian chat engine: a deterministic conversation state machine. It reads one message (or one structured choice),
// classifies it into a small set of supported intents, fills typed draft slots, asks for what is missing and composes
// replies from localized templates. It never calls the network itself: anything that needs a fact it does not have
// (registry evidence, Guardian's review, a dry quote) is returned as an explicit effect for the UI to run against
// VEINED's own /api/guardian, and the outcome is fed back through `settle`. Pure and bounded: the same state, input,
// context and time always give the same result; state lives only in memory, is short-lived and is never persisted.
import type { Level, Verdict } from "../model";
import { validIdentity } from "../support";
import {
  CHAT_CHAINS,
  CHAT_DRAFT_POLICY,
  chainName,
  decisionOf,
  type ChainKey,
  type ChatDraftRequest,
  type ChatDraftResult,
  type ChatTokenRequest,
  type ChatTokenResult,
  type Decision,
  type DraftKind,
  type DraftNeed,
  type TokenOption,
} from "./model";
import { parse, type Parsed, type TokenMention } from "./parse";

// ---- Context: what the current page shows (published by VEINED's surfaces) ---------------------------------------
export type PageKey =
  | "overview"
  | "swap"
  | "bridge"
  | "portfolio"
  | "points"
  | "activity"
  | "networks"
  | "help"
  | "guardian"
  | "other";
export interface PageFacts {
  swap?: {
    network: string;
    chain: ChainKey | null;
    pay?: { symbol: string; address: string; native: boolean };
    receive?: { symbol: string; address: string; native: boolean };
    quote?: {
      provider: string;
      minOut: string;
      impact: string | null;
      expiresAt: number;
      count: number;
      /** gf1 G04: the network-fee line exactly as the quote card shows it (already localized), or null when unknown. */
      fee?: string | null;
    };
    verdict?: Verdict;
  };
  bridge?: {
    source: string;
    destination: string;
    pay: string;
    receive: string;
    quote?: { receive: string; seconds: number | null; valid: boolean };
    verdict?: Verdict;
  };
  portfolio?: {
    scanned: boolean;
    assets: number;
    unpriced: number;
    hidden: number;
    /** gf1 G04: networks the coverage card shows as not read yet (pending) or not readable (failed). */
    pending?: number;
    failed?: number;
    verdict?: Verdict;
  };
  /** gf1 G04: the route the Bridge form shows before any quote (network names and token symbols only). */
  bridgeRoute?: {
    source: string;
    destination: string;
    pay: string;
    receive: string;
    /** The form refuses this pair, so no quote can come (nothing is said about quotes). */
    unavailable?: boolean;
  };
  /** gf1 G04: the first step's state on Overview (wallet connected, an address scanned, or neither). */
  overview?: { step: "connected" | "scanned" | "pending" };
  /** gf1 G04: the record counts the Activity filters show (records kept in this browser only). */
  activity?: { transfers: number; pending: number; completed: number };
  networks?: {
    total: number;
    bridge: number;
    swap: number;
    tokens: number;
    native: number;
    none: number;
    testnets: number;
  };
}
export interface ChatContext {
  page: PageKey;
  /** The UI language understands typed requests (English or Turkish). */
  understood: boolean;
  facts: PageFacts;
  /** The connected wallet's own address (sender and refund of drafts); never displayed by the engine. */
  wallet: string | null;
  /** Pay-token balance from the user's own Portfolio scan, in display units, when known. */
  balance?: (
    chain: ChainKey,
    symbol: string,
    address?: string,
  ) => string | null;
  product: { referralPercent: string };
}

// ---- Conversation model ---------------------------------------------------------------------------------------
export type Params = Record<string, string | number>;
export interface Text {
  key: string;
  params?: Params;
}
export type Block =
  | ({ t: "text" } & Text)
  | ({ t: "note"; tone: "info" | "warn" | "danger" } & Text)
  | { t: "list"; items: Text[] }
  | { t: "levels" }
  | { t: "points" }
  | { t: "draft"; id: string }
  | {
      t: "verdict";
      verdict: Verdict;
      testId: string;
      /** gf1 G03: where a re-shown verdict comes from — the page's own review in this browser, or an earlier draft's
       * server review (with the draft's id). A new server review (token, address) has neither. */
      origin?: "page" | "draft";
      draft?: string;
    };
export interface Message {
  id: string;
  from: "user" | "guardian";
  text?: string;
  blocks?: Block[];
}
export type Slot =
  | "kind"
  | "amount"
  | "pay"
  | "receive"
  | "source"
  | "destination"
  | "recipient"
  | "refund"
  | "check"
  | "address";
export type Example =
  | "swap"
  | "bridge"
  | "near"
  | "token"
  | "address"
  | "levels"
  | "points"
  | "networks"
  | "explainQuote"
  | "quoteGuide"
  | "whyBlocked"
  | "routeRisk"
  | "unpriced"
  | "help"
  | "best"
  | "page"
  | "activity";
export type ChipAction =
  | { a: "example"; id: Example }
  | { a: "chain"; slot: "source" | "destination" | "check"; chain: ChainKey }
  | {
      a: "token";
      slot: "pay" | "receive" | "check";
      symbol: string;
      address?: string;
    }
  | { a: "amount"; value: string }
  | { a: "kind"; kind: DraftKind }
  | { a: "continue" }
  | { a: "reset" }
  | { a: "quote"; draft: string }
  | { a: "recheck"; draft: string }
  | { a: "inspect"; value: string }
  | { a: "open"; draft: string; ack: boolean }
  | {
      a: "go";
      to: "/swap" | "/bridge" | "/portfolio" | "/networks" | "/points";
    };
export interface Chip {
  id: string;
  label: Text;
  action: ChipAction;
}
export type Effect =
  | { e: "draft"; id: string; request: ChatDraftRequest }
  | { e: "token"; request: ChatTokenRequest; symbol: string }
  | { e: "inspect"; value: string }
  | { e: "quote"; id: string }
  | { e: "recheck"; id: string }
  | { e: "open"; id: string };
export interface QuoteState {
  status: "loading" | "ready" | "failed";
  verdict?: Verdict;
  amountOut?: string;
  issuedAt?: number | null;
  signature?: string;
  error?: string;
  /** The signed request/response pair as received (re-checked by the server, never trusted by the client). */
  signed?: { request: Record<string, unknown>; response: unknown };
}
export interface DraftEntry {
  id: string;
  request: ChatDraftRequest;
  at: number;
  status: "reviewing" | "ready" | "failed";
  result?: Extract<ChatDraftResult, { state: "DRAFT" }>;
  quote?: QuoteState;
}
interface TokenRef {
  symbol?: string;
  address?: string;
}
export interface Slots {
  kind?: DraftKind;
  amount?: string;
  pay?: TokenRef;
  receive?: TokenRef;
  source?: ChainKey;
  destination?: ChainKey;
  recipient?: string;
  /** The name the user gave a token Guardian could not resolve; kept for the contract they paste next. */
  claimed?: { pay?: string; receive?: string };
  started: number;
}
export interface ChatState {
  v: 1;
  session: string;
  seq: number;
  messages: Message[];
  chips: Chip[];
  slots: Slots | null;
  awaiting: Slot | null;
  /** Network for a pending token check ("is this token safe?"). */
  check: { chain?: ChainKey; token?: TokenRef } | null;
  drafts: Record<string, DraftEntry>;
  order: string[];
  quotes: number;
  reviews: number[];
  misses: number;
  touched: number;
}
export interface Turn {
  state: ChatState;
  effects: Effect[];
}

const MAX_MESSAGES = 40;
const MAX_DRAFTS = 6;
const K = (key: string, params?: Params): Text =>
  params
    ? { key: `guardian.chat.${key}`, params }
    : { key: `guardian.chat.${key}` };
const say = (key: string, params?: Params): Block => ({
  t: "text",
  ...K(key, params),
});
const note = (
  tone: "info" | "warn" | "danger",
  key: string,
  params?: Params,
): Block => ({ t: "note", tone, ...K(key, params) });
const chip = (id: string, label: Text, action: ChipAction): Chip => ({
  id,
  label,
  action,
});
const EXAMPLE_LABEL: Record<Example, string> = {
  swap: "c.swap",
  bridge: "c.bridge",
  near: "c.near",
  token: "c.token",
  address: "c.address",
  levels: "c.levels",
  points: "c.points",
  networks: "c.networks",
  explainQuote: "c.explainQuote",
  quoteGuide: "c.explainQuote",
  whyBlocked: "c.whyBlocked",
  routeRisk: "c.routeRisk",
  unpriced: "c.unpriced",
  help: "c.help",
  best: "c.best",
  page: "c.page",
  activity: "c.activity",
};
const example = (id: Example) =>
  chip(`x-${id}`, K(EXAMPLE_LABEL[id]), { a: "example", id });

/** Pages with their own guide ("what can I do here?"); the Guardian page is the full conversation itself. */
const GUIDED: readonly PageKey[] = [
  "overview",
  "swap",
  "bridge",
  "portfolio",
  "points",
  "activity",
  "networks",
  "help",
];
/** The page-specific suggestions, without the page guide itself. */
function pageActions(page: PageKey): Example[] {
  return page === "swap"
    ? ["explainQuote", "token", "whyBlocked", "swap"]
    : page === "bridge"
      ? ["routeRisk", "whyBlocked", "bridge", "levels"]
      : page === "portfolio"
        ? ["unpriced", "token", "address", "help"]
        : page === "points"
          ? ["points", "levels", "help"]
          : page === "networks"
            ? ["networks", "bridge", "near"]
            : page === "overview"
              ? ["swap", "bridge", "token", "levels"]
              : page === "activity"
                ? ["activity", "bridge", "levels"]
                : page === "help"
                  ? ["levels", "token", "address", "help"]
                  : ["swap", "bridge", "near", "token", "address", "levels"];
}
/** Suggestions that fit the page the user is on (gf1 G04: led by "What can I do here?" on every guided page). */
export function pageChips(page: PageKey): Chip[] {
  const ids = pageActions(page);
  return (GUIDED.includes(page) ? ["page" as const, ...ids] : ids).map(example);
}
/** gf1 G04: the user moved to another page while the conversation stays open. Suggestions follow the new page unless
 * Guardian is waiting for an answer or a draft is in progress (those keep their own choices). Nothing else changes. */
export function repage(state: ChatState, ctx: ChatContext): ChatState {
  // Decided by the choices on screen, not by flags a later question may have left behind. A draft in progress, or a
  // question offering only its own choices (address, token, network, draft steps), stays as it is. Otherwise the idle
  // example and "go" suggestions are replaced by the new page's, and a choice of the reply's own (a ready draft's quote,
  // an address to inspect) stays first.
  const own = state.chips.filter(
    (c) => c.action.a !== "example" && c.action.a !== "go",
  );
  // gf1 G05 (review R3-N2): a draft in progress keeps its own choices too, and its idle suggestions follow the page.
  if (own.length === state.chips.length && (own.length || state.slots))
    return state;
  const fresh = pageChips(ctx.page);
  return {
    ...state,
    chips: own.length
      ? [...own, ...fresh.slice(0, state.chips.length - own.length)]
      : fresh,
  };
}

export function initial(
  ctx: ChatContext,
  now: number,
  session: string,
): ChatState {
  const state: ChatState = {
    v: 1,
    session,
    seq: 0,
    messages: [],
    chips: [],
    slots: null,
    awaiting: null,
    check: null,
    drafts: {},
    order: [],
    quotes: 0,
    reviews: [],
    misses: 0,
    touched: now,
  };
  const blocks: Block[] = [say("r.hello")];
  if (!ctx.understood) blocks.push(note("info", "languageNote"));
  return push(state, blocks, pageChips(ctx.page));
}

function push(state: ChatState, blocks: Block[], chips?: Chip[]): ChatState {
  if (!blocks.length) return chips ? { ...state, chips } : state;
  const seq = state.seq + 1;
  const messages = [
    ...state.messages,
    { id: `${state.session}-${seq}`, from: "guardian" as const, blocks },
  ].slice(-MAX_MESSAGES);
  return { ...state, seq, messages, chips: chips ?? state.chips };
}
function pushUser(state: ChatState, text: string): ChatState {
  const seq = state.seq + 1;
  const messages = [
    ...state.messages,
    { id: `${state.session}-${seq}`, from: "user" as const, text },
  ].slice(-MAX_MESSAGES);
  return { ...state, seq, messages };
}

// ---- Entry points -----------------------------------------------------------------------------------------------
/** A typed message. */
export function send(
  state: ChatState,
  input: string,
  ctx: ChatContext,
  now: number,
): Turn {
  const p = parse(input);
  if (!p.clean && !p.tooLong) return { state, effects: [] };
  let s = pushUser(expire(state, now), p.tooLong ? p.clean + "…" : p.clean);
  s = { ...s, touched: now };
  const out = new Out();
  if (s !== state && state.slots && !s.slots)
    out.blocks.push(note("info", "r.expired"));
  understand(s, p, ctx, now, out);
  return out.finish(s, ctx);
}
/** A structured choice (suggestion chip or card button): language-independent, never parsed as text. */
export function choose(
  state: ChatState,
  action: ChipAction,
  label: string,
  ctx: ChatContext,
  now: number,
): Turn {
  let s = pushUser(expire(state, now), label);
  s = { ...s, touched: now };
  const out = new Out();
  switch (action.a) {
    case "example":
      runExample(s, action.id, ctx, now, out);
      break;
    case "chain":
      if (action.slot === "check") {
        out.check = { ...s.check, chain: action.chain };
        tokenCheck(s, out);
      } else if (s.slots) {
        out.slots = { ...s.slots, [action.slot]: action.chain };
        if (action.slot === "source" && out.slots.kind === "swap")
          out.slots.destination = action.chain;
        advance(s, out, ctx, now);
      }
      break;
    case "token":
      if (action.slot === "check") {
        out.check = {
          ...s.check,
          token: { symbol: action.symbol, address: action.address },
        };
        tokenCheck(s, out);
      } else if (s.slots) {
        out.slots = {
          ...s.slots,
          [action.slot]: { symbol: action.symbol, address: action.address },
        };
        advance(s, out, ctx, now);
      }
      break;
    case "amount":
      if (s.slots) {
        out.slots = { ...s.slots, amount: action.value };
        advance(s, out, ctx, now);
      }
      break;
    case "kind":
      out.slots = { ...(s.slots ?? { started: now }), kind: action.kind };
      if (action.kind === "near") out.slots.destination = "near";
      if (action.kind === "swap" && out.slots.source)
        out.slots.destination = out.slots.source;
      advance(s, out, ctx, now);
      break;
    case "continue":
      if (s.slots) advance(s, out, ctx, now);
      else out.blocks.push(say("r.nothingPending"));
      break;
    case "reset":
      reset(out);
      break;
    case "quote":
      requestQuote(s, action.draft, out, ctx, now);
      break;
    case "recheck":
      if (s.drafts[action.draft]?.quote?.signed)
        out.effects.push({ e: "recheck", id: action.draft });
      break;
    case "inspect":
      out.effects.push({ e: "inspect", value: action.value });
      // An address chosen as a suggestion answers a pending "which address?" question.
      if (s.awaiting === "address") out.awaiting = null;
      break;
    case "open":
      openDraft(s, action.draft, action.ack, out, now);
      break;
    case "go":
      break;
  }
  return out.finish(s, ctx);
}

// ---- Turn accumulator -------------------------------------------------------------------------------------------
class Out {
  blocks: Block[] = [];
  chips: Chip[] | undefined;
  effects: Effect[] = [];
  slots: Slots | null | undefined;
  awaiting: Slot | null | undefined;
  check: ChatState["check"] | undefined;
  drafts: Record<string, DraftEntry> | undefined;
  quotes: number | undefined;
  reviews: number[] | undefined;
  understood = true;
  finish(s: ChatState, ctx: ChatContext): Turn {
    let state: ChatState = {
      ...s,
      slots: this.slots === undefined ? s.slots : this.slots,
      awaiting: this.awaiting === undefined ? s.awaiting : this.awaiting,
      check: this.check === undefined ? s.check : this.check,
      quotes: this.quotes ?? s.quotes,
      reviews: this.reviews ?? s.reviews,
      misses: this.understood ? 0 : s.misses + 1,
    };
    if (this.drafts) {
      const next = this.drafts;
      const order = [
        ...s.order.filter((id) => id in next),
        ...Object.keys(next).filter((id) => !s.order.includes(id)),
      ].slice(-MAX_DRAFTS);
      state = {
        ...state,
        order,
        drafts: Object.fromEntries(order.map((id) => [id, next[id]])),
      };
    }
    const chips = this.chips ?? defaultChips(state, ctx);
    return { state: push(state, this.blocks, chips), effects: this.effects };
  }
}
function defaultChips(state: ChatState, ctx: ChatContext): Chip[] {
  if (state.slots && state.awaiting)
    return [
      chip("continue", K("c.continue"), { a: "continue" }),
      chip("reset", K("c.cancel"), { a: "reset" }),
    ];
  return pageChips(ctx.page);
}
function expire(state: ChatState, now: number): ChatState {
  if (state.slots && now - state.slots.started > CHAT_DRAFT_POLICY.draftTtlMs)
    return { ...state, slots: null, awaiting: null };
  return state;
}
function reset(out: Out) {
  out.slots = null;
  out.awaiting = null;
  out.check = null;
  out.blocks.push(say("r.reset"));
}

// ---- Understanding ----------------------------------------------------------------------------------------------
type Intent =
  | "levels"
  | "points"
  | "unpriced"
  | "networks"
  | "explainQuote"
  | "quote"
  | "whyBlocked"
  | "address"
  | "token"
  | "routeRisk"
  | "best"
  | "draft"
  | "open"
  | "hello"
  | "help"
  | "thanks"
  | "page"
  | "unknown";

function hasDraftEntities(p: Parsed) {
  return p.amounts.length > 0 || p.tokens.length > 0 || p.chains.length > 0;
}
function classify(p: Parsed, state: ChatState): Intent {
  const c = p.cues;
  const verb = c.has("swap") || c.has("send");
  if (c.has("referral") || (c.has("points") && !verb)) return "points";
  if (c.has("unpriced")) return "unpriced";
  if (c.has("levels") && !p.amounts.length) return "levels";
  if (c.has("quote") && c.has("explain")) return "explainQuote";
  if (c.has("quote") && !p.amounts.length && !p.tokens.length) return "quote";
  if (c.has("why") && (c.has("blocked") || c.has("risk"))) {
    if (
      c.has("address") ||
      p.addresses.length ||
      p.nearAccounts.length ||
      p.solana.length
    )
      return "address";
    return "whyBlocked";
  }
  if (c.has("safe") && c.has("token")) return "token";
  if (
    (c.has("risk") || c.has("safe")) &&
    (c.has("route") || (c.has("send") && !p.amounts.length))
  )
    return "routeRisk";
  if (c.has("best") && c.has("route")) return "best";
  if (c.has("safe") && (p.tokens.length || p.addresses.length) && !verb) {
    return p.tokens.length ? "token" : "address";
  }
  if (c.has("networks") && !verb && !p.amounts.length && !p.tokens.length)
    return "networks";
  if (verb || p.amounts.length || (p.tokens.length && !c.has("safe")))
    return "draft";
  if (p.chains.length && (state.slots || state.check)) return "draft";
  if (p.addresses.length || p.nearAccounts.length || p.solana.length)
    return state.slots && state.awaiting === "recipient" ? "draft" : "address";
  if (
    c.has("address") &&
    (c.has("safe") || c.has("explain") || c.has("blocked"))
  )
    return "address";
  if (c.has("open")) return "open";
  if (c.has("page")) return "page";
  if (c.has("help")) return "help";
  if (c.has("hello")) return "hello";
  if (c.has("thanks")) return "thanks";
  if (c.has("networks")) return "networks";
  return "unknown";
}

function understand(
  s: ChatState,
  p: Parsed,
  ctx: ChatContext,
  now: number,
  out: Out,
) {
  if (p.tooLong) {
    out.blocks.push(note("warn", "r.tooLong", { max: 500 }));
    return;
  }
  if (p.removedHidden) out.blocks.push(note("warn", "r.hidden"));
  const c = p.cues;
  // Safety first: secrets, injected instructions and execution requests are answered by fixed refusals.
  if (c.has("secrets")) {
    out.blocks.push(note("danger", "r.secrets"));
    return;
  }
  if (c.has("injection")) {
    out.blocks.push(note("danger", "r.injection"));
    return;
  }
  if (c.has("execute") || (c.has("all") && (c.has("send") || c.has("swap")))) {
    out.blocks.push(note("danger", "r.noExecute"));
    const target = p.addresses[0] ?? p.nearAccounts[0];
    if (target)
      out.chips = [
        chip("inspect", K("c.checkThat"), { a: "inspect", value: target }),
        ...pageChips(ctx.page).slice(0, 2),
      ];
    return;
  }
  if (p.clean.startsWith("{") || p.clean.startsWith("[")) {
    out.blocks.push(say("r.useInspect"));
    return;
  }
  if (p.foreignScript && !hasDraftEntities(p)) {
    out.understood = false;
    out.blocks.push(note("info", "languageNote"));
    return;
  }
  if (c.has("reset")) {
    reset(out);
    return;
  }
  if (c.has("continue") && !hasDraftEntities(p)) {
    if (s.slots) advance(s, out, ctx, now);
    else out.blocks.push(say("r.nothingPending"));
    return;
  }
  // An answer to the question just asked ("0.5", "Base", "alice.near", "0x…").
  if (s.awaiting && answersAwaited(s, p)) {
    fillAwaited(s, p, out, ctx, now);
    return;
  }
  const intent = classify(p, s);
  const interrupting = !!s.slots && intent !== "draft";
  switch (intent) {
    case "draft":
      draft(s, p, out, ctx, now);
      break;
    case "levels":
      out.blocks.push(say("r.levels"), { t: "levels" });
      break;
    case "points":
      out.blocks.push({ t: "points" });
      break;
    case "unpriced":
      unpriced(out, ctx);
      break;
    case "networks":
      networks(out, ctx);
      break;
    case "explainQuote":
      explainQuote(out, ctx, now, s);
      break;
    case "quote": {
      const last = lastDraft(s);
      if (last) requestQuote(s, last.id, out, ctx, now);
      else out.blocks.push(say("r.quoteNeedsDraft"));
      break;
    }
    case "whyBlocked":
      whyBlocked(s, out, ctx);
      break;
    case "routeRisk":
      routeRisk(s, out, ctx);
      break;
    case "best":
      best(s, out);
      break;
    case "address":
      address(s, p, out, ctx);
      break;
    case "token":
      startTokenCheck(s, p, out, ctx);
      break;
    case "open": {
      const last = lastDraft(s);
      out.blocks.push(say(last ? "r.openHint" : "r.quoteNeedsDraft"));
      break;
    }
    case "hello":
    case "help":
      out.blocks.push(say("r.hello"));
      if (!ctx.understood) out.blocks.push(note("info", "languageNote"));
      break;
    case "thanks":
      out.blocks.push(say("r.thanks"));
      break;
    case "page":
      pageGuide(out, ctx, now, s);
      break;
    default:
      out.understood = false;
      out.blocks.push(say(s.misses >= 1 ? "r.unknownAgain" : "r.unknown"));
      if (!ctx.understood) out.blocks.push(note("info", "languageNote"));
  }
  // Interruption: the question was answered; the draft in progress is still there.
  if (interrupting && s.slots && out.slots === undefined) {
    out.blocks.push(
      say("r.continue", {
        kind: kindLabel(s.slots.kind),
        missing: missingLabel(next(s.slots)),
      }),
    );
    out.chips = [
      chip("continue", K("c.continue"), { a: "continue" }),
      chip("reset", K("c.cancel"), { a: "reset" }),
      ...pageChips(ctx.page).slice(0, 2),
    ];
  }
}
const kindLabel = (kind?: DraftKind) =>
  kind ? `@draft.${kind}` : "@draft.any";
const missingLabel = (slot: Slot | null) => `@slot.${slot ?? "none"}`;

// ---- Drafts -----------------------------------------------------------------------------------------------------
const tokenOf = (t: TokenMention): TokenRef => ({
  symbol: t.symbol,
  address: t.address,
});
function extract(p: Parsed, base: Slots | null, now: number) {
  const slots: Slots = base ? { ...base } : { started: now };
  const issues: Block[] = [];
  let chips: Chip[] | undefined;
  // Amount: exactly one, unambiguous.
  if (p.amounts.length > 1) {
    issues.push(say("r.twoAmounts"));
    chips = p.amounts.slice(0, 3).map((a) =>
      chip(`amt-${a.value}`, K("c.amount", { value: a.value }), {
        a: "amount",
        value: a.value,
      }),
    );
  } else if (p.amounts[0]?.readings) {
    const [a, b] = p.amounts[0].readings;
    issues.push(
      say("r.separator", {
        value: p.clean.match(/\d+[.,]\d{3}/)?.[0] ?? a,
        a,
        b,
      }),
    );
    chips = [a, b].map((v) =>
      chip(`amt-${v}`, K("c.amount", { value: v }), { a: "amount", value: v }),
    );
  } else if (p.amounts[0]) slots.amount = p.amounts[0].value;
  // Tokens: the one after the amount (or marked as the object) is paid; one marked "to"/"for" is received.
  // A bare token added to a draft that already has what it pays ("…" → "USDC") is what it receives.
  const bareReceive =
    !!base?.pay &&
    !base.receive &&
    p.tokens.length === 1 &&
    !p.tokens[0].afterAmount &&
    p.tokens[0].case !== "object" &&
    p.tokens[0].case !== "from";
  const pay = bareReceive
    ? undefined
    : (p.tokens.find((t) => t.afterAmount) ??
      p.tokens.find((t) => t.case === "object" || t.case === "from") ??
      p.tokens.find((t) => t.case !== "to"));
  const receives = p.tokens.filter(
    (t) =>
      t !== pay &&
      (bareReceive || t.case === "to" || !pay || t.index > pay.index),
  );
  if (pay) slots.pay = tokenOf(pay);
  if (receives.length > 1) {
    issues.push(say("r.twoTokens"));
    chips = receives.slice(0, 3).map((t) =>
      chip(
        `rcv-${t.symbol ?? t.address}`,
        K("c.symbol", { symbol: t.symbol ?? "?" }),
        {
          a: "token",
          slot: "receive",
          symbol: t.symbol ?? "",
          address: t.address,
        },
      ),
    );
  } else if (receives[0]) slots.receive = tokenOf(receives[0]);
  // Networks: "from"/"on" names the source, "to" the destination; two plain names read source → destination.
  const from = p.chains.filter((c) => c.case === "from");
  const to = p.chains.filter((c) => c.case === "to");
  const on = p.chains.filter((c) => c.case === "on");
  const plain = p.chains.filter((c) => c.case === null || c.case === "object");
  if (from[0]) slots.source = from[0].chain;
  if (to[0]) slots.destination = to[0].chain;
  if (on[0]) {
    slots.source ??= on[0].chain;
    if (!to[0]) slots.destination ??= on[0].chain;
  }
  for (const c of plain) {
    if (!slots.source && c.chain !== "near") slots.source = c.chain;
    else if (!slots.destination) slots.destination = c.chain;
  }
  if (p.chains.some((c) => c.chain === "near") && !slots.destination)
    slots.destination = "near";
  // NEAR named as a token ("… to NEAR") is a route toward NEAR.
  if (slots.receive?.symbol === "NEAR" || slots.receive?.symbol === "wNEAR") {
    slots.destination = "near";
    slots.receive = { symbol: "wNEAR" };
  }
  if (p.nearAccounts[0]) slots.recipient = p.nearAccounts[0];
  else if (p.addresses[0]) slots.recipient = p.addresses[0];
  return { slots, issues, chips };
}
function inferKind(slots: Slots, p: Parsed | null): DraftKind | undefined {
  if (slots.kind) return slots.kind;
  if (slots.destination === "near") return "near";
  if (slots.source && slots.destination && slots.source !== slots.destination)
    return "bridge";
  const swapCue = !!p?.cues.has("swap");
  const sendCue = !!p?.cues.has("send");
  if (swapCue && !sendCue) return "swap";
  if (sendCue && !swapCue)
    return slots.receive &&
      slots.receive.symbol !== slots.pay?.symbol &&
      slots.source === slots.destination
      ? "swap"
      : "bridge";
  if (slots.receive && slots.pay && slots.receive.symbol !== slots.pay.symbol)
    return "swap";
  return undefined;
}
function draft(
  s: ChatState,
  p: Parsed,
  out: Out,
  ctx: ChatContext,
  now: number,
) {
  const fresh = p.cues.has("swap") || p.cues.has("send") || !s.slots;
  const { slots, issues, chips } = extract(p, fresh ? null : s.slots, now);
  if (fresh && s.slots) out.blocks.push(note("info", "r.replaced"));
  if (p.unsupported.length) {
    out.slots = null;
    out.awaiting = null;
    out.blocks.push(
      say("r.unsupportedChain", {
        network: p.unsupported[0],
        list: supportedList("bridge"),
      }),
    );
    return;
  }
  if (p.solana.length) {
    out.slots = null;
    out.awaiting = null;
    out.blocks.push(
      say("r.unsupportedChain", {
        network: "Solana",
        list: supportedList("bridge"),
      }),
    );
    return;
  }
  slots.kind = inferKind(slots, p);
  if (slots.kind === "swap" && slots.source && !slots.destination)
    slots.destination = slots.source;
  if (slots.kind === "swap" && slots.destination && !slots.source)
    slots.source = slots.destination;
  if (slots.kind === "near") {
    slots.destination = "near";
    slots.receive ??= { symbol: "wNEAR" };
  }
  // A plain send to an address on one network is not something VEINED does: it prepares swaps and bridges.
  if (
    p.cues.has("send") &&
    !p.cues.has("swap") &&
    slots.recipient &&
    slots.source &&
    (!slots.destination || slots.destination === slots.source) &&
    !slots.receive
  ) {
    out.slots = null;
    out.awaiting = null;
    out.blocks.push(say("r.plainTransfer"));
    out.chips = [
      chip("inspect", K("c.checkThat"), {
        a: "inspect",
        value: slots.recipient,
      }),
      example("bridge"),
    ];
    return;
  }
  out.slots = slots;
  if (issues.length) {
    out.blocks.push(...issues);
    out.awaiting =
      p.amounts.length > 1 || p.amounts[0]?.readings ? "amount" : "receive";
    out.chips = chips;
    return;
  }
  advance(s, out, ctx, now);
}

/** The next missing slot of a draft, in the order the questions are asked. */
export function next(slots: Slots): Slot | null {
  if (!slots.kind) return "kind";
  if (!slots.pay) return "pay";
  if (!slots.amount) return "amount";
  if (!slots.source) return "source";
  if (!slots.destination) return "destination";
  if (!slots.receive && slots.kind === "swap") return "receive";
  if (slots.kind === "near" && !slots.recipient) return "recipient";
  return null;
}
const SWAP_CHAINS = (Object.keys(CHAT_CHAINS) as ChainKey[]).filter(
  (k) => CHAT_CHAINS[k].swap,
);
const BRIDGE_CHAINS = (Object.keys(CHAT_CHAINS) as ChainKey[]).filter(
  (k) => CHAT_CHAINS[k].bridge,
);
const NEAR_ORIGINS: ChainKey[] = ["ethereum", "base", "arbitrum"];
const supportedList = (kind: DraftKind) =>
  (kind === "swap"
    ? SWAP_CHAINS
    : kind === "near"
      ? NEAR_ORIGINS
      : BRIDGE_CHAINS
  )
    .map(chainName)
    .join(", ");
const chainChips = (
  slot: "source" | "destination" | "check",
  keys: ChainKey[],
) =>
  keys.map((k) =>
    chip(`${slot}-${k}`, K("c.network", { network: chainName(k) }), {
      a: "chain",
      slot,
      chain: k,
    }),
  );
// gf1 G03: two small example amounts per token, offered (never chosen) while Guardian asks for the amount.
const EXAMPLE_AMOUNTS: Record<string, string[]> = {
  ETH: ["0.01", "0.1"],
  USDC: ["10", "100"],
  USDT: ["10", "100"],
};
const tokenChips = (slot: "pay" | "receive", symbols: string[]) =>
  symbols.map((sym) =>
    chip(`${slot}-${sym}`, K("c.symbol", { symbol: sym }), {
      a: "token",
      slot,
      symbol: sym,
    }),
  );

function ask(slot: Slot, slots: Slots, out: Out) {
  out.awaiting = slot;
  const kind = slots.kind ?? "bridge";
  const pay = slots.pay?.symbol ?? "";
  switch (slot) {
    case "kind":
      out.blocks.push(say("r.ask.kind"));
      out.chips = (["swap", "bridge", "near"] as const).map((k) =>
        chip(`kind-${k}`, K(`c.kind.${k}`), { a: "kind", kind: k }),
      );
      return;
    case "pay":
      out.blocks.push(say("r.ask.pay"));
      out.chips = tokenChips(
        "pay",
        kind === "near" ? ["ETH"] : ["ETH", "USDC", "USDT"],
      );
      return;
    case "amount":
      out.blocks.push(say("r.ask.amount", { symbol: pay || "?" }));
      out.chips = [
        ...(EXAMPLE_AMOUNTS[pay] ?? []).map((v) =>
          chip(`amt-${v}`, K("c.amount", { value: v }), {
            a: "amount",
            value: v,
          }),
        ),
        chip("reset", K("c.cancel"), { a: "reset" }),
      ];
      return;
    case "source":
      out.blocks.push(say("r.ask.source"));
      out.chips = chainChips(
        "source",
        kind === "swap"
          ? SWAP_CHAINS
          : kind === "near"
            ? NEAR_ORIGINS
            : BRIDGE_CHAINS,
      );
      return;
    case "destination":
      out.blocks.push(say("r.ask.destination"));
      out.chips = chainChips(
        "destination",
        BRIDGE_CHAINS.filter((k) => k !== slots.source),
      );
      return;
    case "receive":
      out.blocks.push(say("r.ask.receive"));
      out.chips = tokenChips(
        "receive",
        ["USDC", "USDT", "ETH", "DAI"].filter((x) => x !== pay).slice(0, 3),
      );
      return;
    case "recipient":
      out.blocks.push(say("r.ask.recipient"));
      out.chips = [chip("reset", K("c.cancel"), { a: "reset" })];
      return;
    case "refund":
      out.blocks.push(
        say("r.ask.refund", { network: chainName(slots.source ?? "ethereum") }),
      );
      out.chips = [chip("reset", K("c.cancel"), { a: "reset" })];
      return;
    default:
      return;
  }
}

function answersAwaited(s: ChatState, p: Parsed) {
  const c = p.cues;
  if (
    c.has("swap") ||
    c.has("send") ||
    c.has("points") ||
    c.has("referral") ||
    c.has("levels")
  )
    return false;
  switch (s.awaiting) {
    case "amount":
      return p.amounts.length === 1;
    case "pay":
    case "receive":
      // A token name, or the exact contract pasted for the name Guardian could not resolve.
      return (
        p.tokens.length === 1 || (!p.tokens.length && p.addresses.length === 1)
      );
    case "source":
    case "destination":
      return p.chains.length === 1 || p.unsupported.length === 1;
    case "recipient":
      return p.nearAccounts.length === 1 || p.addresses.length === 1;
    case "refund":
      return p.addresses.length === 1;
    case "kind":
      return false;
    case "check":
      return (
        p.tokens.length > 0 || p.chains.length > 0 || p.addresses.length === 1
      );
    case "address":
      return p.addresses.length + p.nearAccounts.length + p.solana.length === 1;
    default:
      return false;
  }
}
function fillAwaited(
  s: ChatState,
  p: Parsed,
  out: Out,
  ctx: ChatContext,
  now: number,
) {
  if (s.awaiting === "check") {
    out.check = {
      chain: p.chains[0]?.chain ?? s.check?.chain,
      token: p.tokens[0]
        ? tokenOf(p.tokens[0])
        : p.addresses[0]
          ? { address: p.addresses[0], symbol: s.check?.token?.symbol }
          : s.check?.token,
    };
    tokenCheck(s, out);
    return;
  }
  if (s.awaiting === "address") {
    out.awaiting = null;
    out.effects.push({
      e: "inspect",
      value: p.addresses[0] ?? p.nearAccounts[0] ?? p.solana[0],
    });
    return;
  }
  const slots: Slots = { ...(s.slots ?? { started: now }) };
  switch (s.awaiting) {
    case "amount": {
      const a = p.amounts[0];
      if (a.readings) {
        out.slots = slots;
        out.blocks.push(
          say("r.separator", {
            value: a.readings[1],
            a: a.readings[0],
            b: a.readings[1],
          }),
        );
        out.chips = a.readings.map((v) =>
          chip(`amt-${v}`, K("c.amount", { value: v }), {
            a: "amount",
            value: v,
          }),
        );
        return;
      }
      slots.amount = a.value;
      if (p.tokens[0] && !slots.pay) slots.pay = tokenOf(p.tokens[0]);
      break;
    }
    case "pay":
      slots.pay = p.tokens[0]
        ? tokenOf(p.tokens[0])
        : { address: p.addresses[0], symbol: slots.claimed?.pay };
      if (p.amounts[0] && !slots.amount) slots.amount = p.amounts[0].value;
      break;
    case "receive":
      slots.receive = p.tokens[0]
        ? tokenOf(p.tokens[0])
        : { address: p.addresses[0], symbol: slots.claimed?.receive };
      if (slots.receive.symbol === "NEAR") {
        slots.kind = "near";
        slots.destination = "near";
        slots.receive = { symbol: "wNEAR" };
      }
      break;
    case "source":
    case "destination": {
      if (p.unsupported[0]) {
        out.slots = null;
        out.awaiting = null;
        out.blocks.push(
          say("r.unsupportedChain", {
            network: p.unsupported[0],
            list: supportedList(slots.kind ?? "bridge"),
          }),
        );
        return;
      }
      const chain = p.chains[0].chain;
      if (s.awaiting === "source") {
        slots.source = chain;
        if (slots.kind === "swap") slots.destination = chain;
      } else {
        slots.destination = chain;
        if (chain === "near") slots.kind = "near";
      }
      break;
    }
    case "recipient":
      slots.recipient = p.nearAccounts[0] ?? p.addresses[0];
      break;
    case "refund":
      // The refund address is the sender of a route toward NEAR (refunds return to the origin network).
      out.slots = null;
      out.awaiting = null;
      return refundGiven(s, p.addresses[0], out, ctx, now);
  }
  out.slots = slots;
  advance(s, out, ctx, now);
}

function advance(s: ChatState, out: Out, ctx: ChatContext, now: number) {
  const slots = { ...((out.slots ?? s.slots) as Slots) };
  slots.kind = inferKind(slots, null) ?? slots.kind;
  if (slots.kind === "near") {
    slots.destination = "near";
    slots.receive ??= { symbol: "wNEAR" };
  }
  if (slots.kind === "swap" && slots.source && !slots.destination)
    slots.destination = slots.source;
  if (
    slots.kind === "bridge" &&
    slots.pay &&
    slots.destination &&
    !slots.receive &&
    slots.pay.symbol
  )
    slots.receive = { symbol: slots.pay.symbol };
  out.slots = slots;
  const missing = next(slots);
  if (missing) return ask(missing, slots, out);
  // Complete: check what chat drafts cover before asking Guardian.
  const kind = slots.kind!;
  const src = slots.source!,
    dst = slots.destination!;
  if (kind === "swap" && !CHAT_CHAINS[src].swap) {
    out.blocks.push(
      say("r.swapChain", {
        network: chainName(src),
        list: supportedList("swap"),
      }),
    );
    out.chips = [
      chip("kind-bridge", K("c.kind.bridge"), { a: "kind", kind: "bridge" }),
      chip("reset", K("c.cancel"), { a: "reset" }),
    ];
    out.slots = { ...slots, kind: undefined, destination: undefined };
    out.awaiting = null;
    return;
  }
  if (
    kind === "bridge" &&
    src === dst &&
    slots.recipient &&
    (!slots.receive || slots.receive.symbol === slots.pay?.symbol)
  ) {
    // A send to an address on one network is not a bridge: VEINED prepares swaps and bridges only.
    out.blocks.push(say("r.plainTransfer"));
    out.chips = [
      chip("inspect", K("c.checkThat"), {
        a: "inspect",
        value: slots.recipient,
      }),
      example("bridge"),
    ];
    out.slots = null;
    out.awaiting = null;
    return;
  }
  if (kind === "bridge" && src === dst) {
    out.blocks.push(say("r.sameChain", { network: chainName(src) }));
    out.slots = { ...slots, destination: undefined };
    out.awaiting = "destination";
    out.chips = [
      chip("kind-swap", K("c.kind.swap"), { a: "kind", kind: "swap" }),
      ...chainChips(
        "destination",
        BRIDGE_CHAINS.filter((k) => k !== src),
      ).slice(0, 4),
    ];
    return;
  }
  if (kind === "near" && !NEAR_ORIGINS.includes(src)) {
    out.blocks.push(say("r.nearOrigin", { list: supportedList("near") }));
    out.slots = { ...slots, source: undefined };
    out.awaiting = "source";
    out.chips = chainChips("source", NEAR_ORIGINS);
    return;
  }
  if (
    kind === "swap" &&
    slots.pay?.symbol &&
    slots.pay.symbol === slots.receive?.symbol &&
    !slots.pay.address &&
    !slots.receive?.address
  ) {
    out.blocks.push(say("r.sameToken", { symbol: slots.pay.symbol }));
    out.slots = { ...slots, receive: undefined };
    return ask("receive", { ...slots, receive: undefined }, out);
  }
  if (
    kind !== "near" &&
    slots.recipient &&
    !validIdentity(slots.recipient, "EVM")
  ) {
    out.blocks.push(say("r.recipientEvm"));
    out.slots = { ...slots, recipient: undefined };
    out.awaiting = null;
    return;
  }
  if (
    kind === "near" &&
    slots.recipient &&
    validIdentity(slots.recipient, "EVM")
  ) {
    out.blocks.push(say("r.recipientNear"));
    out.slots = { ...slots, recipient: undefined };
    out.awaiting = "recipient";
    return;
  }
  // Budget: a conversation never loops reviews (no polling, no automatic retries).
  const window = (out.reviews ?? s.reviews).filter(
    (t) => now - t < CHAT_DRAFT_POLICY.reviewBudget.windowMs,
  );
  if (window.length >= CHAT_DRAFT_POLICY.reviewBudget.count) {
    out.blocks.push(note("warn", "r.rateLimit"));
    out.awaiting = null;
    return;
  }
  const id = `d${s.seq + 1}-${s.session.slice(0, 6)}`;
  const balance =
    ctx.balance?.(src, slots.pay!.symbol ?? "", slots.pay!.address) ??
    undefined;
  const request: ChatDraftRequest = {
    kind,
    source: src,
    destination: dst,
    pay: clean(slots.pay!),
    receive: clean(slots.receive ?? slots.pay!),
    amount: slots.amount!,
    ...(slots.recipient ? { recipient: slots.recipient } : {}),
    ...(ctx.wallet ? { sender: ctx.wallet } : {}),
    ...(balance ? { balance } : {}),
  };
  out.reviews = [...window, now];
  out.drafts = {
    ...(out.drafts ?? s.drafts),
    [id]: { id, request, at: now, status: "reviewing" },
  };
  out.slots = null;
  out.awaiting = null;
  // The card appears with Guardian's answer; while the review runs the conversation shows that Guardian is checking.
  out.effects.push({ e: "draft", id, request });
}
const clean = (t: TokenRef) => ({
  ...(t.symbol ? { symbol: t.symbol } : {}),
  ...(t.address ? { address: t.address } : {}),
});

function runExample(
  s: ChatState,
  id: Example,
  ctx: ChatContext,
  now: number,
  out: Out,
) {
  const start = (slots: Omit<Slots, "started">) => {
    out.slots = { ...slots, started: now };
    out.awaiting = null;
    advance(s, out, ctx, now);
  };
  switch (id) {
    case "swap":
      return start({
        kind: "swap",
        amount: "0.1",
        pay: { symbol: "ETH" },
        receive: { symbol: "USDC" },
        source: "ethereum",
        destination: "ethereum",
      });
    case "bridge":
      return start({
        kind: "bridge",
        amount: "0.05",
        pay: { symbol: "ETH" },
        receive: { symbol: "ETH" },
        source: "ethereum",
        destination: "base",
      });
    case "near":
      return start({
        kind: "near",
        amount: "0.01",
        pay: { symbol: "ETH" },
        receive: { symbol: "wNEAR" },
        source: "base",
        destination: "near",
      });
    case "token":
      return startTokenCheck(s, null, out, ctx);
    case "address":
      out.awaiting = "address";
      out.blocks.push(say("r.askAddress"));
      out.chips = [burnExample()];
      return;
    case "levels":
      out.blocks.push(say("r.levels"), { t: "levels" });
      return;
    case "points":
      out.blocks.push({ t: "points" });
      return;
    case "networks":
      return networks(out, ctx);
    case "explainQuote":
      return explainQuote(out, ctx, now, s);
    case "quoteGuide":
      out.blocks.push(say("r.quoteGuide"));
      return explainQuote(out, ctx, now, s);
    case "whyBlocked":
      return whyBlocked(s, out, ctx);
    case "routeRisk":
      return routeRisk(s, out, ctx);
    case "unpriced":
      return unpriced(out, ctx);
    case "best":
      return best(s, out);
    case "help":
      out.blocks.push(say("r.hello"));
      return;
    case "page":
      return pageGuide(out, ctx, now, s);
    case "activity":
      return activityGuide(out, ctx, s);
  }
}

/** Opening a draft in Swap or Bridge: allowed only for a fresh, reviewed, non-blocked draft (ESCALATE needs the user's
 * acknowledgement). Opening only fills the normal screen; it never quotes, signs or sends. */
export function openable(
  entry: DraftEntry | undefined,
  ack: boolean,
  now: number,
) {
  const r = entry?.result;
  if (!entry || !r) return "draft.gone";
  if (r.draft.kind === "near") return "draft.nearOnly";
  if (now - entry.at > CHAT_DRAFT_POLICY.draftTtlMs) return "draft.expired";
  if (r.decision === "BLOCK") return "draft.blocked";
  if (r.decision === "ESCALATE" && !ack) return "draft.ackNeeded";
  if (r.draft.pay.decimals === null || r.draft.receive.decimals === null)
    return "draft.unknownDecimals";
  return null;
}
function openDraft(
  s: ChatState,
  id: string,
  ack: boolean,
  out: Out,
  now: number,
) {
  const refused = openable(s.drafts[id], ack, now);
  if (refused) {
    out.blocks.push(
      note(refused === "draft.blocked" ? "danger" : "warn", refused),
    );
    return;
  }
  out.effects.push({ e: "open", id });
}

// ---- Effects coming back ------------------------------------------------------------------------------------------
export type Outcome =
  | { e: "draft"; id: string; result?: ChatDraftResult; error?: string }
  | {
      e: "token";
      symbol: string;
      chain: ChainKey;
      result?: ChatTokenResult;
      error?: string;
    }
  | { e: "inspect"; value: string; verdict?: Verdict; error?: string }
  | {
      e: "quote" | "recheck";
      id: string;
      quote?: Omit<QuoteState, "status">;
      error?: string;
    }
  | { e: "open"; id: string; ok: boolean };
export function settle(
  state: ChatState,
  outcome: Outcome,
  ctx: ChatContext,
  now: number,
): Turn {
  const s = { ...state, touched: now };
  const out = new Out();
  switch (outcome.e) {
    case "draft":
      settleDraft(s, outcome, out, ctx);
      break;
    case "token":
      settleToken(s, outcome, out, ctx);
      break;
    case "inspect":
      if (outcome.verdict) {
        out.blocks.push(
          say("r.addressResult", {
            address: shortId(outcome.value),
            decision: `@decision.${decisionOf(outcome.verdict.level)}`,
          }),
          {
            t: "verdict",
            verdict: outcome.verdict,
            testId: "guardian-chat-inspect",
          },
        );
      } else
        out.blocks.push(
          note(
            "warn",
            outcome.error === "INVALID_REQUEST"
              ? "r.addressInvalid"
              : "r.error",
          ),
        );
      break;
    case "open": {
      const kind = s.drafts[outcome.id]?.result?.draft.kind;
      if (outcome.ok && kind && kind !== "near")
        out.blocks.push(say(`r.opened.${kind}`));
      else out.blocks.push(note("warn", "r.openFailed"));
      break;
    }
    case "quote":
    case "recheck": {
      const entry = s.drafts[outcome.id];
      if (!entry) break;
      const quote: QuoteState = outcome.quote
        ? { ...outcome.quote, status: "ready" }
        : { ...entry.quote, status: "failed", error: outcome.error };
      out.drafts = { ...s.drafts, [outcome.id]: { ...entry, quote } };
      if (outcome.quote?.verdict)
        out.blocks.push(
          say(outcome.e === "quote" ? "r.quoteDone" : "r.recheckDone", {
            decision: `@decision.${decisionOf(outcome.quote.verdict.level)}`,
          }),
          { t: "draft", id: outcome.id },
        );
      else out.blocks.push(note("warn", quoteError(outcome.error)));
      break;
    }
  }
  return out.finish(s, ctx);
}
const quoteError = (code?: string) =>
  code === "INTENTS_UNAVAILABLE" ||
  code === "INTENTS_REJECTED" ||
  code === "RATE_LIMITED"
    ? `r.quoteError.${code}`
    : "r.quoteError.OTHER";
const shortId = (v: string) =>
  v.length > 22 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v;

function settleDraft(
  s: ChatState,
  o: Extract<Outcome, { e: "draft" }>,
  out: Out,
  ctx: ChatContext,
) {
  const entry = s.drafts[o.id];
  if (!entry) return;
  const r = o.result;
  if (!r) {
    out.drafts = { ...s.drafts, [o.id]: { ...entry, status: "failed" } };
    out.blocks.push(
      note("warn", o.error === "RATE_LIMITED" ? "r.rateLimit" : "r.error"),
    );
    return;
  }
  if (r.state === "DRAFT") {
    out.drafts = {
      ...s.drafts,
      [o.id]: { ...entry, status: "ready", result: r },
    };
    out.blocks.push(
      say("r.draftReady", { decision: `@decision.${r.decision}` }),
      { t: "draft", id: o.id },
    );
    if (r.decision === "ALLOW") out.blocks.push(note("info", "r.allowNote"));
    out.chips = [
      ...(r.draft.kind === "near"
        ? [chip(`quote-${o.id}`, K("draft.quote"), { a: "quote", draft: o.id })]
        : []),
      ...pageChips(ctx.page).slice(0, 3),
    ];
    return;
  }
  // Not a draft: the entry goes, the slots come back so the user can answer.
  const drafts = { ...s.drafts };
  delete drafts[o.id];
  out.drafts = drafts;
  const req = entry.request;
  const slots: Slots = {
    kind: req.kind,
    amount: req.amount,
    pay: req.pay,
    receive: req.receive,
    source: req.source,
    destination: req.destination,
    recipient: req.recipient,
    started: entry.at,
  };
  if (r.state === "UNSUPPORTED") {
    out.slots = null;
    out.awaiting = null;
    out.blocks.push(
      say(`r.unsupported.${r.reason}`, { list: supportedList(req.kind) }),
    );
    return;
  }
  const need = r.needs[0];
  out.blocks.push(...needBlocks(need));
  if (need.slot === "amount") {
    out.slots = { ...slots, amount: undefined };
    out.awaiting = "amount";
    out.chips = [chip("reset", K("c.cancel"), { a: "reset" })];
    return;
  }
  out.slots = {
    ...slots,
    [need.slot]: undefined,
    claimed: { ...slots.claimed, [need.slot]: need.symbol },
  };
  out.awaiting = need.slot;
  out.chips = [
    ...optionChips(need.slot, need.options),
    chip("reset", K("c.cancel"), { a: "reset" }),
  ];
}
function needBlocks(need: DraftNeed): Block[] {
  const network = chainName(need.chain);
  if (need.reason === "AMOUNT_PRECISION") return [say("r.amountPrecision")];
  if (need.reason === "AMBIGUOUS")
    return [say("r.ambiguousToken", { symbol: need.symbol ?? "?", network })];
  const blocks: Block[] = [
    say("r.unknownToken", { symbol: need.symbol ?? "?", network }),
  ];
  if (need.options.length) blocks.push(say("r.similarTokens"));
  blocks.push(say("r.pasteContract"));
  return blocks;
}
const optionChips = (
  slot: "pay" | "receive" | "check",
  options: TokenOption[],
) =>
  options.slice(0, 4).map((o) =>
    chip(
      `opt-${o.address}`,
      K("c.option", {
        symbol: o.symbol,
        address: `${o.address.slice(0, 6)}…${o.address.slice(-4)}`,
      }),
      {
        a: "token",
        slot,
        symbol: o.symbol,
        address: /^0x[0-9a-fA-F]{40}$/.test(o.address) ? o.address : undefined,
      },
    ),
  );

// ---- Token checks ("is this token safe?") ------------------------------------------------------------------------
function startTokenCheck(
  s: ChatState,
  p: Parsed | null,
  out: Out,
  ctx: ChatContext,
) {
  const token = p?.tokens[0] ? tokenOf(p.tokens[0]) : undefined;
  const chain = p?.chains[0]?.chain;
  // On Swap, "this token" is the token the user selected to receive (exact contract from the page).
  const fromPage = !token && ctx.page === "swap" ? ctx.facts.swap : undefined;
  if (fromPage?.receive && fromPage.chain) {
    out.check = {
      chain: fromPage.chain,
      token: fromPage.receive.native
        ? { symbol: fromPage.receive.symbol }
        : {
            symbol: fromPage.receive.symbol,
            address: fromPage.receive.address,
          },
    };
    out.blocks.push(
      say("r.tokenFromPage", {
        symbol: fromPage.receive.symbol,
        network: fromPage.network,
      }),
    );
    return tokenCheck(s, out);
  }
  out.check = { chain, token };
  tokenCheck(s, out);
}
function tokenCheck(s: ChatState, out: Out) {
  const check = out.check === undefined ? s.check : out.check;
  if (!check?.token) {
    out.awaiting = "check";
    out.blocks.push(say("r.askToken"));
    out.chips = ["USDC", "USDT", "DAI"].map((sym) =>
      chip(`check-${sym}`, K("c.symbol", { symbol: sym }), {
        a: "token",
        slot: "check",
        symbol: sym,
      }),
    );
    return;
  }
  if (!check.chain || check.chain === "near") {
    out.awaiting = "check";
    out.blocks.push(
      say("r.askTokenChain", {
        symbol: check.token.symbol ?? shortId(check.token.address ?? ""),
      }),
    );
    out.chips = chainChips("check", BRIDGE_CHAINS);
    return;
  }
  out.awaiting = null;
  out.check = null;
  out.effects.push({
    e: "token",
    symbol: check.token.symbol ?? shortId(check.token.address ?? "?"),
    request: { chain: check.chain, token: clean(check.token) },
  });
}
function settleToken(
  s: ChatState,
  o: Extract<Outcome, { e: "token" }>,
  out: Out,
  ctx: ChatContext,
) {
  const r = o.result;
  if (!r) {
    out.blocks.push(note("warn", "r.error"));
    return;
  }
  if (r.needs) {
    out.blocks.push(...needBlocks(r.needs));
    out.check = { chain: o.chain };
    out.awaiting = "check";
    out.chips = optionChips("check", r.needs.options);
    return;
  }
  if (r.verdict && r.token) {
    out.blocks.push(
      say(r.token.level ? "r.tokenResult" : "r.tokenUnknown", {
        symbol: r.token.symbol,
        network: chainName(o.chain),
        level: `@assetLevel.${r.token.level ?? "NONE"}`,
        decision: `@decision.${decisionOf(r.verdict.level)}`,
      }),
      { t: "verdict", verdict: r.verdict, testId: "guardian-chat-token" },
    );
    out.chips = pageChips(ctx.page).slice(0, 3);
  }
}

// ---- Dry quotes (explicit only) -------------------------------------------------------------------------------------
function requestQuote(
  s: ChatState,
  id: string,
  out: Out,
  ctx: ChatContext,
  now: number,
) {
  const entry = s.drafts[id];
  const draft = entry?.result?.draft;
  if (!entry || !draft) {
    out.blocks.push(say("r.quoteNeedsDraft"));
    return;
  }
  if (draft.kind !== "near") {
    out.blocks.push(say("r.quoteLive"));
    return;
  }
  if (now - entry.at > CHAT_DRAFT_POLICY.draftTtlMs) {
    out.blocks.push(note("warn", "draft.expired"));
    return;
  }
  if (entry.result?.decision === "BLOCK") {
    out.blocks.push(note("danger", "draft.blocked"));
    return;
  }
  if (s.quotes >= CHAT_DRAFT_POLICY.quoteBudget) {
    out.blocks.push(
      note("warn", "r.quoteBudget", { count: CHAT_DRAFT_POLICY.quoteBudget }),
    );
    return;
  }
  if (!draft.sender) {
    // A dry quote names a refund address on the origin network: ask for it (never guessed).
    out.slots = {
      kind: "near",
      amount: entry.request.amount,
      pay: entry.request.pay,
      receive: entry.request.receive,
      source: entry.request.source,
      destination: "near",
      recipient: entry.request.recipient,
      started: entry.at,
    };
    out.awaiting = "refund";
    out.blocks.push(say("r.ask.refund", { network: chainName(draft.source) }));
    out.chips = [chip("reset", K("c.cancel"), { a: "reset" })];
    return;
  }
  out.quotes = s.quotes + 1;
  out.drafts = {
    ...s.drafts,
    [id]: { ...entry, quote: { status: "loading" } },
  };
  out.blocks.push(
    say("r.quoting", { left: CHAT_DRAFT_POLICY.quoteBudget - s.quotes - 1 }),
  );
  out.effects.push({ e: "quote", id });
}
/** A refund address given for a route toward NEAR: the draft is reviewed again with it as the sender. */
function refundGiven(
  s: ChatState,
  refund: string,
  out: Out,
  ctx: ChatContext,
  now: number,
) {
  const slots = s.slots!;
  out.slots = { ...slots };
  const withSender = { ...ctx, wallet: refund };
  advance(s, out, withSender, now);
}

// ---- Page-context answers ---------------------------------------------------------------------------------------------
function explainQuote(out: Out, ctx: ChatContext, now: number, s: ChatState) {
  const swap = ctx.page === "swap" ? ctx.facts.swap : undefined;
  const bridge = ctx.page === "bridge" ? ctx.facts.bridge : undefined;
  if (swap?.quote) {
    out.blocks.push(
      say("r.quoteSwapPage", {
        provider: swap.quote.provider,
        minOut: swap.quote.minOut,
        impact: swap.quote.impact ?? "@value.unknown",
        seconds: Math.max(0, Math.ceil((swap.quote.expiresAt - now) / 1000)),
        count: swap.quote.count,
      }),
    );
    if (swap.verdict)
      out.blocks.push({
        t: "verdict",
        verdict: swap.verdict,
        testId: "guardian-chat-context",
        origin: "page",
      });
    return;
  }
  if (bridge?.quote) {
    out.blocks.push(
      say("r.quoteBridgePage", {
        receive: bridge.quote.receive,
        seconds: bridge.quote.seconds ?? "@value.unknown",
        state: bridge.quote.valid ? "@value.fresh" : "@value.expired",
      }),
    );
    if (bridge.verdict)
      out.blocks.push({
        t: "verdict",
        verdict: bridge.verdict,
        testId: "guardian-chat-context",
        origin: "page",
      });
    return;
  }
  out.blocks.push(
    say(
      ctx.page === "swap" || ctx.page === "bridge"
        ? "r.noQuoteYet"
        : "r.noQuotePage",
    ),
  );
  // A draft waiting for its next answer keeps its continue/cancel choices (gf1 G05, review m5).
  if (s.slots && s.awaiting) return;
  out.chips = [
    chip("go-swap", K("c.goSwap"), { a: "go", to: "/swap" }),
    chip("go-bridge", K("c.goBridge"), { a: "go", to: "/bridge" }),
  ];
}
function pageVerdict(ctx: ChatContext): Verdict | undefined {
  return ctx.page === "swap"
    ? ctx.facts.swap?.verdict
    : ctx.page === "bridge"
      ? ctx.facts.bridge?.verdict
      : undefined;
}
function lastDraft(s: ChatState): DraftEntry | undefined {
  for (let i = s.order.length - 1; i >= 0; i--) {
    const d = s.drafts[s.order[i]];
    if (d?.result) return d;
  }
  return undefined;
}
function explainVerdict(
  verdict: Verdict,
  out: Out,
  source: "page" | "draft",
  draft?: string,
) {
  const decision = `@decision.${decisionOf(verdict.level)}`;
  out.blocks.push(
    say(verdict.level === "BLOCK" ? "r.blockedBecause" : "r.notBlocked", {
      decision,
      source: `@source.${source}`,
    }),
    {
      t: "verdict",
      verdict,
      testId: "guardian-chat-context",
      origin: source,
      ...(draft ? { draft } : {}),
    },
  );
}
function whyBlocked(s: ChatState, out: Out, ctx: ChatContext) {
  const v = pageVerdict(ctx);
  if (v) return explainVerdict(v, out, "page");
  const last = lastDraft(s);
  if (last?.result)
    return explainVerdict(last.result.verdict, out, "draft", last.id);
  out.blocks.push(say("r.noRoute"));
}
function routeRisk(s: ChatState, out: Out, ctx: ChatContext) {
  const v = pageVerdict(ctx);
  if (v) {
    out.blocks.push(
      say("r.routeRiskPage", { decision: `@decision.${decisionOf(v.level)}` }),
      {
        t: "verdict",
        verdict: v,
        testId: "guardian-chat-context",
        origin: "page",
      },
    );
    return;
  }
  const last = lastDraft(s);
  if (last?.result && last.result.draft.kind !== "swap") {
    out.blocks.push(
      say("r.routeRiskDraft", {
        decision: `@decision.${last.result.decision}`,
      }),
      {
        t: "verdict",
        verdict: last.result.verdict,
        testId: "guardian-chat-context",
        origin: "draft",
        draft: last.id,
      },
    );
    return;
  }
  out.blocks.push(say("r.routeRiskGeneral"), {
    t: "list",
    items: ["assets", "recipient", "impact", "steps", "signature", "time"].map(
      (k) => K(`r.routeChecks.${k}`),
    ),
  });
}
function best(s: ChatState, out: Out) {
  out.blocks.push(say("r.best"));
  const last = lastDraft(s);
  if (!last) {
    out.blocks.push(say("r.bestStart"));
    out.chips = [example("swap"), example("bridge"), example("near")];
  }
}
function address(s: ChatState, p: Parsed, out: Out, ctx: ChatContext) {
  const value = p.addresses[0] ?? p.nearAccounts[0] ?? p.solana[0];
  if (value) {
    out.effects.push({ e: "inspect", value });
    return;
  }
  // "Why was this address blocked?" without an address: the recipient finding on this page or the last draft.
  const page = pageVerdict(ctx);
  const last = page ? undefined : lastDraft(s);
  const v = page ?? last?.result?.verdict;
  if (
    v &&
    v.findings.some((f) => f.category === "RECIPIENT" && f.severity !== "PASS")
  ) {
    explainVerdict(v, out, page ? "page" : "draft", last?.id);
    return;
  }
  out.awaiting = "address";
  out.blocks.push(say("r.askAddress"));
  out.chips = [burnExample()];
}
const burnExample = () =>
  chip("x-burn", K("c.exampleBurn"), {
    a: "inspect",
    value: "0x000000000000000000000000000000000000dEaD",
  });
function unpriced(out: Out, ctx: ChatContext) {
  const f = ctx.page === "portfolio" ? ctx.facts.portfolio : undefined;
  if (f?.scanned)
    out.blocks.push(
      say(f.unpriced ? "r.unpricedPage" : "r.unpricedNone", {
        unpriced: f.unpriced,
        total: f.assets,
        hidden: f.hidden,
      }),
      say("r.unpricedWhy"),
    );
  else {
    out.blocks.push(say("r.unpricedWhy"));
    if (ctx.page !== "portfolio")
      out.chips = [
        chip("go-portfolio", K("c.goPortfolio"), { a: "go", to: "/portfolio" }),
      ];
    else out.blocks.push(say("r.unpricedScan"));
  }
}
function networks(out: Out, ctx: ChatContext) {
  const n = ctx.page === "networks" ? ctx.facts.networks : undefined;
  if (n) out.blocks.push(say("r.networksPage", { ...n }));
  else if (ctx.page === "networks") out.blocks.push(say("r.networksLoading"));
  out.blocks.push(
    say("r.networksGeneral", {
      swap: supportedList("swap"),
      bridge: supportedList("bridge"),
      near: supportedList("near"),
    }),
  );
  if (ctx.page !== "networks")
    out.chips = [
      chip("go-networks", K("c.goNetworks"), { a: "go", to: "/networks" }),
    ];
}

// ---- gf1 G04: the page guide ("what can I do here?") and what Guardian sees on this page -------------------------
const unread = (v: Verdict) => v.findings.filter((f) => f.severity !== "PASS");
function decisionFacts(v: Verdict | undefined, brief: boolean): Text[] {
  if (!v) return [];
  const items = [
    K("r.sees.decision", { decision: `@decision.${decisionOf(v.level)}` }),
  ];
  if (v.level === "HOLD") items.push(K("r.sees.verify"));
  const count = unread(v).length;
  if (!brief && count) items.push(K("r.sees.findings", { count }));
  return items;
}
/** The facts this page has published, as short phrases, and nothing else: an empty page says so. `brief` keeps the
 * headline only (the dock's "Guardian sees here" line). Points and Help publish nothing by design. */
export function seen(ctx: ChatContext, brief = false): Text[] {
  const f = ctx.facts;
  const items: Text[] = [];
  switch (ctx.page) {
    case "swap": {
      const s = f.swap;
      if (!s) break;
      items.push(
        s.receive
          ? K("r.sees.swapPair", {
              pay: s.pay?.symbol ?? "@value.unknown",
              receive: s.receive.symbol,
              network: s.network,
            })
          : K("r.sees.swapPay", {
              pay: s.pay?.symbol ?? "@value.unknown",
              network: s.network,
            }),
      );
      if (s.quote) {
        if (!brief) {
          items.push(
            K("r.sees.quote", {
              provider: s.quote.provider,
              minOut: s.quote.minOut,
              count: s.quote.count,
            }),
          );
          if (s.quote.fee) items.push(K("r.sees.fee", { fee: s.quote.fee }));
          items.push(
            K("r.sees.impact", {
              impact: s.quote.impact ?? "@value.unknown",
            }),
          );
        }
      } else items.push(K("r.sees.noQuote"));
      items.push(...decisionFacts(s.verdict, brief));
      break;
    }
    case "bridge": {
      const b = f.bridge;
      if (!b) {
        // Before a quote: the route the form shows, and no review yet.
        const r = f.bridgeRoute;
        if (r) {
          items.push(
            K("r.sees.route", {
              pay: r.pay,
              receive: r.receive,
              source: r.source,
              destination: r.destination,
            }),
          );
          if (!r.unavailable) items.push(K("r.sees.noQuote"));
        }
        break;
      }
      items.push(
        K("r.sees.route", {
          pay: b.pay,
          receive: b.receive,
          source: b.source,
          destination: b.destination,
        }),
      );
      if (b.quote && !brief)
        items.push(
          K("r.sees.bridgeQuote", {
            receive: b.quote.receive,
            seconds: b.quote.seconds ?? "@value.unknown",
          }),
        );
      if (b.quote && !b.quote.valid) items.push(K("r.sees.expired"));
      items.push(...decisionFacts(b.verdict, brief));
      break;
    }
    case "portfolio": {
      const p = f.portfolio;
      if (!p) break;
      if (!p.scanned) {
        items.push(K("r.sees.notScanned"));
        break;
      }
      items.push(
        K("r.sees.assets", {
          assets: p.assets,
          unpriced: p.unpriced,
          hidden: p.hidden,
        }),
      );
      if ((p.pending ?? 0) + (p.failed ?? 0) > 0)
        items.push(
          K("r.sees.coverage", {
            pending: p.pending ?? 0,
            failed: p.failed ?? 0,
          }),
        );
      break;
    }
    case "networks":
      if (f.networks)
        items.push(
          K("r.sees.networks", {
            total: f.networks.total,
            bridge: f.networks.bridge,
            swap: f.networks.swap,
          }),
        );
      break;
    case "overview":
      if (f.overview) items.push(K(`r.sees.overview.${f.overview.step}`));
      break;
    case "activity":
      if (f.activity) items.push(K("r.sees.activity", { ...f.activity }));
      break;
    case "points":
      return [K("r.sees.private")];
  }
  return items.length ? items : [K("r.sees.none")];
}
function pageGuide(out: Out, ctx: ChatContext, now: number, s: ChatState) {
  const guided = GUIDED.includes(ctx.page);
  out.blocks.push(
    say(`r.page.${guided || ctx.page === "guardian" ? ctx.page : "other"}`),
  );
  // Points: the accepted Points statement, word for word as the Points page shows it (no new promise or number).
  if (ctx.page === "points")
    out.blocks.push({ t: "text", key: "points.how.value" });
  if (guided) {
    const items = seen(ctx);
    out.blocks.push(say("r.sees.title"), { t: "list", items });
    // The page's own review is shown as it is (never re-decided here).
    const v = pageVerdict(ctx);
    if (v)
      out.blocks.push({
        t: "verdict",
        verdict: v,
        testId: "guardian-chat-context",
        origin: "page",
      });
    // A quote's time left is read now, not when the page published it.
    const q = ctx.page === "swap" ? ctx.facts.swap?.quote : undefined;
    if (q && q.expiresAt <= now) out.blocks.push(note("warn", "r.sees.stale"));
  }
  // A draft waiting for its next answer keeps its continue/cancel choices (gf1 G05, review R3-N1).
  if (s.slots && s.awaiting) return;
  out.chips = pageActions(ctx.page).map(example);
}
function activityGuide(out: Out, ctx: ChatContext, s: ChatState) {
  const a = ctx.page === "activity" ? ctx.facts.activity : undefined;
  if (a) out.blocks.push(say("r.sees.activity", { ...a }));
  out.blocks.push(say("r.activityGuide"));
  // A draft waiting for its next answer keeps its continue/cancel choices; otherwise the question just answered is not
  // offered again.
  if (s.slots && s.awaiting) return;
  out.chips = pageChips(ctx.page).filter((c) => c.id !== "x-activity");
}

export const levelDecisions: [Decision, Level][] = [
  ["ALLOW", "CLEAR"],
  ["WARN", "CAUTION"],
  ["ESCALATE", "HOLD"],
  ["BLOCK", "BLOCK"],
];
