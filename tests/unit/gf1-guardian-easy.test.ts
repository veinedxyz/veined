// gf1 G03 Guardian for first-time users: the conversation engine's guided steps. Every guided start and suggestion
// is a structured choice that ends in the same server review as a typed request; suggestions are offered, never
// chosen; the decision always comes from Guardian's rules (src/guardian/server/chat-draft.ts, in-process here).
// SYNTHETIC_TEST_ONLY addresses; no request leaves the process.
import { describe, expect, it } from "vitest";
import en from "../../src/i18n/locales/en.json";
import {
  choose,
  initial,
  send,
  settle,
  type ChatContext,
  type ChatState,
  type ChipAction,
  type Effect,
} from "../../src/guardian/chat/engine";
import type { ChatDraftResult } from "../../src/guardian/chat/model";
import { chatDraft, chatToken } from "../../src/guardian/server/chat-draft";

const T0 = 1_800_000_000_000;
const BURN = "0x000000000000000000000000000000000000dEaD";
const ctxOf = (over: Partial<ChatContext> = {}): ChatContext => ({
  page: "guardian",
  understood: true,
  facts: {},
  wallet: null,
  product: { referralPercent: "10" },
  ...over,
});
type Trace = { effects: Effect[]; results: ChatDraftResult[] };
function run(s: ChatState, effects: Effect[], ctx: ChatContext, trace: Trace) {
  for (const e of effects) {
    trace.effects.push(e);
    if (e.e === "draft") {
      const result = chatDraft(e.request, T0);
      trace.results.push(result);
      const t = settle(s, { e: "draft", id: e.id, result }, ctx, T0);
      s = run(t.state, t.effects, ctx, trace);
    } else if (e.e === "token") {
      const t = settle(
        s,
        {
          e: "token",
          symbol: e.symbol,
          chain: e.request.chain,
          result: chatToken(e.request),
        },
        ctx,
        T0,
      );
      s = run(t.state, t.effects, ctx, trace);
    }
  }
  return s;
}
/** Tap through the conversation: each step is a chip id offered by the previous answer (never invented here). */
function tap(start: ChipAction, label: string, chips: string[], ctx = ctxOf()) {
  const trace: Trace = { effects: [], results: [] };
  let t = choose(initial(ctx, T0, "g3-session-1"), start, label, ctx, T0);
  let s = run(t.state, t.effects, ctx, trace);
  const offered: string[][] = [];
  for (const id of chips) {
    offered.push(s.chips.map((c) => c.id));
    const c = s.chips.find((x) => x.id === id);
    if (!c) throw Error(`chip ${id} not offered: ${s.chips.map((x) => x.id)}`);
    t = choose(s, c.action, id, ctx, T0);
    s = run(t.state, t.effects, ctx, trace);
  }
  return { s, offered, ...trace };
}
const last = (s: ChatState) => s.messages[s.messages.length - 1];
const keys = (s: ChatState) =>
  (last(s).blocks ?? []).flatMap((b) =>
    "key" in b ? [b.key.replace("guardian.chat.", "")] : [b.t],
  );
const lastDraft = (s: ChatState) =>
  s.order
    .map((id) => s.drafts[id])
    .filter((d) => d.result)
    .at(-1)!.result!;

