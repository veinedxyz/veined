// V1.9 deterministic Privy backend + wallet doubles for browser tests (no App ID needed, no third-party network).
// The REAL Privy SDK (connect-only) runs in the page; every request it makes to Privy or WalletConnect is answered
// here (app config, analytics) or refused, and recorded so tests can prove which hosts were contacted and that
// nothing but minimum session data was sent. Injected wallets are EIP-6963 announcements with recording
// EIP-1193 providers. Nothing here can reach a real wallet or a real Privy app.
import type { BrowserContext, Page, Request } from "@playwright/test";

/** Must equal NEXT_PUBLIC_PRIVY_APP_ID of the test server (scripts/dev-test.mjs). Not a real Privy app. */
export const TEST_PRIVY_APP_ID = "obtestprivyapp00000000001";

export const PRIVY_TEST_APP_CONFIG = {
  id: TEST_PRIVY_APP_ID,
  name: "Otherbridge (test)",
  logo_url: null,
  icon_url: null,
  accent_color: null,
  show_wallet_login_first: true,
  allowlist_config: {
    error_title: null,
    error_detail: null,
    cta_text: null,
    cta_link: null,
  },
  wallet_auth: true,
  email_auth: false,
  sms_auth: false,
  google_oauth: false,
  twitter_oauth: false,
  discord_oauth: false,
  github_oauth: false,
  spotify_oauth: false,
  instagram_oauth: false,
  tiktok_oauth: false,
  line_oauth: false,
  twitch_oauth: false,
  linkedin_oauth: false,
  apple_oauth: false,
  telegram_auth: false,
  telegram_oauth: false,
  farcaster_auth: false,
  passkey_auth: false,
  passkeys_for_signup_enabled: false,
  solana_wallet_auth: false,
  guest_auth: false,
  whatsapp_enabled: false,
  disable_plus_emails: false,
  terms_and_conditions_url: null,
  privacy_policy_url: null,
  require_users_accept_terms: false,
  embedded_wallet_config: {
    create_on_login: "off",
    ethereum: { create_on_login: "off" },
    solana: { create_on_login: "off" },
    user_owned_recovery_options: ["user-passcode"],
    require_user_owned_recovery_on_create: false,
    mode: "user-controlled-server-wallets-only",
  },
  enforce_wallet_uis: false,
  legacy_wallet_ui_config: false,
  mfa_methods: [],
  captcha_enabled: false,
  captcha_site_key: "",
  enabled_captcha_provider: null,
  custom_jwt_auth: false,
  custom_api_url: null,
  custom_oauth_providers: [],
  wallet_connect_cloud_project_id: null,
  fiat_on_ramp_enabled: false,
  funding_config: null,
  smart_wallet_config: { enabled: false },
  telegram_auth_config: null,
  max_linked_wallets_per_user: null,
};

export interface ThirdPartyRequest {
  url: string;
  method: string;
  host: string;
  body: string | null;
  resourceType: string;
}
export interface PrivyMock {
  requests: ThirdPartyRequest[];
}

/**
 * WalletConnect relay double: acknowledges every JSON-RPC request (irn_subscribe, irn_publish, ...) so the real
 * WalletConnect provider can create a pairing and Privy can render its QR code. Nothing is relayed anywhere.
 */
export async function mockWalletConnectRelay(
  target: Page | BrowserContext,
  log: string[] = [],
) {
  await target.routeWebSocket(
    /^wss:\/\/relay\.walletconnect\.(org|com)/,
    (ws) => {
      log.push(`open ${new URL(ws.url()).host}`);
      ws.onMessage((message) => {
        try {
          const request = JSON.parse(String(message)) as {
            id: number;
            method: string;
          };
          log.push(request.method);
          ws.send(
            JSON.stringify({
              id: request.id,
              jsonrpc: "2.0",
              result:
                request.method === "irn_subscribe" ? "0".repeat(64) : true,
            }),
          );
        } catch {
          log.push("unparsable");
        }
      });
    },
  );
  return log;
}

/** Routes every non-loopback request: Privy app config/analytics answered, everything else refused. */
export async function mockPrivyBackend(
  target: Page | BrowserContext,
  options: { outage?: boolean } = {},
): Promise<PrivyMock> {
  const requests: ThirdPartyRequest[] = [];
  await target.route(
    (url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
    async (route) => {
      const request: Request = route.request();
      const url = new URL(request.url());
      requests.push({
        url: `${url.origin}${url.pathname}`,
        method: request.method(),
        host: url.host,
        body: request.postData(),
        resourceType: request.resourceType(),
      });
      if (options.outage) return route.abort("connectionfailed");
      if (url.host === "auth.privy.io") {
        if (
          request.method() === "GET" &&
          url.pathname === `/api/v1/apps/${TEST_PRIVY_APP_ID}`
        )
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(PRIVY_TEST_APP_CONFIG),
          });
        if (url.pathname === "/api/v1/analytics_events")
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: "{}",
          });
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not authenticated (test double)" }),
        });
      }
      // WalletConnect Verify (an attestation iframe) and telemetry: inert blank answers, nothing is forwarded.
      if (/^verify\.walletconnect\.(org|com)$/.test(url.host))
        return route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>verify</title>",
        });
      // WalletConnect wallet registry (used by Privy for the "more wallets" listing): an empty registry.
      if (url.host === "explorer-api.walletconnect.com")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ listings: {}, count: 0 }),
        });
      if (url.host === "pulse.walletconnect.org")
        return route.fulfill({ status: 204, body: "" });
      return route.abort("blockedbyclient");
    },
  );
  return { requests };
}

