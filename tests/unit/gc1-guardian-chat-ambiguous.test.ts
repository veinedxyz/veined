// Guardian chat (gc1): a symbol that names more than one verified token on a network is never resolved by guessing.
// VEINED's current registry has no such pair, so the registry is replaced here by a SYNTHETIC_TEST_ONLY one with two
// curated "USDX" contracts on Ethereum; the conversation asks the user to pick the exact contract.
import { describe, expect, it, vi } from "vitest";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
vi.mock("../../src/assets/registry", () => {
  const asset = (address: string, name: string) => ({
    chainId: "1",
    address,
    native: false,
    symbol: "USDX",
    name,
    decimals: 6,
    level: "CURATED",
    sources: [],
    logo: null,
    risk: [],
  });
  const list = [asset(A, "USD X (one)"), asset(B, "USD X (two)")];
  return {
    knownAsset: (chain: string, address: string, native = false) =>
      native
        ? {
            chainId: chain,
            address: "native",
            native: true,
            symbol: "ETH",
            name: "Ether",
            decimals: 18,
            level: "CANONICAL",
            sources: [],
            logo: null,
            risk: [],
          }
        : (list.find(
            (a) => chain === "1" && a.address === address.toLowerCase(),
          ) ?? null),
    registryFor: (chain: string) => (chain === "1" ? list : []),
  };
});

describe("Guardian chat: ambiguous symbols", () => {
  it("GC1-40 two verified tokens share a symbol: the server answers AMBIGUOUS with both exact contracts; the chat asks", async () => {
    const { chatDraft } = await import("../../src/guardian/server/chat-draft");
    const { initial, send, settle, choose } =
      await import("../../src/guardian/chat/engine");
    const r = chatDraft({
      kind: "swap",
      source: "ethereum",
      destination: "ethereum",
      pay: { symbol: "ETH" },
      receive: { symbol: "USDX" },
      amount: "1",
    });
    expect(r).toMatchObject({
      state: "NEEDS",
      needs: [{ slot: "receive", reason: "AMBIGUOUS", symbol: "USDX" }],
    });
    if (r.state !== "NEEDS") throw Error("needs");
    expect(r.needs[0].options.map((o) => o.address)).toEqual([A, B]);
    const ctx = {
      page: "overview" as const,
      understood: true,
      facts: {},
      wallet: null,
      product: { referralPercent: "10" },
    };
    let s = initial(ctx, 0, "ambiguous-test");
    // An unknown name counts only when it is explicit: right after an amount, or written as $TICKER.
    const t = send(s, "swap 1 ETH to $USDX on Ethereum", ctx, 0);
    const e = t.effects[0];
    if (e.e !== "draft") throw Error("draft effect");
    s = settle(
      t.state,
      { e: "draft", id: e.id, result: chatDraft(e.request) },
      ctx,
      0,
    ).state;
    expect(s.messages.at(-1)!.blocks![0]).toMatchObject({
      key: "guardian.chat.r.ambiguousToken",
      params: { symbol: "USDX", network: "Ethereum" },
    });
    expect(s.awaiting).toBe("receive");
    const pick = s.chips.find(
      (c) => c.action.a === "token" && c.action.address === B,
    )!;
    const next = choose(s, pick.action, "USDX", ctx, 0);
    const e2 = next.effects[0];
    if (e2.e !== "draft") throw Error("draft effect");
    expect(e2.request.receive).toEqual({ symbol: "USDX", address: B });
    const done = chatDraft(e2.request);
    expect(done.state === "DRAFT" && done.draft.receive.address).toBe(B);
  });
});
