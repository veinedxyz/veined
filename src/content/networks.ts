import type { CSSProperties } from "react";

// Visual identity only. Eligibility, chain IDs and write gates stay in core/adapters.
export const networkIdentity = {
  onechain: {
    name: "ONEchain",
    shortName: "ONEchain",
    logo: "/networks/onechain.svg",
    primary: "#ec1272",
    accent: "#f3752d",
    glow: "236 18 114",
    badgeDark: "#f5b3c9",
    badgeLight: "#962944",
    logoSurface: "transparent",
  },
  bsc: {
    name: "BNB Smart Chain",
    shortName: "BSC",
    logo: "/networks/bsc.svg",
    primary: "#f0b90b",
    accent: "#e1c77a",
    glow: "240 185 11",
    badgeDark: "#e8c66b",
    badgeLight: "#70530d",
    logoSurface: "#0b0e11",
  },
} as const;

export type NetworkId = keyof typeof networkIdentity;
type ThemeStyle = CSSProperties & Record<`--${string}`, string>;

export function networkStyle(id: NetworkId): ThemeStyle {
  const identity = networkIdentity[id];
  return {
    "--network-primary": identity.primary,
    "--network-accent": identity.accent,
    "--network-glow": identity.glow,
    "--network-badge-dark": identity.badgeDark,
    "--network-badge-light": identity.badgeLight,
    "--network-logo-surface": identity.logoSurface,
  };
}

export const routeSceneStyle: ThemeStyle = {
  "--source-glow": networkIdentity.onechain.glow,
  "--destination-glow": networkIdentity.bsc.glow,
};
