// Guardian NEAR layer: account intelligence and pre-signing review of NEAR transactions (including NEP-366 meta
// transactions). Browser-safe and pure. Input is the JSON a dApp hands to a NEAR wallet (wallet-selector style
// `{ receiverId, actions: [{ type, params }] }` or near-api-js style `{ type, ...fields }`); nothing here signs,
// relays or broadcasts. Account rules follow the NEAR protocol: 2–64 characters, lowercase alphanumerics separated
// by `-`/`_`, dot-separated parts; 64 lowercase hex characters are an implicit (ed25519) account and `0x` + 40 hex an
// ETH-implicit account (NEP-518).
import { z } from "zod";
import { displayText } from "./support";
import { GUARDIAN_POLICY, finding, type Finding, type SafeStep } from "./model";

export type NearAccountKind =
  "named" | "subaccount" | "implicit" | "eth-implicit" | "top-level";
const NAMED = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export function nearAccountKind(id: string): NearAccountKind | null {
  if (typeof id !== "string" || id.length < 2 || id.length > 64) return null;
  if (/^[0-9a-f]{64}$/.test(id)) return "implicit";
  if (/^0x[0-9a-f]{40}$/.test(id)) return "eth-implicit";
  if (!NAMED.test(id)) return null;
  const parts = id.split(".");
  return parts.length === 1
    ? "top-level"
    : parts.length === 2
      ? "named"
      : "subaccount";
}
export const validNearAccount = (id: string) => nearAccountKind(id) !== null;
/** The account that created a sub-account (`a.b.near` → `b.near`). It created the name; it does not control it. */
export const nearParent = (id: string) =>
  nearAccountKind(id) === "subaccount" ? id.slice(id.indexOf(".") + 1) : null;

export interface KnownNearAccount {
  id: string;
  label: string;
  kind: "token" | "protocol";
  /** A bridged token variant names the canonical asset it is not. */
  variantOf?: string;
}
// Curated mainnet accounts Guardian recognises (labels are display text; identity is always the exact account id).
export const KNOWN_NEAR: readonly KnownNearAccount[] = Object.freeze([
  { id: "wrap.near", label: "Wrapped NEAR (wNEAR)", kind: "token" },
  {
    id: "usdt.tether-token.near",
    label: "USDt (native on NEAR)",
    kind: "token",
  },
  {
    id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    label: "USDC (native on NEAR)",
    kind: "token",
  },
  {
    id: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near",
    label: "USDC.e (bridged from Ethereum)",
    kind: "token",
    variantOf:
      "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  },
  {
    id: "dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near",
    label: "USDT.e (bridged from Ethereum)",
    kind: "token",
    variantOf: "usdt.tether-token.near",
  },
  {
    id: "2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near",
    label: "WBTC (bridged from Ethereum)",
    kind: "token",
  },
  { id: "meta-pool.near", label: "Meta Pool stNEAR", kind: "token" },
  { id: "linear-protocol.near", label: "LiNEAR", kind: "token" },
  { id: "token.sweat", label: "SWEAT", kind: "token" },
  { id: "intents.near", label: "NEAR Intents verifier", kind: "protocol" },
  { id: "v1.signer", label: "Chain Signatures MPC signer", kind: "protocol" },
  { id: "v2.ref-finance.near", label: "Ref Finance", kind: "protocol" },
  { id: "aurora", label: "Aurora engine", kind: "protocol" },
]);
const KNOWN = new Map(KNOWN_NEAR.map((a) => [a.id, a]));
export const knownNearAccount = (id: string) => KNOWN.get(id);

// Confusable skeleton: characters and pairs attackers swap to make an account read like another one.
function skeleton(id: string) {
  return id
    .toLowerCase()
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/[0]/g, "o")
    .replace(/[1il|]/g, "l")
    .replace(/5/g, "s")
    .replace(/[_.-]+/g, "");
}
function distance(a: string, b: string) {
  // Damerau-Levenshtein (optimal string alignment), bounded inputs (≤ 64 characters).
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}
const LURE =
  /(claim|airdrop|reward|bonus|gift|verify|support|wallet-?connect|giveaway)/;
const hexLookalike = (a: string, b: string) =>
  a !== b &&
  a.length === b.length &&
  a.slice(0, 6) === b.slice(0, 6) &&
  a.slice(-6) === b.slice(-6);