describe("Guardian for first-time users: guided starts", () => {
  it("GF1-G3-U1 guided swap: Guardian asks one thing at a time, example amounts are offered (never chosen), the draft is the server's", () => {
    const { s, offered, results } = tap({ a: "kind", kind: "swap" }, "swap", [
      "pay-ETH",
      "amt-0.1",
      "source-ethereum",
      "receive-USDC",
    ]);
    expect(offered[0]).toEqual(["pay-ETH", "pay-USDC", "pay-USDT"]);
    // The amount question offers two examples and cancel; the slot stays empty until the user picks or types one.
    expect(offered[1]).toEqual(["amt-0.01", "amt-0.1", "reset"]);
    expect(results).toHaveLength(1);
    const d = lastDraft(s);
    expect(d.decision).toBe("ALLOW");
    expect(d.draft).toMatchObject({
      kind: "swap",
      amount: "0.1",
      rawAmount: "100000000000000000",
      executable: false,
    });
    // Same result as typing it.
    const typed = send(
      initial(ctxOf(), T0, "g3-session-2"),
      "swap 0.1 ETH to USDC on Ethereum",
      ctxOf(),
      T0,
    );
    const trace: Trace = { effects: [], results: [] };
    run(typed.state, typed.effects, ctxOf(), trace);
    expect(
      trace.results[0].state === "DRAFT" && trace.results[0].draft,
    ).toEqual(d.draft);
    expect(
      trace.results[0].state === "DRAFT" && trace.results[0].verdict.digest,
    ).toBe(d.verdict.digest);
  });
  it("GF1-G3-U2 the amount question: examples per token, none chosen for the user; a large typed amount still escalates", () => {
    const usdt = tap({ a: "kind", kind: "bridge" }, "bridge", ["pay-USDT"]);
    expect(usdt.s.chips.map((c) => c.id)).toEqual([
      "amt-10",
      "amt-100",
      "reset",
    ]);
    expect(usdt.s.slots?.amount).toBeUndefined();
    const ctx = ctxOf();
    let s = usdt.s;
    const typed = send(s, "50000", ctx, T0);
    s = typed.state;
    expect(keys(s)).toEqual(["r.ask.source"]);
    const pick = s.chips.find((c) => c.id === "source-ethereum")!;
    const t1 = choose(s, pick.action, "Ethereum", ctx, T0);
    const dest = t1.state.chips.find((c) => c.id === "destination-polygon")!;
    const t2 = choose(t1.state, dest.action, "Polygon", ctx, T0);
    const trace: Trace = { effects: [], results: [] };
    const end = run(t2.state, t2.effects, ctx, trace);
    expect(lastDraft(end).decision).toBe("ESCALATE");
  });
  it("GF1-G3-U3 guided token check: verified tokens to try, then the network, then Guardian's server verdict", () => {
    const { s, offered, effects } = tap(
      { a: "example", id: "token" },
      "token",
      ["check-USDC", "check-ethereum"],
    );
    expect(offered[0]).toEqual(["check-USDC", "check-USDT", "check-DAI"]);
    expect(effects.filter((e) => e.e === "token")).toHaveLength(1);
    const verdict = (last(s).blocks ?? []).find((b) => b.t === "verdict");
    expect(verdict && verdict.t === "verdict" && verdict.verdict.level).toBe(
      "CLEAR",
    );
  });
  it("GF1-G3-U4 guided address check: the burn-address example is a read-only inspection of that exact address", () => {
    const { s, effects } = tap({ a: "example", id: "address" }, "address", []);
    expect(keys(s)).toEqual(["r.askAddress"]);
    expect(s.chips.map((c) => [c.id, c.action])).toEqual([
      ["x-burn", { a: "inspect", value: BURN }],
    ]);
    expect(effects).toEqual([]);
    const t = choose(s, s.chips[0].action, "burn", ctxOf(), T0);
    expect(t.effects).toEqual([{ e: "inspect", value: BURN }]);
    // Choosing the example answers the pending question: nothing waits for an address afterwards, so a later request
    // with one address is understood as a request, not as another address check.
    expect(t.state.awaiting).toBeNull();
    const next = send(
      t.state,
      "10 USDC to 0x1111111111111111111111111111111111111111 on Base",
      ctxOf(),
      T0,
    );
    expect(next.effects.filter((e) => e.e === "inspect")).toEqual([]);
    // A typed question about an address, without one, gets the same question and example.
    const typed = send(
      initial(ctxOf(), T0, "g3-session-3"),
      "Why was this address blocked?",
      ctxOf(),
      T0,
    ).state;
    expect(keys(typed)).toEqual(["r.askAddress"]);
    expect(typed.chips.map((c) => c.id)).toEqual(["x-burn"]);
  });
  it("GF1-G3-U5 guided 'Explain a quote': what a quote is, then the truth about this page; no request of any kind", () => {
    const { s, effects } = tap({ a: "example", id: "quoteGuide" }, "quote", []);
    expect(keys(s)).toEqual(["r.quoteGuide", "r.noQuotePage"]);
    expect(s.chips.map((c) => c.id)).toEqual(["go-swap", "go-bridge"]);
    expect(effects).toEqual([]);
    // On Swap with a real quote, the page's quote follows the general explanation.
    const onSwap = tap(
      { a: "example", id: "quoteGuide" },
      "quote",
      [],
      ctxOf({
        page: "swap",
        facts: {
          swap: {
            network: "Ethereum",
            chain: "ethereum",
            quote: {
              provider: "Uniswap · V3",
              minOut: "300 USDC",
              impact: "0.1%",
              expiresAt: T0 + 20_000,
              count: 2,
            },
          },
        },
      }),
    );
    expect(keys(onSwap.s)).toEqual(["r.quoteGuide", "r.quoteSwapPage"]);
    // The existing "explain this quote" answer is unchanged.
    expect(
      keys(
        send(
          initial(ctxOf({ page: "points" }), T0, "g3-session-4"),
          "Guardian, explain this quote.",
          ctxOf({ page: "points" }),
          T0,
        ).state,
      ),
    ).toEqual(["r.noQuotePage"]);
  });
  it("GF1-G3-U7 re-shown verdicts say where they come from: an earlier draft's server review (with its id) or the page's own review", () => {
    const ctx = ctxOf();
    const trace: Trace = { effects: [], results: [] };
    let t = send(
      initial(ctx, T0, "g3-session-5"),
      `send 10 USDT from Ethereum to Arbitrum to ${BURN}`,
      ctx,
      T0,
    );
    const s = run(t.state, t.effects, ctx, trace);
    const id = s.order.at(-1)!;
    const reviewed = s.drafts[id].result!;
    expect(reviewed.decision).toBe("BLOCK");
    const verdictOf = (st: ChatState) =>
      (last(st).blocks ?? []).find((b) => b.t === "verdict");
    // No page verdict here: the last draft's own server review, unchanged, tagged with its id.
    for (const question of [
      "Why is this route blocked?",
      "What is the risk of this route?",
      "Why was this address blocked?",
    ]) {
      t = send(s, question, ctx, T0);
      const v = verdictOf(t.state);
      expect(v, question).toMatchObject({
        t: "verdict",
        testId: "guardian-chat-context",
        origin: "draft",
        draft: id,
        verdict: { digest: reviewed.verdict.digest },
      });
      expect(t.effects, question).toEqual([]);
    }
    // On Bridge with the page's own verdict: tagged as the page's review, no draft id.
    const onBridge = ctxOf({
      page: "bridge",
      facts: {
        bridge: {
          source: "Ethereum",
          destination: "Base",
          pay: "ETH",
          receive: "ETH",
          verdict: reviewed.verdict,
        },
      },
    });
    t = send(s, "Why is this route blocked?", onBridge, T0);
    expect(verdictOf(t.state)).toMatchObject({ origin: "page" });
    expect(verdictOf(t.state)).not.toHaveProperty("draft");
    // A new server review (address inspection) carries no origin: it is answered now.
    const inspected = settle(
      s,
      { e: "inspect", value: BURN, verdict: reviewed.verdict },
      ctx,
      T0,
    ).state;
    const fresh = verdictOf(inspected);
    expect(fresh).toMatchObject({ testId: "guardian-chat-inspect" });
    expect(fresh).not.toHaveProperty("origin");
  });
  it("GF1-G3-U6 every new text exists in English", () => {
    const g = en as unknown as Record<
      string,
      Record<string, Record<string, Record<string, string>>>
    >;
    expect(g.guardian.chat.c.exampleBurn).toBeTruthy();
    expect(g.guardian.chat.r.quoteGuide).toContain(
      "A quote alone moves nothing.",
    );
    // Swap-only checks are named as such (a bridge review has no slippage, cross-check or approval rule).
    expect(g.guardian.chat.r.quoteGuide).toContain(
      "for a swap also slippage, any token approval and whether other quotes agree",
    );
    const tech = (
      en as unknown as { gf: { g3: { tech: Record<string, string> } } }
    ).gf.g3.tech;
    for (const k of ["draftPolicy", "shown", "sourcesPage", "limitsPage"])
      expect(tech[k], k).toBeTruthy();
    expect(tech.limits).not.toMatch(/again/);
  });
});
