import { NextResponse, type NextRequest } from "next/server";
import { validPrivyAppId } from "./features/wallet/privy/config";
// V1.5 CSP. Production: no 'unsafe-inline' for scripts or styles; scripts need the per-request nonce
// ('strict-dynamic'), stylesheets must be same-origin files, and inline style attributes are refused
// (style-src-attr 'none'); runtime geometry uses the CSSOM, which CSP does not govern. Development
// keeps 'unsafe-eval' (React dev tooling) and inline styles (Next dev style injection) only.
// V1.9: when (and only when) a Privy App ID is configured, the exact origins the external-wallet layer needs are
// added: Privy's API and WalletConnect's relay/verify/registry. No wildcard, no remote script origin (the SDK
// ships in the npm bundle), no 'unsafe-inline'/'unsafe-eval' in production; the wallet modal's styles carry
// the request nonce. Inventory: docs/PRIVY_DATA_FLOW.md.
export const PRIVY_CSP = Object.freeze({
  connect: Object.freeze([
    "https://auth.privy.io",
    "wss://relay.walletconnect.org",
    "wss://relay.walletconnect.com",
    "https://explorer-api.walletconnect.com",
    "https://pulse.walletconnect.org",
    "https://verify.walletconnect.org",
    "https://verify.walletconnect.com",
  ]),
  frame: Object.freeze([
    "https://verify.walletconnect.org",
    "https://verify.walletconnect.com",
  ]),
  img: Object.freeze(["https://explorer-api.walletconnect.com"]),
  // The only static <style> block in the SDK: inside its bundled MetaMask logo SVG. Allowed by exact hash in
  // production (never 'unsafe-inline'); tests re-derive it from the installed SDK.
  styleHashes: Object.freeze([
    "'sha256-QlwpTd7Ve6xx/zCJuRcdEKxpvG41xq7uvysQt5tkwaY='",
  ]),
});
export function contentSecurityPolicy(
  nonce: string,
  development: boolean,
  privy = false,
) {
  const extra = (list: readonly string[]) =>
    privy ? list.map((origin) => ` ${origin}`).join("") : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    development
      ? "style-src 'self' 'unsafe-inline'"
      : `style-src 'self' 'nonce-${nonce}'${extra(PRIVY_CSP.styleHashes)}`,
    ...(development ? [] : ["style-src-attr 'none'"]),
    `img-src 'self' data:${extra(PRIVY_CSP.img)}`,
    `connect-src 'self'${development ? " ws://127.0.0.1:3100" : ""}${extra(PRIVY_CSP.connect)}`,
    "font-src 'self'",
    privy ? `frame-src${extra(PRIVY_CSP.frame)}` : "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
    validPrivyAppId(process.env.NEXT_PUBLIC_PRIVY_APP_ID),
  );
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
