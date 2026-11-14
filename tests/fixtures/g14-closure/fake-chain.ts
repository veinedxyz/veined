// G14 closure — SYNTHETIC_TEST_ONLY local two-operator chain for the positive test-only variant.
// It stands in for the four exact pool URLs (Base and Arbitrum, two operators each) behind a stubbed `fetch`, and for
// LI.FI's quote endpoint behind the adapter's own node:https / node:dns transport. Both operators of one chain see the
// SAME state unless a test makes one of them diverge. Contract code is the PUBLIC runtime code of the pinned contracts
// (pinned-code.json, read read-only from both live operators — its keccak equals the pin set), so the product's pin
// checks run unmodified. Balances, allowances, nonces, receipts and logs are synthetic, for the synthetic account
// 0x3333…3333. Nothing here signs, holds a key or reaches a network; a "sent" transaction exists only in this memory.
import {
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import code from "./pinned-code.json" with { type: "json" };
import fx from "../g14-canary-across.json" with { type: "json" };
import { CANARY_PINS } from "../../../src/execution/canary/pins";
import { SETTLEMENT_ABI } from "../../../src/execution/canary/settlement";

export const URLS = {
  "8453": ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  "42161": [
    "https://arbitrum-one-rpc.publicnode.com",
    "https://arb1.arbitrum.io/rpc",
  ],
} as const;
type ChainId = keyof typeof URLS;
const hex = (v: bigint | number) => "0x" + BigInt(v).toString(16);
const word = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
const pad = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const lower = (a: string) => a.toLowerCase();
const ABI = parseAbi([
  "function facetAddress(bytes4) view returns (address)",
  "function SPOKEPOOL() view returns (address)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function getL1Fee(bytes) view returns (uint256)",
]);
export interface Log {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  logIndex: string;
  removed?: boolean;
}
interface Block {
  number: number;
  hash: string;
  timestamp: number;
  baseFee: bigint;
}
interface Mined {
  tx: {
    hash: string;
    from: string;
    to: string;
    input: string;
    value: string;
    nonce: bigint;
    gas: bigint;
  };
  block: number | null;
  receipt: Record<string, unknown> | null;
}
export interface FakeChainOptions {
  owner: string;
  now: () => number;
  usdc?: bigint;
  native?: bigint;
  allowance?: bigint;
  arbUsdc?: bigint;
  baseFee?: bigint;
  tip?: bigint;
  l1Fee?: bigint;
}
/** SYNTHETIC_TEST_ONLY: the owner key whose digest the positive variant puts into OWNER_CANARY_KEY_SHA256. */
export const SYNTHETIC_OWNER_KEY =
  "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e";
export function fakeChain(o: FakeChainOptions) {
  const owner = lower(o.owner);
  const diamond = lower(CANARY_PINS.diamond.address);
  const usdcBase = lower(CANARY_PINS.usdc["8453"].address);
  const usdcArb = lower(CANARY_PINS.usdc["42161"].address);
  const poolBase = lower(CANARY_PINS.spokePools["8453"].address);
  const poolArb = lower(CANARY_PINS.spokePools["42161"].address);
  const state = {
    usdc: o.usdc ?? 5_000_000n,
    native: o.native ?? 10n ** 16n,
    allowance: o.allowance ?? 0n,
    nonce: 7n,
    arbUsdc: o.arbUsdc ?? 1_000n,
    tip: o.tip ?? 1_000_000n,
    l1Fee: o.l1Fee ?? 1_234n,
    sends: 0,
    /**
     * Review 13 R13-1 (SYNTHETIC_TEST_ONLY): the account nonce read at a block BELOW `block` is `value` (the nonce was
     * consumed only from `block` on — e.g. by a consumer a reorganisation re-mined in the not-final tail).
     */
    nonceBefore: undefined as { block: number; value: bigint } | undefined,
  };
  const chains: Record<ChainId, { blocks: Block[]; logs: Log[] }> = {
    "8453": { blocks: [], logs: [] },
    "42161": { blocks: [], logs: [] },
  };
  const txs = new Map<string, Mined>();
  const pending: string[] = [];
  /**
   * Review 15 R15-1 (SYNTHETIC_TEST_ONLY): the owner's USDC changes made by mined blocks (deposit, fill, refund-looking
   * transfer, `move`), so a balance read AT a block number sees only the changes up to that block. A test's direct
   * `state` edit counts as made long before (visible at every block), as before.
   */
  const moves: { chain: ChainId; block: number; usdc: bigint }[] = [];
  const usdcAt = (chain: ChainId, tag: unknown) => {
    const now = chain === "8453" ? state.usdc : state.arbUsdc;
    if (typeof tag !== "string" || !tag.startsWith("0x")) return now;
    const n = Number(BigInt(tag));
    return moves
      .filter((m) => m.chain === chain && m.block > n)
      .reduce((v, m) => v - m.usdc, now);
  };
  /** Operator index 1 of a chain may be made to diverge (a different head hash, or no answer at all). */
  const diverge: Partial<
    Record<string, "OFFLINE" | "OTHER_HEAD" | "OTHER_VALUE">
  > = {};
  const seen: { url: string; method: string }[] = [];
  /**
   * Review 15 R15-1 (SYNTHETIC_TEST_ONLY): operator 1 of a chain states a head `lag` blocks behind the real one (a node
   * that fell behind); the common head both are asked about goes back with it. Blocks by number stay readable.
   */
  const lag: Partial<Record<ChainId, number>> = {};
  const mineBlock = (chain: ChainId) => {
    const c = chains[chain];
    const n =
      (c.blocks.at(-1)?.number ??
        (chain === "8453" ? 56_600_000 : 523_650_000)) + 1;
    const b: Block = {
      number: n,
      hash: keccak256(toHex(`${chain}:${n}`)),
      timestamp: Math.floor(o.now() / 1000),
      baseFee: o.baseFee ?? 5_000_000n,
    };
    c.blocks.push(b);
    return b;
  };
  for (const chain of ["8453", "42161"] as const)
    for (let i = 0; i < 3; i++) mineBlock(chain);
  const head = (chain: ChainId) => chains[chain].blocks.at(-1)!;
  const blockAt = (chain: ChainId, tag: string) =>
    tag === "latest"
      ? head(chain)
      : (chains[chain].blocks.find((b) => b.number === Number(BigInt(tag))) ??
        null);
  const header = (b: Block, other = false) => ({
    number: hex(b.number),
    hash: other ? keccak256(toHex(`other:${b.number}`)) : b.hash,
    timestamp: hex(b.timestamp),
    baseFeePerGas: hex(b.baseFee),
  });
  const codeOf = (chain: ChainId, a: string) =>
    (code.code as Record<string, Record<string, string>>)[chain]?.[lower(a)] ??
    "0x";
  const IMPL: Record<string, string> = {
    [poolBase]: CANARY_PINS.spokePools["8453"].implementation.address,
    [usdcBase]: CANARY_PINS.usdc["8453"].implementation.address,
    [poolArb]: CANARY_PINS.spokePools["42161"].implementation.address,
    [usdcArb]: CANARY_PINS.usdc["42161"].implementation.address,
  };
  const ret = (types: string[], values: unknown[]) =>
    encodeAbiParameters(
      types.map((t) => ({ type: t })),
      values as never,
    );
  function call(
    chain: ChainId,
    to: string,
    data: string,
    index = 0,
    tag: unknown = "latest",
  ): string {
    const t = lower(to);
    const d = decodeFunctionData({ abi: ABI, data: data as Hex });
    if (chain === "8453" && t === diamond && d.functionName === "facetAddress")
      return ret(["address"], [CANARY_PINS.facet.address]);
    if (
      chain === "8453" &&
      t === lower(CANARY_PINS.facet.address) &&
      d.functionName === "SPOKEPOOL"
    )
      return ret(["address"], [CANARY_PINS.spokePools["8453"].address]);
    if (t === usdcBase || t === usdcArb) {
      if (d.functionName === "decimals") return ret(["uint8"], [6]);
      if (d.functionName === "symbol") return ret(["string"], ["USDC"]);
      if (d.functionName === "balanceOf")
        return ret(
          ["uint256"],
          [
            lower(d.args[0] as string) === owner
              ? usdcAt(t === usdcBase ? "8453" : "42161", tag)
              : 0n,
          ],
        );
      if (d.functionName === "allowance")
        return ret(
          ["uint256"],
          [
            t === usdcBase &&
            lower(d.args[0] as string) === owner &&
            lower(d.args[1] as string) === diamond
              ? // G14 follow-up (review 7 R7-5): operator 1 may state another allowance than operator 0.
                state.allowance +
                (index === 1 && diverge["8453:allowance"] === "OTHER_VALUE"
                  ? 1n
                  : 0n)
              : 0n,
          ],
        );
    }
    if (
      chain === "8453" &&
      t === lower(CANARY_PINS.gasPriceOracle) &&
      d.functionName === "getL1Fee"
    )
      return ret(["uint256"], [state.l1Fee]);
    throw new Error("FAKE_CHAIN_UNKNOWN_CALL");
  }
  /** eth_simulateV1 of the engine's request: the recorded real simulation of the fixture call, sized to the request. */
  function simulate(req: {
    blockStateCalls: { calls: { to: string; data: string }[] }[];
  }) {
    const calls = req.blockStateCalls[0].calls;
    const c = structuredClone(fx.simulationCalls);
    const read = (v: bigint) => ({
      status: "0x1",
      returnData: word(v),
      gasUsed: "0x79ce",
      logs: [],
    });
    // [balanceOf, allowance, (approve), main, balanceOf, allowance]
    const needsApproval = calls.length === 6;
    const out = needsApproval
      ? [
          read(state.usdc),
          read(state.allowance),
          c[1],
          c[2],
          read(state.usdc - 5_000_000n),
          read(0n),
        ]
      : [
          read(state.usdc),
          read(state.allowance),
          c[2],
          read(state.usdc - 5_000_000n),
          read(0n),
        ];
    return [{ calls: out }];
  }
  function receiptJson(m: Mined) {
    return m.receipt;
  }
  /** What the fake wallet calls on eth_sendTransaction: the transaction enters the mempool (not mined yet). */
  function submit(params: Record<string, string>): string {
    state.sends++;
    const hash = keccak256(
      toHex(`tx:${state.sends}:${params.data}:${params.to}`),
    );
    txs.set(hash, {
      tx: {
        hash,
        from: lower(params.from),
        to: lower(params.to),
        input: lower(params.data),
        value: params.value,
        nonce: state.nonce,
        gas: BigInt(params.gas),
      },
      block: null,
      receipt: null,
    });
    state.nonce++;
    pending.push(hash);
    return hash;
  }
  /** Mines the pending transactions into the next Base block (state changes, receipt, logs), then `extra` empty blocks. */
  function mine(extra = 0, opts: { revert?: boolean; at?: number } = {}) {
    // Review 12 (SYNTHETIC_TEST_ONLY): `at` puts the pending transactions into an EXISTING block height (a
    // reorganisation that inserts them where a reader already saw an empty block).
    const b =
      opts.at !== undefined
        ? chains["8453"].blocks.find((x) => x.number === opts.at)!
        : mineBlock("8453");
    let index = 0;
    for (const hash of pending.splice(0)) {
      const m = txs.get(hash)!;
      const logs: Log[] = [];
      const add = (l: { address: string; topics: string[]; data: string }) =>
        logs.push({
          ...l,
          address: lower(l.address),
          transactionHash: hash,
          blockNumber: hex(b.number),
          blockHash: b.hash,
          logIndex: hex(index++),
        });
      const isApprove = m.tx.to === usdcBase;
      const gasUsed = isApprove ? 0xd88dn : 0x29ac1n;
      if (!opts.revert) {
        if (isApprove) {
          const amount = BigInt("0x" + m.tx.input.slice(74));
          state.allowance = amount;
          add({
            address: usdcBase,
            topics: [CANARY_PINS.topics.approval, pad(owner), pad(diamond)],
            data: word(amount),
          });
        } else {
          // The recorded simulation's logs of exactly this call (owner -> Diamond, fee, -> pool, FundsDeposited).
          for (const l of fx.simulationCalls[2].logs) add(l);
          state.usdc -= 5_000_000n;
          moves.push({ chain: "8453", block: b.number, usdc: -5_000_000n });
          state.allowance = 0n;
        }
      }
      const price = b.baseFee + state.tip;
      state.native -= gasUsed * price + state.l1Fee;
      m.block = b.number;
      m.receipt = {
        transactionHash: hash,
        blockNumber: hex(b.number),
        blockHash: b.hash,
        status: opts.revert ? "0x0" : "0x1",
        from: m.tx.from,
        to: m.tx.to,
        gasUsed: hex(gasUsed),
        effectiveGasPrice: hex(price),
        l1Fee: hex(state.l1Fee),
        logs,
      };
      chains["8453"].logs.push(...logs);
    }
    for (let i = 0; i < extra; i++) mineBlock("8453");
    return b;
  }
  /** Advances one chain without transactions (confirmations, time). */
  function advance(chain: ChainId, blocks: number) {
    for (let i = 0; i < blocks; i++) mineBlock(chain);
  }
  /** A relayer fills the deposit of `sourceHash` on Arbitrum (exactly as deposited, unless `change` alters it). */
  function fill(
    sourceHash: string,
    change: {
      recipient?: string;
      outputAmount?: bigint;
      paid?: bigint;
      /** Review 14 R14-1: leave the fill in the newest (not final) Arbitrum block. */
      shallow?: boolean;
    } = {},
  ) {
    const m = txs.get(sourceHash)!;
    const dep = (m.receipt!.logs as Log[]).find((l) => l.address === poolBase)!;
    const x = decodeEventLog({
      abi: SETTLEMENT_ABI,
      data: dep.data as Hex,
      topics: dep.topics as [Hex, ...Hex[]],
    });
    if (x.eventName !== "FundsDeposited") throw new Error("NO_DEPOSIT");
    const a = x.args;
    const recipient = change.recipient ? pad(change.recipient) : a.recipient;
    const output = change.outputAmount ?? a.outputAmount;
    const b = mineBlock("42161");
    const fillHash = keccak256(toHex(`fill:${sourceHash}`));
    const relayer = pad("0x7777777777777777777777777777777777777777");
    const filled = parseAbi([SETTLEMENT_ABI_FILLED])[0];
    const topics = encodeEventTopics({
      abi: [filled],
      eventName: "FilledRelay",
      args: {
        originChainId: 8453n,
        depositId: a.depositId,
        relayer: relayer as Hex,
      },
    });
    const data = encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint32" },
        { type: "uint32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        {
          type: "tuple",
          components: [
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "uint256" },
            { type: "uint8" },
          ],
        },
      ],
      [
        a.inputToken,
        a.outputToken,
        a.inputAmount,
        output,
        8453n,
        a.fillDeadline,
        a.exclusivityDeadline,
        a.exclusiveRelayer,
        a.depositor,
        recipient as Hex,
        ("0x" + "0".repeat(64)) as Hex,
        [recipient as Hex, ("0x" + "0".repeat(64)) as Hex, output, 0],
      ] as never,
    );
    const mk = (
      l: { address: string; topics: string[]; data: string },
      i: number,
    ): Log => ({
      ...l,
      transactionHash: fillHash,
      blockNumber: hex(b.number),
      blockHash: b.hash,
      logIndex: hex(i),
    });
    const paid = change.paid ?? output;
    chains["42161"].logs.push(
      mk({ address: poolArb, topics: topics as string[], data }, 0),
      mk(
        {
          address: usdcArb,
          topics: [
            CANARY_PINS.topics.transfer,
            relayer,
            change.recipient ? pad(change.recipient) : pad(owner),
          ],
          data: word(paid),
        },
        1,
      ),
    );
    if (!change.recipient) {
      state.arbUsdc += paid;
      moves.push({ chain: "42161", block: b.number, usdc: paid });
    }
    // Review 14 R14-1 (SYNTHETIC_TEST_ONLY): by default the fill is FINAL (the Arbitrum confirmation depth follows).
    if (!change.shallow) for (let i = 0; i < 10; i++) mineBlock("42161");
    return fillHash;
  }
  /** A USDC transfer pool -> owner on Base (a refund-looking transfer; nothing ties it to the deposit). */
  function refundLike(amount: bigint, opts: { shallow?: boolean } = {}) {
    const b = mineBlock("8453");
    const h = keccak256(toHex(`refund:${b.number}`));
    chains["8453"].logs.push({
      address: usdcBase,
      topics: [CANARY_PINS.topics.transfer, pad(poolBase), pad(owner)],
      data: word(amount),
      transactionHash: h,
      blockNumber: hex(b.number),
      blockHash: b.hash,
      logIndex: "0x0",
    });
    state.usdc += amount;
    moves.push({ chain: "8453", block: b.number, usdc: amount });
    // Review 14 R14-1 (SYNTHETIC_TEST_ONLY): the refund-looking transfer is FINAL (the Base confirmation depth follows),
    // unless `shallow` leaves it in the newest block (review 15 R15-2).
    if (!opts.shallow) for (let i = 0; i < 10; i++) mineBlock("8453");
  }
  /**
   * Review 15 R15-1 (SYNTHETIC_TEST_ONLY): an unrelated change of the owner's USDC on `chain` in a NEW block (no log);
   * `final` mines the confirmation depth after it. Returns the block number.
   */
  function move(chain: ChainId, usdc: bigint, opts: { final?: boolean } = {}) {
    const b = mineBlock(chain);
    if (chain === "8453") state.usdc += usdc;
    else state.arbUsdc += usdc;
    moves.push({ chain, block: b.number, usdc });
    if (opts.final) for (let i = 0; i < 10; i++) mineBlock(chain);
    return b.number;
  }
  /** An unrelated Approval owner -> Diamond of ANOTHER nonce (a log that matches the search filter, not the step). */
  function strayApproval() {
    const b = mineBlock("8453");
    const h = keccak256(toHex(`stray:${b.number}`));
    txs.set(h, {
      tx: {
        hash: h,
        from: owner,
        to: usdcBase,
        input: "0x",
        value: "0x0",
        nonce: 1n,
        gas: 1n,
      },
      block: b.number,
      receipt: null,
    });
    chains["8453"].logs.push({
      address: usdcBase,
      topics: [CANARY_PINS.topics.approval, pad(owner), pad(diamond)],
      data: word(1n),
      transactionHash: h,
      blockNumber: hex(b.number),
      blockHash: b.hash,
      logIndex: "0x0",
    });
    return h;
  }
  /**
   * G14 follow-up (review 7 R7-3): the PENDING `hash` is dropped by both operators' mempools while its nonce stays
   * UNUSED (nothing else took it); `rebroadcast` later puts the same signed transaction (same hash) back.
   */
  const hidden = new Map<string, Mined>();
  function hide(hash: string) {
    const m = txs.get(hash)!;
    if (m.block !== null || !pending.includes(hash))
      throw new Error("FAKE_CHAIN_NOT_PENDING");
    vanish(hash);
    hidden.set(hash, m);
    state.nonce--;
  }
  function rebroadcast(hash: string) {
    const m = hidden.get(hash)!;
    hidden.delete(hash);
    txs.set(hash, m);
    state.nonce++;
    pending.push(hash);
  }
  /** `hash` disappears from both operators while its nonce stays consumed (another transaction took it). */
  function vanish(hash: string) {
    txs.delete(hash);
    const i = pending.indexOf(hash);
    if (i >= 0) pending.splice(i, 1);
  }
  /**
   * The wallet replaces `hash` (still in the mempool) with another transaction of the SAME nonce: a speed-up of the
   * same request (`change` empty), or another intent (`change.data`). The old one disappears from both operators.
   */
  function replace(hash: string, change: { data?: string } = {}) {
    const old = txs.get(hash)!;
    vanish(hash);
    const data = change.data ?? old.tx.input;
    const next = keccak256(toHex(`replace:${hash}:${data}`));
    txs.set(next, {
      tx: { ...old.tx, hash: next, input: lower(data) },
      block: null,
      receipt: null,
    });
    pending.push(next);
    return next;
  }
  /**
   * Reorganises the block of `hash` away (the transaction returns to the mempool). Review 9 R9-3 (SYNTHETIC_TEST_ONLY):
   * with `requeue` it is mined again by the next `mine`, in a later block.
   */
  function reorg(hash: string, opts: { requeue?: boolean } = {}) {
    const m = txs.get(hash)!;
    chains["8453"].logs = chains["8453"].logs.filter(
      (l) => l.transactionHash !== hash,
    );
    m.receipt = null;
    m.block = null;
    if (opts.requeue && !pending.includes(hash)) pending.push(hash);
  }
  const topicMatch = (want: unknown, have: string | undefined) =>
    want === null || want === undefined
      ? true
      : Array.isArray(want)
        ? want.some((w) => lower(w as string) === lower(have ?? ""))
        : lower(want as string) === lower(have ?? "");
  function handle(
    url: string,
    rpc: { method: string; params: unknown[] },
  ): unknown {
    const chain = (Object.keys(URLS) as ChainId[]).find((c) =>
      (URLS[c] as readonly string[]).includes(url),
    );
    if (!chain) throw new Error("FAKE_CHAIN_UNKNOWN_URL");
    const index = (URLS[chain] as readonly string[]).indexOf(url);
    seen.push({ url, method: rpc.method });
    const mode = index === 1 ? diverge[chain] : undefined;
    if (mode === "OFFLINE") throw new Error("OFFLINE");
    // Only the log reads of operator 1 fail (receipts, transactions and nonces still agree).
    if (
      index === 1 &&
      rpc.method === "eth_getLogs" &&
      diverge[`${chain}:logs`] === "OFFLINE"
    )
      throw new Error("OFFLINE");
    const p = rpc.params;
    switch (rpc.method) {
      case "eth_chainId":
        return chain === "8453" ? "0x2105" : "0xa4b1";
      case "eth_getBlockByNumber": {
        const b =
          p[0] === "latest" && index === 1 && lag[chain]
            ? (chains[chain].blocks.at(-1 - lag[chain]!) ?? null)
            : blockAt(chain, p[0] as string);
        return b ? header(b, mode === "OTHER_HEAD") : null;
      }
      case "eth_getCode":
        return codeOf(chain, p[0] as string);
      case "eth_getStorageAt":
        return IMPL[lower(p[0] as string)]
          ? pad(IMPL[lower(p[0] as string)])
          : word(0n);
      case "eth_call": {
        const c = p[0] as { to: string; data: string };
        return call(chain, c.to, c.data, index, p[1]);
      }
      case "eth_getBalance":
        return hex(state.native);
      case "eth_getTransactionCount": {
        const tag = p[1];
        if (
          state.nonceBefore &&
          typeof tag === "string" &&
          tag.startsWith("0x") &&
          Number(BigInt(tag)) < state.nonceBefore.block
        )
          return hex(state.nonceBefore.value);
        return hex(state.nonce);
      }
      case "eth_maxPriorityFeePerGas":
        return hex(state.tip);
      case "eth_simulateV1":
        return simulate(p[0] as never);
      case "eth_getTransactionReceipt": {
        const m = txs.get(lower(p[0] as string));
        return m ? receiptJson(m) : null;
      }
      case "eth_getTransactionByHash": {
        const m = txs.get(lower(p[0] as string));
        return m
          ? {
              hash: m.tx.hash,
              from: m.tx.from,
              to: m.tx.to,
              input: m.tx.input,
              value: m.tx.value,
              nonce: hex(m.tx.nonce),
              blockNumber: m.block === null ? null : hex(m.block),
            }
          : null;
      }
      case "eth_getLogs": {
        const f = p[0] as {
          address: string | string[];
          fromBlock: string;
          toBlock: string;
          topics: unknown[];
        };
        const addresses = (
          Array.isArray(f.address) ? f.address : [f.address]
        ).map(lower);
        const from = Number(BigInt(f.fromBlock)),
          to = Number(BigInt(f.toBlock));
        return chains[chain].logs.filter(
          (l) =>
            addresses.includes(lower(l.address)) &&
            Number(BigInt(l.blockNumber)) >= from &&
            Number(BigInt(l.blockNumber)) <= to &&
            f.topics.every((t, i) => topicMatch(t, l.topics[i])),
        );
      }
      default:
        throw new Error("FAKE_CHAIN_METHOD " + rpc.method);
    }
  }
  /** A `fetch` for the four pool URLs only (JSON-RPC over POST); anything else fails like a refused connection. */
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const rpc = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    let body: unknown;
    try {
      const result = handle(u, rpc);
      body = {
        jsonrpc: "2.0",
        id: 1,
        result: result === undefined ? null : result,
      };
    } catch (e) {
      if (
        (e as Error).message === "OFFLINE" ||
        (e as Error).message === "FAKE_CHAIN_UNKNOWN_URL"
      )
        throw new TypeError("fetch failed");
      body = {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: (e as Error).message },
      };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    state,
    txs,
    chains,
    diverge,
    lag,
    seen,
    submit,
    mine,
    advance,
    fill,
    refundLike,
    move,
    reorg,
    vanish,
    hide,
    rebroadcast,
    strayApproval,
    replace,
    head,
    fetch: fetchImpl,
  };
}
const SETTLEMENT_ABI_FILLED =
  "event FilledRelay(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint256 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 exclusiveRelayer, bytes32 indexed relayer, bytes32 depositor, bytes32 recipient, bytes32 messageHash, (bytes32 updatedRecipient, bytes32 updatedMessageHash, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)";

/** LI.FI's answer for the canary quote (the recorded public quote of the fixture, as the provider sends it). */
export const lifiAnswer = () => ({
  id: "synthetic-provider-quote",
  type: "lifi",
  tool: fx.tool,
  transactionRequest: { ...fx.transactionRequest },
  estimate: { ...fx.estimate },
});
/** Fake node:https `request` serving one JSON answer per call (the adapter's own upstream transport). */
export function fakeHttps(answer: () => unknown, seen: string[] = []) {
  return (url: unknown, _options: unknown, callback: unknown) => {
    seen.push(String(url));
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const res = {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      on(event: string, fn: (...a: unknown[]) => void) {
        (listeners[event] ??= []).push(fn);
        return res;
      },
      resume: () => undefined,
      destroy: () => undefined,
    };
    const req = {
      on: () => req,
      end: () =>
        queueMicrotask(() => {
          (callback as (r: unknown) => void)(res);
          for (const fn of listeners.data ?? [])
            fn(Buffer.from(JSON.stringify(answer())));
          for (const fn of listeners.end ?? []) fn();
        }),
    };
    return req;
  };
}
export const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
export { erc20Abi };
