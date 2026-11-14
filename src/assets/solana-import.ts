import { validIdentity, SwapError } from "../swap/model";
import {
  decodeSolMint,
  type RawSolAccount,
} from "../swap/server/solana-accounts";
import { rpc } from "../swap/server/transport";
import { knownAsset, type AssetView, type PreviewStep } from "./registry";
import { SOLANA_CHAIN_ID } from "./model";
/** Exact mint only: never infers identity, decimals, symbol or logo from a ticker. */
export async function previewSolanaMint(address: string, signal: AbortSignal) {
  if (!validIdentity(address, "SVM")) throw new SwapError("INVALID_REQUEST");
  const raw = (await rpc(
    "solana",
    "getAccountInfo",
    [address, { encoding: "base64", commitment: "confirmed" }],
    signal,
  )) as { context?: { slot: number }; value: RawSolAccount | null };
  if (!raw.value || !Number.isSafeInteger(raw.context?.slot))
    throw new SwapError("REVIEW_REQUIRED");
  const mint = decodeSolMint(raw.value),
    known = knownAsset(SOLANA_CHAIN_ID, address);
  if (known && known.decimals !== mint.decimals)
    throw new SwapError("REVIEW_REQUIRED");
  const asset: AssetView = {
    chainId: SOLANA_CHAIN_ID,
    address,
    native: false,
    symbol: known?.symbol ?? address.slice(0, 6),
    name: known?.name ?? address,
    decimals: mint.decimals,
    level: known?.level ?? "IMPORTED_UNVERIFIED",
    sources: [...(known?.sources ?? []), "onchain", "user-import"],
    logo: known?.logo ?? null,
    logoUrl: known?.logo?.src ?? null,
    risk: known?.risk ?? ["NO_MARKET_EVIDENCE"],
    routable: false,
    routeStatus: "UNKNOWN",
    evidence: {
      curated: known?.level === "CURATED",
      trustWallet: known?.sources.includes("trustwallet") ?? false,
      marketListed: null,
      dex: null,
      onebridge: null,
    },
  };
  const steps: PreviewStep[] = [
    { step: "address", ok: true, detail: address },
    { step: "code", ok: true, detail: mint.program },
    { step: "metadata", ok: true, detail: String(mint.decimals) },
  ];
  return {
    asset,
    steps,
    warnings: asset.risk,
    importable: asset.level !== "BLOCKED",
    proof: {
      slot: raw.context!.slot,
      program: mint.program,
      extensions: mint.extensions,
    },
  };
}