/** The known account `id` is pretending to be, if any (exact matches are not look-alikes). */
export function nearLookalike(id: string, extra: readonly string[] = []) {
  const candidates = [...KNOWN_NEAR.map((a) => a.id), ...extra];
  if (candidates.includes(id)) return undefined;
  for (const known of candidates) {
    if (/^[0-9a-f]{64}$|^0x[0-9a-f]{40}$/.test(known)) {
      if (hexLookalike(id, known)) return known;
      continue;
    }
    if (skeleton(id) === skeleton(known)) return known;
    const [head] = known.split(".");
    // An account that embeds a known name as one of its parts but is not that account (wrap.near.claim.near,
    // wrap-near.near) reads like the real one.
    if (head.length >= 4 && id.replace(/[-_]/g, ".").includes(known))
      return known;
    if (
      known.length >= 8 &&
      Math.abs(known.length - id.length) <= 2 &&
      distance(id, known) <= 2
    )
      return known;
  }
  return undefined;
}

const short = (id: string) =>
  id.length > 24 ? `${id.slice(0, 10)}…${id.slice(-8)}` : id;
const show = (id: string) => displayText(short(id), 40);

/** Findings for one NEAR account in the role it plays (recipient, contract being called, beneficiary …). */
export function reviewNearAccount(
  id: string,
  options: { known?: readonly string[]; role?: "recipient" | "receiver" } = {},
): Finding[] {
  const kind = nearAccountKind(id);
  if (!kind)
    return [
      finding("NEAR_ACCOUNT_INVALID", "CRITICAL", "ACCOUNT", {
        account: show(id),
      }),
    ];
  const out: Finding[] = [];
  const known = knownNearAccount(id);
  if (known) {
    out.push(
      finding("NEAR_ACCOUNT_KNOWN", "PASS", "ACCOUNT", {
        account: show(id),
        label: known.label,
      }),
    );
    if (known.variantOf)
      out.push(
        finding("NEAR_TOKEN_BRIDGED_VARIANT", "CAUTION", "ASSET", {
          label: known.label,
          canonical:
            knownNearAccount(known.variantOf)?.label ?? show(known.variantOf),
        }),
      );
    return out;
  }
  // Accounts the user already trusts (their own, an agent policy allowlist) are not look-alikes of each other.
  const userKnown = !!options.known?.includes(id);
  const imitates = userKnown ? undefined : nearLookalike(id, options.known);
  if (imitates)
    out.push(
      finding("NEAR_ACCOUNT_LOOKALIKE", "CRITICAL", "ACCOUNT", {
        account: show(id),
        imitates: knownNearAccount(imitates)?.label ?? show(imitates),
      }),
    );
  else if (!userKnown && LURE.test(id))
    out.push(
      finding("NEAR_ACCOUNT_LURE", "WARNING", "ACCOUNT", { account: show(id) }),
    );
  if (kind === "implicit")
    out.push(
      finding("NEAR_ACCOUNT_IMPLICIT", "CAUTION", "ACCOUNT", {
        account: show(id),
      }),
    );
  if (kind === "eth-implicit")
    out.push(
      finding("NEAR_ACCOUNT_ETH_IMPLICIT", "INFO", "ACCOUNT", {
        account: show(id),
      }),
    );
  if (kind === "subaccount")
    out.push(
      finding("NEAR_ACCOUNT_SUBACCOUNT", "INFO", "ACCOUNT", {
        account: show(id),
        parent: show(nearParent(id)!),
      }),
    );
  if (options.role === "receiver" && !imitates && !userKnown)
    out.push(
      finding("NEAR_RECEIVER_UNKNOWN", "CAUTION", "ACCOUNT", {
        account: show(id),
      }),
    );
  return out;
}

// ---- NEAR transactions ----
const yocto = z.string().regex(/^(0|[1-9]\d{0,39})$/);
const accountId = z.string().min(1).max(64);
const permission = z.union([
  z.literal("FullAccess"),
  z
    .object({
      receiverId: accountId,
      methodNames: z.array(z.string().max(256)).max(64).default([]),
      allowance: yocto.nullable().optional(),
    })
    .strict(),
]);
type Action =
  | { type: "Transfer"; deposit: string }
  | {
      type: "FunctionCall";
      methodName: string;
      args: unknown;
      gas: string;
      deposit: string;
    }
  | {
      type: "AddKey";
      publicKey: string;
      permission: z.infer<typeof permission>;
    }
  | { type: "DeleteKey"; publicKey: string }
  | { type: "DeleteAccount"; beneficiaryId: string }
  | { type: "DeployContract" }
  | { type: "Stake"; stake: string }
  | { type: "CreateAccount" }
  | { type: "Delegate"; delegate: NearDelegate };
