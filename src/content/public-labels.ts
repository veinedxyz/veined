import { translate, type MessageKey } from "../i18n/messages";
import type { Locale } from "../i18n/config";
// Display labels only: upstream identifiers and financial values remain intact.
export const publicBrandDenylist =
  /(?<![\p{L}\p{N}])li[ .-]?fi(?![\p{L}\p{N}])|jumper(?:\.exchange)?|defillama|llama\.fi|goldrush|covalent|routing\s+infrastructure|rota\s+altyap[ıi]s[ıi]|powered\s+by|mevcut[^.!?\n]{0,60}altyap[ıi]/iu;

export function neutralToolName(name: string): string {
  if (/^(integrator fee|feeCollection)$/i.test(name.trim()))
    return "Route service fee";
  if (!publicBrandDenylist.test(name)) return name;
  if (/intent/i.test(name)) return "Intent routing";
  if (/dex|exchange|swap|aggregator/i.test(name)) return "Exchange routing";
  return "Route service";
}

export function neutralFeeName(name: string, kind: "fee" | "gas" = "fee") {
  return publicBrandDenylist.test(name) || /integrator\s+fee/i.test(name)
    ? kind === "gas"
      ? "Network fee"
      : "Route service fee"
    : name;
}

const labelKeys: Record<string, MessageKey> = {
  "Route service fee": "ui.routeServiceFee",
  "Network fee": "ui.networkFee",
  "Intent routing": "ui.intentRouting",
  "Exchange routing": "ui.exchangeRouting",
  "Route service": "ui.routeService",
};
export function publicToolLabel(name: string, lang: Locale) {
  const neutral = neutralToolName(name);
  return labelKeys[neutral] ? translate(lang, labelKeys[neutral]) : neutral;
}
export function publicStepKindLabel(kind: string, lang: Locale) {
  const keys: Record<string, MessageKey> = {
    bridge: "kinds.bridge",
    exchange: "kinds.exchange",
    protocol: "kinds.protocol",
    fee: "kinds.fee",
    gas: "kinds.gas",
  };
  return translate(lang, keys[kind] ?? "kinds.unknown");
}
export function publicFeeLabel(
  name: string,
  lang: Locale,
  kind: "fee" | "gas" = "fee",
) {
  const neutral = neutralFeeName(name, kind);
  return translate(
    lang,
    labelKeys[neutral] ??
      (kind === "gas" ? "ui.networkFee" : "ui.routeServiceFee"),
  );
}
