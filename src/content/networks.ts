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