export interface NearDelegate {
  senderId: string;
  receiverId: string;
  actions: Action[];
  maxBlockHeight: string;
}
export interface NearTransaction {
  signerId?: string;
  receiverId: string;
  actions: Action[];
}
const actionSchema: z.ZodType<Action> = z.lazy(() =>
  z
    .preprocess(
      // wallet-selector puts the fields under `params`; near-api-js JSON keeps them flat.
      (raw) => {
        const r = raw as { type?: unknown; params?: unknown } | null;
        return r &&
          typeof r === "object" &&
          r.params &&
          typeof r.params === "object"
          ? { type: r.type, ...r.params }
          : raw;
      },
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("Transfer"), deposit: yocto }).strict(),
        z
          .object({
            type: z.literal("FunctionCall"),
            methodName: z.string().min(1).max(256),
            args: z.unknown().optional(),
            gas: z
              .string()
              .regex(/^\d{1,20}$/)
              .default("30000000000000"),
            deposit: yocto.default("0"),
          })
          .strict(),
        z
          .object({
            type: z.literal("AddKey"),
            publicKey: z.string().min(1).max(128),
            accessKey: z
              .object({ permission, nonce: z.unknown().optional() })
              .strict(),
          })
          .strict(),
        z
          .object({
            type: z.literal("DeleteKey"),
            publicKey: z.string().min(1).max(128),
          })
          .strict(),
        z
          .object({
            type: z.literal("DeleteAccount"),
            beneficiaryId: accountId,
          })
          .strict(),
        z
          .object({
            type: z.literal("DeployContract"),
            code: z.unknown().optional(),
            codeSha256: z.string().max(128).optional(),
          })
          .strict(),
        z
          .object({
            type: z.literal("Stake"),
            stake: yocto,
            publicKey: z.string().min(1).max(128),
          })
          .strict(),
        z.object({ type: z.literal("CreateAccount") }).strict(),
        z
          .object({
            type: z.literal("Delegate"),
            delegateAction: z
              .object({
                senderId: accountId,
                receiverId: accountId,
                actions: z.array(z.unknown()).min(1).max(32),
                nonce: z.union([z.string(), z.number()]).optional(),
                maxBlockHeight: z.union([
                  z.string().regex(/^\d{1,20}$/),
                  z.number().int().nonnegative(),
                ]),
                publicKey: z.string().min(1).max(128),
              })
              .strict(),
          })
          .strict(),
      ]),
    )
    .transform((a): Action => {
      if (a.type === "AddKey")
        return {
          type: "AddKey",
          publicKey: a.publicKey,
          permission: a.accessKey.permission,
        };
      if (a.type === "FunctionCall")
        return {
          type: "FunctionCall",
          methodName: a.methodName,
          args: a.args,
          gas: a.gas,
          deposit: a.deposit,
        };
      if (a.type === "DeployContract") return { type: "DeployContract" };
      if (a.type === "Stake") return { type: "Stake", stake: a.stake };
      if (a.type === "Delegate") {
        const inner = a.delegateAction;
        return {
          type: "Delegate",
          delegate: {
            senderId: inner.senderId,
            receiverId: inner.receiverId,
            // Meta transactions cannot nest another Delegate (NEP-366).
            actions: inner.actions.map((x) => nonDelegate.parse(x)),
            maxBlockHeight: String(inner.maxBlockHeight),
          },
        };
      }
      return a;
    }),
);
const nonDelegate: z.ZodType<Action> = z.lazy(() =>
  actionSchema.refine((a) => a.type !== "Delegate", "nested delegate"),
);
export const nearTransactionSchema = z
  .object({
    signerId: accountId.optional(),
    receiverId: accountId,
    actions: z.array(actionSchema).min(1).max(32),
  })
  .strict();
export function parseNearTransaction(value: unknown): NearTransaction {
  return nearTransactionSchema.parse(value) as NearTransaction;
}

