// Public Markdown reports stay brand-neutral (V1.x public-copy policy): catalog names that collide with the routing
// provider's brand are withheld in docs only. Machine catalogs and APIs keep the exact upstream identity.
const BRAND =
  /(?<![\p{L}\p{N}])li[ .-]?fi(?![\p{L}\p{N}])|jumper|routing\s+infrastructure|rota\s+altyap[ıi]s[ıi]|powered\s+by/giu;
export const publicText = (value: string) =>
  value.replace(BRAND, "[name withheld in public docs]");
