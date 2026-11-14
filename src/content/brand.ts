/** Public identity only. This does not authorize an origin, a deployment, or execution. */
export const brand = Object.freeze({
  name: "VEINED",
  domain: "veined.xyz",
  publicOrigin: "https://veined.xyz",
  category: "Multichain Portfolio, Swap & Bridge",
  historicalName: "Otherbridge",
  assetStatus: "OWNER_APPROVED_VISUAL_IDENTITY",
  recommendedConcept: "quiet-current",
  ownerLogoApproval: "OWNER_APPROVED_VISUAL_IDENTITY",
  visualApprovalRecord: "release/veined-visual-approval.json",
  legalTrademarkClearance: "OPEN",
  sloganApproval: "NOT_APPROVED",
  productionReleaseApproval: "OPEN",
  // Guardian finalization preview (isolated): the owner-approved octopus artwork. Canonical acceptance of this
  // identity is a separate owner decision (brand supersession proposal); the Quiet Current record above is unchanged.
  previewIdentity: Object.freeze({
    candidate: "octopus-v1",
    status: "OWNER_APPROVED_ARTWORK_ISOLATED_PREVIEW",
    source: "design-assets/brand-candidates/veined-octopus-v1.png",
    sourceSha256:
      "7ec4859a5c6dbe3b682423d5b7bd0a38b087e988e76bf9c55ffcd3f87aac0274",
    derivatives: "/assets/veined/brand-octopus/brand-manifest.json",
    canonical: "NOT_APPLIED",
  }),
  social: Object.freeze({
    x: Object.freeze({ handle: "@veinedxyz", confirmed: false }),
  }),
  sections: [
    "Portfolio",
    "Swap",
    "Bridge",
    "Explore",
    "Activity",
    "Networks",
    "Docs",
  ],
} as const);
