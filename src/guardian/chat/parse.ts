// Guardian chat parser: constrained entity extraction over English and Turkish. Deterministic and bounded: the input is
// cleaned (Unicode-normalized, invisible and direction characters removed, length-capped), folded for matching
// (lowercase, Turkish letters folded to ASCII) and split into words with their case suffix ("Base'ten" → base + from).
// Only words in the vocabulary below become slots; everything else is ignored. Nothing in a message is ever executed.
import { displayText, validIdentity } from "../support";
import { nearAccountKind } from "../near";
import type { ChainKey } from "./model";

export const MAX_MESSAGE = 500;

/** Lowercase + fold Turkish letters so "İSTANBUL", "Ethereum'a" and "ethereum'a" match the same entries. */
export function fold(s: string) {
  return s
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[âà]/g, "a")
    .replace(/[îì]/g, "i")
    .replace(/[ûù]/g, "u");
}

// ---- Vocabulary -------------------------------------------------------------------------------------------------
const CHAIN_WORDS: Record<string, ChainKey> = {
  ethereum: "ethereum",
  mainnet: "ethereum",
  base: "base",
  bsc: "bsc",
  binance: "bsc",
  bep20: "bsc",
  arbitrum: "arbitrum",
  arb: "arbitrum",
  optimism: "optimism",
  polygon: "polygon",
  avalanche: "avalanche",
  near: "near",
};
const CHAIN_PHRASES: [string, ChainKey][] = [
  ["bnb smart chain", "bsc"],
  ["binance smart chain", "bsc"],
  ["bnb chain", "bsc"],
  ["bnb zinciri", "bsc"],
  ["bnb agi", "bsc"],
  ["eth mainnet", "ethereum"],
  ["ethereum mainnet", "ethereum"],
  ["arbitrum one", "arbitrum"],
  ["op mainnet", "optimism"],
  ["avalanche c-chain", "avalanche"],
  ["avax c-chain", "avalanche"],
  ["c-chain", "avalanche"],
  ["near protocol", "near"],
];
/** Networks people name that chat drafts do not cover: answered honestly, never mapped to a supported network. */
export const UNSUPPORTED_CHAIN_WORDS: Record<string, string> = {
  solana: "Solana",
  bitcoin: "Bitcoin",
  tron: "TRON",
  ton: "TON",
  sui: "Sui",
  aptos: "Aptos",
  cosmos: "Cosmos",
  harmony: "Harmony",
  linea: "Linea",
  zksync: "zkSync",
  scroll: "Scroll",
  gnosis: "Gnosis",
  fantom: "Fantom",
  sonic: "Sonic",
  celo: "Celo",
  mantle: "Mantle",
  blast: "Blast",
  cronos: "Cronos",
  starknet: "Starknet",
  cardano: "Cardano",
  polkadot: "Polkadot",
  dogecoin: "Dogecoin",
  litecoin: "Litecoin",
  ripple: "XRP Ledger",
};
/** Token words (display symbols). A symbol is a name, never an identity: the server resolves the exact contract. */
const TOKEN_WORDS: Record<string, string> = {
  eth: "ETH",
  ether: "ETH",
  weth: "WETH",
  usdc: "USDC",
  usdt: "USDT",
  tether: "USDT",
  dai: "DAI",
  wbtc: "WBTC",
  btcb: "BTCB",
  btc: "BTC",
  bnb: "BNB",
  wbnb: "WBNB",
  pol: "POL",
  matic: "MATIC",
  wmatic: "WMATIC",
  avax: "AVAX",
  wavax: "WAVAX",
  sol: "SOL",
  link: "LINK",
  uni: "UNI",
  aave: "AAVE",
  cake: "CAKE",
  usdbc: "USDbC",
  axlusdc: "axlUSDC",
  "usdc.e": "USDC.e",
  "usdt.e": "USDT.e",
  busd: "BUSD",
  wnear: "wNEAR",
  usd: "USD",
  dolar: "USD",
  dollar: "USD",
  dollars: "USD",
};