const formatNear = (raw: string) => {
  const v = BigInt(raw),
    whole = v / 10n ** 24n,
    frac = (v % 10n ** 24n)
      .toString()
      .padStart(24, "0")
      .slice(0, 4)
      .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const FT_METHODS = new Set(["ft_transfer", "ft_transfer_call"]);
const objectArgs = (args: unknown): Record<string, unknown> | undefined => {
  if (args && typeof args === "object" && !Array.isArray(args))
    return args as Record<string, unknown>;
  return undefined;
};

/** Pre-signing review of one NEAR transaction: every action, every account it touches and every key it grants. */
export function reviewNearTransaction(
  tx: NearTransaction,
  known: readonly string[] = [],
): { findings: Finding[]; steps: SafeStep[]; checks: number } {
  const findings: Finding[] = [],
    steps = new Set<SafeStep>();
  let checks = 0;
  const signer = tx.signerId;
  // Receivers the user already trusts (their own accounts, an agent policy allowlist) or Guardian's curated list.
  const trusted = (id: string) => known.includes(id) || !!knownNearAccount(id);
  function actions(
    receiver: string,
    list: Action[],
    signerId: string | undefined,
    depth: number,
  ) {
    const ownAccount = !!signerId && receiver === signerId;
    let receiverReviewed = false;
    const reviewReceiver = () => {
      if (receiverReviewed || ownAccount) return;
      receiverReviewed = true;
      checks++;
      findings.push(
        ...reviewNearAccount(receiver, { known, role: "receiver" }),
      );
    };
    for (const a of list) {
      checks++;
      if (a.type === "Transfer") {
        checks++;
        findings.push(
          ...reviewNearAccount(receiver, { known, role: "recipient" }),
        );
        findings.push(
          finding(
            "NEAR_DEPOSIT",
            trusted(receiver) ? "INFO" : "CAUTION",
            "EXECUTION",
            {
              amount: formatNear(a.deposit),
              account: show(receiver),
            },
          ),
        );
        if (!trusted(receiver)) steps.add("CHECK_RECIPIENT");
      } else if (a.type === "FunctionCall") {
        reviewReceiver();
        if (BigInt(a.deposit) >= GUARDIAN_POLICY.nearDepositCaution)
          findings.push(
            finding(
              "NEAR_DEPOSIT",
              trusted(receiver) ? "INFO" : "CAUTION",
              "EXECUTION",
              {
                amount: formatNear(a.deposit),
                account: show(receiver),
              },
            ),
          );
        const args = objectArgs(a.args);
        if (
          FT_METHODS.has(a.methodName) &&
          args &&
          typeof args.receiver_id === "string"
        ) {
          checks++;
          findings.push(
            finding(
              "NEAR_TOKEN_TRANSFER",
              trusted(args.receiver_id) ? "INFO" : "CAUTION",
              "ASSET",
              {
                method: a.methodName,
                token: knownNearAccount(receiver)?.label ?? show(receiver),
                account: show(args.receiver_id),
              },
            ),
          );
          findings.push(
            ...reviewNearAccount(args.receiver_id, {
              known,
              role: "recipient",
            }),
          );
          if (!trusted(args.receiver_id)) steps.add("CHECK_RECIPIENT");
        }
      } else if (a.type === "AddKey") {
        checks++;
        if (a.permission === "FullAccess") {
          findings.push(
            finding("NEAR_KEY_FULL_ACCESS", "CRITICAL", "KEY", {
              account: show(receiver),
            }),
          );
          steps.add("STOP").add("LIMITED_KEY");
        } else {
          const p = a.permission;
          findings.push(
            finding("NEAR_KEY_FUNCTION_CALL", "INFO", "KEY", {
              contract:
                knownNearAccount(p.receiverId)?.label ?? show(p.receiverId),
              methods: p.methodNames.length
                ? p.methodNames
                    .slice(0, 4)
                    .map((m) => displayText(m, 32))
                    .join(", ")
                : "*",
            }),
          );
          if (
            p.allowance === null ||
            p.allowance === undefined ||
            p.methodNames.length === 0
          )
            findings.push(
              finding("NEAR_KEY_UNLIMITED", "CAUTION", "KEY", {
                contract: show(p.receiverId),
              }),
            );
          findings.push(
            ...reviewNearAccount(p.receiverId, { known, role: "receiver" }),
          );
        }
      } else if (a.type === "DeleteAccount") {
        checks++;
        findings.push(
          finding("NEAR_DELETE_ACCOUNT", "CRITICAL", "ACCOUNT", {
            account: show(receiver),
            beneficiary: show(a.beneficiaryId),
          }),
        );
        findings.push(
          ...reviewNearAccount(a.beneficiaryId, { known, role: "recipient" }),
        );
        steps.add("STOP");
      } else if (a.type === "DeployContract") {
        findings.push(
          finding("NEAR_DEPLOY_CONTRACT", "CRITICAL", "ACCOUNT", {
            account: show(receiver),
          }),
        );
        steps.add("STOP");
      } else if (a.type === "DeleteKey") {
        findings.push(
          finding("NEAR_DELETE_KEY", "WARNING", "KEY", {
            account: show(receiver),
          }),
        );
      } else if (a.type === "Stake") {
        findings.push(
          finding("NEAR_STAKE", "CAUTION", "EXECUTION", {
            amount: formatNear(a.stake),
          }),
        );
      } else if (a.type === "Delegate" && depth === 0) {
        const d = a.delegate;
        findings.push(
          finding("NEAR_DELEGATE", "INFO", "EXECUTION", {
            sender: show(d.senderId),
            relayer: show(signerId ?? receiver),
            height: d.maxBlockHeight,
          }),
        );
        actions(d.receiverId, d.actions, d.senderId, 1);
      }
    }
  }
  actions(tx.receiverId, tx.actions, signer, 0);
  const critical = findings.some((f) => f.severity === "CRITICAL");
  if (findings.some((f) => f.code === "NEAR_TOKEN_BRIDGED_VARIANT"))
    steps.add("PREFER_NATIVE");
  if (
    findings.some(
      (f) =>
        f.code === "NEAR_ACCOUNT_LOOKALIKE" ||
        f.code === "NEAR_ACCOUNT_INVALID",
    )
  )
    steps.add("STOP").add("CHECK_RECIPIENT");
  if (
    !critical &&
    findings.some((f) => f.code === "NEAR_DEPOSIT" && f.severity === "CAUTION")
  )
    steps.add("TEST_TRANSFER");
  return { findings, steps: [...steps], checks };
}

// ---- NEP-413 signed messages ----
// A NEP-413 signature can never be a transaction, but `intents.near` executes signed intents (transfer, withdraw,
// add_public_key …) without any further approval: a "sign this message" request for it moves funds.
export const nearMessageSchema = z
  .object({
    message: z.string().min(1).max(16384),
    recipient: accountId,
    nonce: z.string().max(128).optional(),
    callbackUrl: z.string().max(512).optional(),
  })
  .strict();
export type NearMessage = z.infer<typeof nearMessageSchema>;
const intentSchema = z
  .object({
    intent: z.string().max(64),
    receiver_id: z.string().max(64).optional(),
    public_key: z.string().max(128).optional(),
  })
  .loose();
const intentsPayload = z
  .object({
    signer_id: z.string().max(64).optional(),
    verifying_contract: z.string().max(64).optional(),
    intents: z.array(intentSchema).max(32),
  })
  .loose();
export function reviewNearMessage(
  m: NearMessage,
  known: readonly string[] = [],
) {
  const findings: Finding[] = [],
    steps = new Set<SafeStep>();
  let checks = 2,
    payload: z.infer<typeof intentsPayload> | undefined;
  try {
    const parsed = intentsPayload.safeParse(JSON.parse(m.message));
    if (parsed.success) payload = parsed.data;
  } catch {}
  const verifier =
    m.recipient === "intents.near" ||
    payload?.verifying_contract === "intents.near";
  if (!verifier && !payload) {
    findings.push(
      finding("NEAR_SIGNED_LOGIN", "INFO", "EXECUTION", {
        recipient: show(m.recipient),
      }),
    );
    findings.push(
      ...reviewNearAccount(m.recipient, { known }).filter(
        (x) => x.severity !== "PASS",
      ),
    );
    return { findings, steps: [...steps], checks };
  }
  const intents = payload?.intents ?? [];
  findings.push(
    finding("NEAR_SIGNED_INTENT", "WARNING", "EXECUTION", {
      count: intents.length,
      kinds:
        [...new Set(intents.map((i) => displayText(i.intent, 24)))]
          .slice(0, 4)
          .join(", ") || "—",
    }),
  );
  steps.add("CHECK_RECIPIENT");
  for (const i of intents) {
    checks++;
    if (i.intent === "add_public_key") {
      findings.push(
        finding("NEAR_INTENT_ADD_KEY", "CRITICAL", "KEY", {
          account: show(payload?.signer_id ?? "?"),
        }),
      );
      steps.add("STOP");
    }
    if (i.receiver_id)
      findings.push(
        ...reviewNearAccount(i.receiver_id, { known, role: "recipient" }),
      );
  }
  return { findings, steps: [...steps], checks };
}

/** NEAR accounts that would receive value from this transaction (transfer targets, token receivers, beneficiaries). */
export function nearRecipients(tx: NearTransaction): string[] {
  const out: string[] = [];
  const walk = (receiver: string, list: Action[]) => {
    for (const a of list) {
      if (a.type === "Transfer") out.push(receiver);
      if (a.type === "DeleteAccount") out.push(a.beneficiaryId);
      if (a.type === "FunctionCall" && FT_METHODS.has(a.methodName)) {
        const r = objectArgs(a.args)?.receiver_id;
        if (typeof r === "string") out.push(r);
      }
      if (a.type === "Delegate")
        walk(a.delegate.receiverId, a.delegate.actions);
    }
  };
  walk(tx.receiverId, tx.actions);
  return [...new Set(out)];
}