export interface WalletDouble {
  uuid: string;
  name: string;
  rdns: string;
  /** "solana" announces a non-EVM identity (base58 account) to prove it never becomes an EVM signer. */
  accounts: string[];
  chainId: string;
}
const SVG = (fill: string) =>
  `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='${encodeURIComponent(fill)}'/%3E%3C/svg%3E`;
// Legacy provider flags as the real extensions set them (Privy de-duplicates window.ethereum against EIP-6963).
export const WALLET_DOUBLES = {
  metamask: {
    uuid: "00000000-0000-4000-8000-0000000000a1",
    name: "MetaMask",
    rdns: "io.metamask",
    icon: SVG("#f6851b"),
    flags: { isMetaMask: true },
  },
  rabby: {
    uuid: "00000000-0000-4000-8000-0000000000a2",
    name: "Rabby Wallet",
    rdns: "io.rabby",
    icon: SVG("#7084ff"),
    flags: { isRabby: true, isMetaMask: true },
  },
  phantom: {
    uuid: "00000000-0000-4000-8000-0000000000a3",
    name: "Phantom",
    rdns: "app.phantom",
    icon: SVG("#ab9ff2"),
    flags: { isPhantom: true },
  },
  coinbase: {
    uuid: "00000000-0000-4000-8000-0000000000a4",
    name: "Coinbase Wallet",
    rdns: "com.coinbase.wallet",
    icon: SVG("#0052ff"),
    flags: { isCoinbaseWallet: true },
  },
} as const;

/**
 * Init script: announces recording EIP-6963 wallets. Every request is recorded in window.__walletCalls; signing
 * methods and raw broadcasts throw. `window.__wallets[name]` exposes setAccounts/setChain/disconnect/emit.
 */
export function installWalletDoubles(config: {
  wallets: (keyof typeof WALLET_DOUBLES)[];
  account: string;
  chainId: string;
  send?: "hash" | "reject";
  /** VWP G09: "reject" answers eth_requestAccounts with EIP-1193 4001 a moment later (a person declining). */
  connect?: "accept" | "reject";
  doubles: typeof WALLET_DOUBLES;
  /** Expose the first wallet as window.ethereum too (what an installed extension does). Default true. */
  windowEthereum?: boolean;
}) {
  if (window !== window.top) return;
  type Listener = (value: unknown) => void;
  const calls: {
    wallet: string;
    method: string;
    params: unknown;
    at: number;
  }[] = [];
  const registry: Record<string, unknown> = {};
  (window as unknown as { __walletCalls: unknown }).__walletCalls = calls;
  (window as unknown as { __wallets: unknown }).__wallets = registry;
  for (const key of config.wallets) {
    const meta = config.doubles[key];
    const listeners: Record<string, Listener[]> = {};
    let accounts = [config.account];
    let chainId = config.chainId;
    let connectMode = config.connect ?? "accept";
    // Like a real extension: no account is exposed before the user grants permission (eth_requestAccounts).
    let permitted = false;
    const emit = (event: string, value: unknown) =>
      (listeners[event] ?? []).slice().forEach((fn) => fn(value));
    const fail = (message: string, code: number) =>
      Object.assign(new Error(message), { code });
    const provider = {
      ...meta.flags,
      async request({ method, params }: { method: string; params?: unknown }) {
        calls.push({
          wallet: key,
          method,
          params: JSON.parse(JSON.stringify(params ?? null)),
          at: Date.now(),
        });
        switch (method) {
          case "eth_requestAccounts":
            // A person declines in the extension a moment later (never synchronously).
            if (connectMode === "reject") {
              await new Promise((r) => setTimeout(r, 250));
              throw fail("User rejected the request.", 4001);
            }
            permitted = true;
            return accounts;
          case "eth_accounts":
            return permitted ? accounts : [];
          case "eth_chainId":
            return chainId;
          case "net_version":
            return String(Number(chainId));
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain": {
            chainId = (params as { chainId: string }[])[0].chainId;
            setTimeout(() => emit("chainChanged", chainId), 0);
            return null;
          }
          case "wallet_watchAsset":
            return true;
          case "wallet_requestPermissions":
          case "wallet_getPermissions":
            return [{ parentCapability: "eth_accounts" }];
          case "eth_sendTransaction":
            if (config.send === "reject")
              throw fail("User rejected the request.", 4001);
            return "0x" + "cd".repeat(32);
          default:
            if (/sign|sendRaw/i.test(method))
              throw fail("TEST_SIGNING_REFUSED", 4100);
            throw fail(`unsupported ${method}`, 4200);
        }
      },
      on(event: string, fn: Listener) {
        (listeners[event] ??= []).push(fn);
      },
      removeListener(event: string, fn: Listener) {
        listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
      },
    };
    registry[key] = {
      setAccounts(next: string[]) {
        accounts = next;
        if (permitted) emit("accountsChanged", next);
      },
      setChain(next: string) {
        chainId = next;
        emit("chainChanged", next);
      },
      disconnect() {
        emit("disconnect", { code: 4900 });
      },
      setConnect(next: "accept" | "reject") {
        connectMode = next;
      },
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze({
            info: {
              uuid: meta.uuid,
              name: meta.name,
              icon: meta.icon,
              rdns: meta.rdns,
            },
            provider,
          }),
        }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
    if (config.windowEthereum !== false && key === config.wallets[0])
      (window as unknown as { ethereum: unknown }).ethereum = provider;
    // The Coinbase Wallet SDK talks to the installed extension through this hook.
    if (key === "coinbase")
      (
        window as unknown as { coinbaseWalletExtension: unknown }
      ).coinbaseWalletExtension = provider;
  }
}
