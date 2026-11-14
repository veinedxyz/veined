"use client";
import { LogoImage } from "./logo-image";
import { useI18n } from "../i18n/provider";
import type { Network } from "../routing/model";
import { themeClass } from "../content/network-themes";
import { TokenAvatar } from "./ui";
// V1.5 CSP: identity colours come from same-origin generated classes, never inline styles.
export function chainThemeClass(
  network: Pick<Network, "theme"> | null | undefined,
) {
  return themeClass(network?.theme);
}
export function ChainLogo({
  network,
  size = "md",
}: {
  network: Pick<Network, "theme" | "key"> & Partial<Pick<Network, "name">>;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      className={`network-mark network-mark-${size} ${chainThemeClass(network)}`}
      data-network-logo={network.key}
      aria-hidden="true"
    >
      {network.theme.logo && network.theme.logo !== "/networks/neutral.svg" ? (
        <LogoImage src={network.theme.logo} size={40} />
      ) : (
        <TokenAvatar
          symbol={
            network.name
              ? network.name
                  .split(/[\s-]+/)
                  .map((word) => word[0])
                  .join("")
                  .slice(0, 2)
              : network.key.replace(/^chain-/, "N")
          }
          size={size}
        />
      )}
    </span>
  );
}
export function ChainBadge({ network }: { network: Network }) {
  const { t } = useI18n();
  return (
    <span
      className={`network-badge ${chainThemeClass(network)}`}
      data-network={network.key}
    >
      <ChainLogo network={network} size="sm" />
      <span>{network.name}</span>
      {!network.mainnet && <span className="env-tag">{t("v111.testnet")}</span>}
    </span>
  );
}