// Turkish case suffixes after a name ("Base'ten", "Ethereum'a", "USDC'yi"): from, to, on, object.
const ABL = ["nden", "ndan", "den", "dan", "ten", "tan"];
const LOC = ["nde", "nda", "de", "da", "te", "ta"];
const DAT = ["ye", "ya", "ne", "na", "e", "a"];
const ACC = ["yi", "yu", "ni", "nu", "i", "u"];
export type Case = "from" | "to" | "on" | "object" | null;
function suffixCase(s: string): Case {
  if (!s) return null;
  if (ABL.includes(s)) return "from";
  if (LOC.includes(s)) return "on";
  if (DAT.includes(s)) return "to";
  if (ACC.includes(s)) return "object";
  return null;
}
/** Case of a following "network" word: "Base ağından" (from), "ağına" (to), "ağında"/"üzerinde" (on). */
function nounCase(next: string | undefined): Case {
  if (!next) return null;
  if (!/^(ag|zincir|network|chain|uzerin|blockchain)/.test(next)) return null;
  if (/(n?dan|n?den)$/.test(next)) return "from";
  if (/(n?da|n?de|uzerinde)$/.test(next)) return "on";
  if (/(n?a|n?e)$/.test(next) && !/(network|chain)$/.test(next)) return "to";
  return null;
}
const PREP: Record<string, Case> = {
  from: "from",
  to: "to",
  into: "to",
  onto: "to",
  on: "on",
  in: "on",
  at: "on",
  via: "on",
  for: "to",
};

