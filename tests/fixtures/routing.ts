import snapshot from "../../src/routing/catalog-snapshot.json" with { type: "json" };
import { normalizeChains, normalizeTools } from "../../src/routing/catalog";
import {
  quoteBinding,
  type Catalog,
  type Network,
  type QuoteInput,
} from "../../src/routing/model";
export const sender = "0x3333333333333333333333333333333333333333";
export const addresses = {
  EVM: sender,
  SVM: "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z",
  UTXO: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  MVM: `0x${"1".repeat(64)}`,
  TVM: "T9yD14Nj9j7xAB4dbGeiX9h8unkKLxmGkn",
  STL: "GDLVVGABQKYQVN6VJP7NHSLEA45A5YLS6PNKMIZFV4BBU2HXA5IRVHUR",
};
export function fixtureCatalog(now = Date.now()): Catalog {
  return {
    networks: normalizeChains(snapshot.chains),
    tools: normalizeTools(snapshot.tools),
    observedAt: now,
    generation: "synthetic-fixture-catalog",
    stale: false,
  };
}
export function fixtureNetwork(key: string): Network {
  const n = fixtureCatalog().networks.find((n) => n.key === key);
  if (!n) throw Error(`Missing current catalog network ${key}`);
  return n;
}
export function fixtureInput(source = "eth", destination = "bas"): QuoteInput {
  const f = fixtureNetwork(source),
    t = fixtureNetwork(destination);
  return {
    source: f.id,
    destination: t.id,
    sourceAsset: f.nativeAsset.address,
    destinationAsset: t.nativeAsset.address,
    amount: "10000000000000000",
    sourceAddress: addresses[f.ecosystem],
    destinationAddress: addresses[t.ecosystem],
    slippage: 0.005,
    preference: "receive",
    walletRevision: 0,
    generation: "synthetic-fixture-catalog",
  };
}
export function fixtureQuote(input: QuoteInput = fixtureInput()) {
  const catalog = fixtureCatalog(),
    f = catalog.networks.find((n) => n.id === input.source)!,
    t = catalog.networks.find((n) => n.id === input.destination)!,
    tool = catalog.tools.find((t) => t.kind === "bridge")!;
  return {
    id: "SYNTHETIC-QUOTE-NOT-AN-EXECUTION",
    type: "lifi",
    tool: tool.id,
    toolDetails: {
      key: tool.id,
      name: tool.name,
      logoURI: "https://invalid.example/unused.svg",
    },
    action: {
      fromChainId: f.id,
      toChainId: t.id,
      fromToken: f.nativeAsset,
      toToken: t.nativeAsset,
      fromAddress: input.sourceAddress,
      toAddress: input.destinationAddress,
      fromAmount: input.amount,
      slippage: input.slippage,
    },
    estimate: {
      fromAmount: input.amount,
      toAmount: "9000000",
      toAmountMin: "8955000",
      executionDuration: 45,
      approvalAddress: sender,
      fromAmountUSD: "30",
      toAmountUSD: "29.95",
      feeCosts: [
        {
          name: "Bridge fee",
          amount: "100",
          amountUSD: "0.05",
          token: f.nativeAsset,
          included: true,
        },
      ],
      gasCosts: [
        {
          type: "SEND",
          amount: "1000",
          amountUSD: "0.02",
          token: f.nativeAsset,
        },
      ],
    },
    transactionRequest: { to: sender, data: "0xDEADBEEF", value: "1" },
    typedData: [{ untrusted: "never expose" }],
    binding: quoteBinding(input),
  };
}