// ---- Words ------------------------------------------------------------------------------------------------------
interface Word {
  text: string; // as typed (cleaned)
  base: string; // folded, without the apostrophe suffix
  suffix: string; // folded apostrophe suffix ("" when none)
  index: number;
}
const WORD =
  /0x[0-9a-fA-F]{40}\b|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:near|tg)\b|\d+(?:[.,]\d+)*|[\p{L}\p{N}$_%-]+(?:\.[\p{L}\p{N}]+)*(?:['’`ʼ][\p{L}]+)?|→|->/gu;
function words(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(WORD)) {
    const t = m[0];
    const at = t.search(/['’`ʼ]/);
    const head = at > 0 ? t.slice(0, at) : t;
    const tail = at > 0 ? t.slice(at + 1) : "";
    out.push({
      text: head,
      base: fold(head),
      suffix: fold(tail),
      index: out.length,
    });
  }
  return out;
}

// ---- Entities ---------------------------------------------------------------------------------------------------
export interface AmountMention {
  value: string;
  index: number;
  /** Two readings of a thousands/decimal separator ("1,000" = 1000 or 1). */
  readings?: [string, string];
}
export interface TokenMention {
  symbol?: string;
  address?: string;
  index: number;
  case: Case;
  afterAmount: boolean;
}
export interface ChainMention {
  chain: ChainKey;
  index: number;
  case: Case;
}
export interface Parsed {
  clean: string;
  folded: string;
  removedHidden: boolean;
  tooLong: boolean;
  /** Mostly letters outside the Latin script: not English or Turkish. */
  foreignScript: boolean;
  amounts: AmountMention[];
  tokens: TokenMention[];
  chains: ChainMention[];
  unsupported: string[];
  addresses: string[];
  nearAccounts: string[];
  solana: string[];
  cues: Set<Cue>;
}

const trimNumber = (int: string, frac: string) => {
  const i = int.replace(/^0+(?=\d)/, "");
  const f = frac.replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
};
/** Number word → normalized decimal (or two readings when the separator is ambiguous). */
export function readAmount(
  raw: string,
): { value: string; readings?: [string, string] } | null {
  if (!/^\d+(?:[.,]\d+)*$/.test(raw)) return null;
  const seps = raw.replace(/\d/g, "");
  let value: string, readings: [string, string] | undefined;
  if (!seps) value = trimNumber(raw, "");
  else if (seps.includes(".") && seps.includes(",")) {
    // Both: the last one is the decimal separator, the other groups thousands (groups of exactly three digits).
    const last = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","));
    const thousands = raw[last] === "." ? "," : ".";
    const int = raw.slice(0, last);
    if (
      !int
        .split(thousands)
        .slice(1)
        .every((g) => g.length === 3)
    )
      return null;
    if (int.includes(raw[last])) return null;
    value = trimNumber(int.split(thousands).join(""), raw.slice(last + 1));
  } else if (seps.length > 1) {
    // One separator used several times: thousands grouping only ("1.000.000").
    const parts = raw.split(seps[0]);
    if (!parts.slice(1).every((g) => g.length === 3)) return null;
    value = trimNumber(parts.join(""), "");
  } else {
    const [int, frac] = raw.split(seps);
    value = trimNumber(int, frac);
    // "1,000" / "1.000": a thousands group in one language, three decimals in another.
    if (frac.length === 3 && /^[1-9]\d{0,2}$/.test(int))
      readings = [trimNumber(int + frac, ""), value];
  }
  const [i, f = ""] = value.split(".");
  if (i.length > 15 || f.length > 18) return null;
  return readings ? { value, readings } : { value };
}

// ---- Cues: the words that signal what a message asks for ---------------------------------------------------------
export type Cue =
  | "swap"
  | "send"
  | "hello"
  | "help"
  | "thanks"
  | "reset"
  | "continue"
  | "quote"
  | "open"
  | "execute"
  | "secrets"
  | "injection"
  | "safe"
  | "token"
  | "address"
  | "why"
  | "blocked"
  | "best"
  | "route"
  | "risk"
  | "explain"
  | "unpriced"
  | "points"
  | "referral"
  | "networks"
  | "levels"
  | "all"
  /** gf1 G04: a question about the page the user is on ("what can I do here?"). */
  | "page";
const CUE_WORDS: [Cue, RegExp][] = [
  [
    "swap",
    /^(swap|swaps|exchange|convert|trade|buy|sell|cevir\w*|takas\w*|degistir\w*|donustur\w*|bozdur\w*|al|almak|alayim|satin|sat|satmak)$/,
  ],
  [
    "send",
    /^(send|bridge|transfer|move|gonder\w*|yolla\w*|aktar\w*|tasi\w*|kopru\w*|transfer\w*)$/,
  ],
  [
    "hello",
    /^(merhaba|selam|selamlar|hi|hello|hey|gunaydin|greetings|slm|mrb)$/,
  ],
  ["help", /^(help|yardim\w*|guide|rehber|neler|capabilities|kimsin|who)$/],
  ["thanks", /^(tesekkur\w*|sagol\w*|thanks|thank|thx|eyvallah)$/],
  [
    "reset",
    /^(iptal\w*|vazgec\w*|cancel|reset|sifirla\w*|temizle\w*|clear|restart|bastan)$/,
  ],
  ["continue", /^(devam\w*|continue|resume)$/],
  ["quote", /^(quote|quotes|teklif\w*|kotasyon\w*|fiyat\w*|price)$/],
  ["open", /^(open|ac|acar|acin|acabilir\w*)$/],
  [
    "execute",
    /^(sign|signed|imzala\w*|approve|approval|onayla\w*|execute|gerceklestir\w*|calistir\w*|broadcast|yayinla\w*|submit|confirm|drain|bosalt\w*)$/,
  ],
  [
    "secrets",
    /^(seed|mnemonic|privatekey|anahtar\w*|kurtarma|recovery|sifre\w*|password)$/,
  ],
  [
    "safe",
    /^(guvenli\w*|safe|safety|legit|scam|dolandirici\w*|sahte|fake|guvenilir\w*|trust\w*|guvenebilir\w*|honeypot)$/,
  ],
  ["token", /^(token\w*|coin\w*|kontrat\w*|contract)$/],
  [
    "address",
    /^(adres\w*|address\w*|account\w*|hesab\w*|hesap\w*|alici\w*|recipient\w*|wallet\w*|cuzdan\w*)$/,
  ],
  ["why", /^(why|neden|niye|nicin|reason)$/],
  [
    "blocked",
    /^(blocked|block|blocks|engel\w*|bloke\w*|durdur\w*|reddet\w*|refused)$/,
  ],
  ["best", /^(best|cheapest|optimal|uygun|iyi|ucuz|en)$/],
  ["route", /^(route|routes|rota\w*|yol|yolu|path|guzergah\w*)$/],
  ["risk", /^(risk\w*|tehlike\w*|danger\w*)$/],
  ["explain", /^(explain|acikla\w*|anlat\w*|describe|meaning|ne|what)$/],
  ["unpriced", /^(unpriced|fiyatsiz\w*|fiyatlandirilma\w*|priced|valuation)$/],
  [
    "points",
    /^(points|point|puan\w*|odul\w*|reward\w*|leaderboard|siralama\w*|havuz\w*|pool|sezon\w*|season)$/,
  ],
  [
    "referral",
    /^(referral\w*|referans\w*|davet\w*|invite\w*|komisyon\w*|commission\w*|%10|10%)$/,
  ],
  [
    "networks",
    /^(networks|network|ag|aglar\w*|agi|zincir\w*|chains|coverage|kapsam\w*)$/,
  ],
  [
    "levels",
    /^(allow|warn|escalate|hold|decision\w*|karar\w*|seviye\w*|level\w*|verdict\w*)$/,
  ],
  ["all", /^(all|tum|hepsi|tamami\w*|everything|max|maximum|maksimum)$/],
];
const PHRASE_CUES: [Cue, RegExp][] = [
  [
    "injection",
    /\b(ignore|disregard|forget)\b.{0,30}\b(instruction|instructions|rules|previous|above|policy|prompt)\b|(talimat\w*|kural\w*|onceki\w*)\b.{0,30}\b(yok say|gormezden gel|unut)|\b(system prompt|sistem istemi|developer mode|gelistirici modu|jailbreak|dan mode|you are now|artik sen|act as|gibi davran|pretend|rol yap)\b|<\||\[\/?system\]|^\s*(system|assistant)\s*:|#{2,}\s*system/,
  ],
  [
    "injection",
    /\b(bypass|skip|disable|override|turn off|atla\w*|kapat\w*|devre disi|gecersiz kil\w*|pas gec\w*)\b.{0,30}\b(guardian|polic\w*|politika\w*|kontrol\w*|check\w*|review\w*|inceleme\w*|guvenlik\w*|security|block\w*|engel\w*)|\b(guardian|polic\w*|politika\w*|kontrol\w*|check\w*|review\w*|inceleme\w*|guvenlik\w*|security)\b.{0,30}\b(bypass|skip|disable|override|turn off|atla\w*|kapat\w*|devre disi|gecersiz kil\w*|pas gec\w*)\b/,
  ],
  [
    "injection",
    /\b(always allow|her zaman izin ver|always approve|allowlist me|whitelist)\b/,
  ],
  [
    "secrets",
    /\b(private key|seed phrase|secret phrase|recovery phrase|ozel anahtar\w*|gizli anahtar\w*|kurtarma (cumle|ifade)\w*|gizli kelime\w*)\b/,
  ],
  [
    "execute",
    /\b(unlimited approv\w*|sinirsiz onay\w*|infinite approv\w*|send all|all my funds|tum bakiye\w*|butun bakiye\w*|tum paramı|tum param\w*|do it now|hemen yap|simdi gonder)\b/,
  ],
  [
    "help",
    /\b(ne yapabilirsin|neler yapabilirsin|what can you do|how (do|can) i use|nasil kullan\w*|what is guardian|guardian nedir|who are you)\b/,
  ],
  ["levels", /\b(ne demek|what does .{1,20} mean|anlami ne)\b/],
  ["best", /\ben (uygun|iyi|ucuz)\b/],
  ["hello", /\b(iyi (aksamlar|gunler|geceler)|good (morning|evening))\b/],
  ["unpriced", /\b(no price|fiyati yok|without (a )?price)\b/],
  [
    "page",
    /\b(what can i do (here|on this (page|screen))|what (is|does) this (page|screen)( do| show| for)?|what('|’| i)?s (on )?this (page|screen)|what is on this (page|screen)|what am i looking at|what do you see( here| on this (page|screen))?|explain this (page|screen)|burada ne yapabilirim|bu (sayfa|ekran)\w* ne yapabilirim|bu (sayfa|ekran) ne\w*|(burada|bu sayfada|bu ekranda) ne var|bu (sayfa|ekran)\w* (acikla|anlat)\w*|ne goruyorsun)\b/,
  ],
];

/** Parse one message. Pure: the same text always yields the same entities and cues. */
export function parse(input: string): Parsed {
  const normalized = input.normalize("NFKC");
  const tooLong = normalized.length > MAX_MESSAGE;
  const clean = displayText(normalized, MAX_MESSAGE).replace(/\s+/g, " ");
  const removedHidden =
    clean !== normalized.trim().replace(/\s+/g, " ").slice(0, MAX_MESSAGE) &&
    !tooLong;
  const letters = [...clean].filter((c) => /\p{L}/u.test(c));
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c));
  const foreignScript =
    letters.length >= 4 && latin.length / letters.length < 0.5;
  const folded = fold(clean);
  const w = words(clean);
  const amounts: AmountMention[] = [],
    tokens: TokenMention[] = [],
    chains: ChainMention[] = [],
    unsupported: string[] = [],
    addresses: string[] = [],
    nearAccounts: string[] = [],
    solana: string[] = [];
  const cues = new Set<Cue>();
  const used = new Set<number>();
  // Multi-word network names first ("BNB Chain", "Arbitrum One").
  for (const [phrase, chain] of CHAIN_PHRASES) {
    const parts = phrase.split(" ");
    for (let i = 0; i + parts.length <= w.length; i++) {
      if (parts.some((p, k) => w[i + k].base !== p || used.has(i + k)))
        continue;
      const last = w[i + parts.length - 1];
      parts.forEach((_, k) => used.add(i + k));
      chains.push({
        chain,
        index: i,
        case:
          suffixCase(last.suffix) ??
          nounCase(w[i + parts.length]?.base) ??
          PREP[w[i - 1]?.base ?? ""] ??
          null,
      });
    }
  }
  w.forEach((word, i) => {
    if (used.has(i)) return;
    const prev = w[i - 1]?.base ?? "";
    const prep = PREP[prev] ?? null;
    const caseOf = () =>
      suffixCase(word.suffix) ?? nounCase(w[i + 1]?.base) ?? prep;
    if (/^0x[0-9a-fA-F]{40}$/.test(word.text)) {
      // An address right after a token word or "contract" is that token's contract; one followed by "address"/"to"
      // or preceded by "to"/"recipient" is the recipient. Anything else is a recipient candidate too.
      const next = w[i + 1]?.base ?? "";
      const recipientContext =
        /^(adres\w*|address\w*|cuzdan\w*|wallet\w*|hesab\w*|alici\w*)$/.test(
          next,
        ) ||
        /^(to|recipient|alici\w*|adres\w*|address)$/.test(prev) ||
        DAT.includes(next);
      const tokenContext =
        !recipientContext &&
        (!!TOKEN_WORDS[prev] ||
          /^(kontrat\w*|contract\w*|token\w*)$/.test(prev) ||
          /^(kontrat\w*|contract\w*|token\w*)$/.test(next));
      if (tokenContext) {
        // "USDC 0x…": the symbol before the address is the name claimed for that exact contract.
        const at = tokens.findIndex((t) => t.index === i - 1 && !t.address);
        const named = at >= 0 ? tokens.splice(at, 1)[0] : undefined;
        tokens.push({
          address: word.text,
          symbol: named?.symbol,
          index: named?.index ?? i,
          case: named?.case ?? caseOf(),
          afterAmount: named?.afterAmount ?? false,
        });
      } else addresses.push(word.text);
      return;
    }
    const lower = word.text.toLowerCase();
    if (
      (/\.(near|tg)$/.test(lower) || /^[0-9a-f]{64}$/.test(lower)) &&
      nearAccountKind(lower)
    ) {
      nearAccounts.push(lower);
      return;
    }
    if (
      word.text.length >= 32 &&
      word.text.length <= 44 &&
      validIdentity(word.text, "SVM")
    ) {
      solana.push(word.text);
      return;
    }
    const amount = readAmount(word.text);
    if (amount) {
      const pct =
        /%$/.test(prev) || /^%/.test(w[i + 1]?.text ?? "") || prev === "%";
      if (!pct) amounts.push({ ...amount, index: i });
      return;
    }
    const base = word.base.replace(/^\$/, "");
    const afterAmount = amounts.some((a) => a.index === i - 1);
    // Chain words carry the action's network; with an attached suffix ("ethereuma", "basete") they still match.
    let chain: ChainKey | undefined = CHAIN_WORDS[base];
    let suffix = word.suffix;
    if (!chain && !TOKEN_WORDS[base] && !word.suffix) {
      for (const [name, key] of Object.entries(CHAIN_WORDS))
        if (
          name.length >= 4 &&
          base.startsWith(name) &&
          suffixCase(base.slice(name.length))
        ) {
          chain = key;
          suffix = base.slice(name.length);
          break;
        }
    }
    // NEAR is both a network and its token: either reading leads to a route toward NEAR.
    if (base === "near") {
      if (afterAmount)
        tokens.push({
          symbol: "NEAR",
          index: i,
          case: caseOf(),
          afterAmount,
        });
      else
        chains.push({
          chain: "near",
          index: i,
          case: suffixCase(suffix) ?? nounCase(w[i + 1]?.base) ?? prep,
        });
      return;
    }
    // "BNB"/"ETH" name a token; "BNB Chain"/"ETH mainnet" were consumed above as networks.
    if (chain && !(TOKEN_WORDS[base] && afterAmount)) {
      chains.push({
        chain,
        index: i,
        case: suffixCase(suffix) ?? nounCase(w[i + 1]?.base) ?? prep,
      });
      return;
    }
    if (UNSUPPORTED_CHAIN_WORDS[base]) {
      unsupported.push(UNSUPPORTED_CHAIN_WORDS[base]);
      return;
    }
    const sym = TOKEN_WORDS[base];
    // An unknown symbol counts only when it is explicit: right after an amount or written as $TICKER.
    const unknown =
      !sym &&
      (afterAmount || /^\$[A-Za-z]/.test(word.text)) &&
      /^[A-Za-z][A-Za-z0-9.]{1,11}$/.test(word.text.replace(/^\$/, ""));
    if (sym || unknown) {
      tokens.push({
        symbol: sym ?? word.text.replace(/^\$/, "").toUpperCase(),
        index: i,
        case: caseOf(),
        afterAmount,
      });
      return;
    }
    for (const [cue, rx] of CUE_WORDS) if (rx.test(word.base)) cues.add(cue);
  });
  for (const [cue, rx] of PHRASE_CUES) if (rx.test(folded)) cues.add(cue);
  // "private key" written as two words, or "anahtar" next to "seed".
  if (/\b(private|ozel|gizli)\b.{0,3}\bkey\b/.test(folded)) cues.add("secrets");
  return {
    clean,
    folded,
    removedHidden,
    tooLong,
    foreignScript,
    amounts,
    tokens,
    chains,
    unsupported: [...new Set(unsupported)],
    addresses: [...new Set(addresses)],
    nearAccounts: [...new Set(nearAccounts)],
    solana: [...new Set(solana)],
    cues,
  };
}
