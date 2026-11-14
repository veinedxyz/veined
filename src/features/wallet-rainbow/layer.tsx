"use client";
// gf1 G02 RainbowKit external-wallet layer (connect-only; see ./config.ts for the boundary). Loaded lazily on the first
// "Connect wallet" click, mounted once at the product root, never during SSR. It only wires wagmi/RainbowKit to the
// ExternalWalletController, which owns the normalized session. No signing hook, no RPC, no persistence. If the layer
// crashes the session becomes "unavailable"; nothing falls back to any other provider.
import "@rainbow-me/rainbowkit/styles.css";
import "./rainbow-theme.css";
import { Component, useEffect, useMemo, useRef, type ReactNode } from "react";
import { setNonce } from "get-nonce";
import {
  RainbowKitProvider,
  useConnectModal,
  type Locale,
} from "@rainbow-me/rainbowkit";
import {
  WagmiProvider,
  createConfig,
  useAccount,
  useConnections,
  useDisconnect,
} from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExternalWalletController } from "../wallet/controller";
import { walletStore } from "../wallet/store";
import {
  RAINBOW_CHAINS,
  guardConnectChain,
  rainbowLocale,
  refusingTransports,
  toExternalWallet,
} from "./config";

// The modal's scroll lock injects one <style> element: give it the per-request CSP nonce the layout publishes
// (the production style-src has no 'unsafe-inline').
const nonceMeta =
  typeof document === "undefined"
    ? null
    : document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]');
if (nonceMeta?.nonce) setNonce(nonceMeta.nonce);

const wagmiConfig = createConfig({
  chains: RAINBOW_CHAINS,
  connectors: [],
  multiInjectedProviderDiscovery: true,
  transports: refusingTransports(RAINBOW_CHAINS),
  storage: null,
  ssr: false,
});
// G14 closure (C / W-2): connecting never passes a chain to the wallet's connector, so connecting on any network
// (Linea, an unsupported one) asks for NO network switch. Applied once, right after the config exists — to the
// connectors it has now and to every connector wallet discovery adds later — before anything can render a wallet
// list. It is module scope (not an effect), so re-renders and Strict Mode never wrap twice or subscribe twice; a hot
// reload that re-evaluates this module first releases the previous config's subscription. The wrap replaces only the
// connector's connect method in place (identity, uid, emitter, `this` and every other method are unchanged).
// Switching networks stays an explicit owner action through the wallet adapter's trusted registry.
{
  const unguard = guardConnectChain(wagmiConfig);
  // The hot-reload slot exists only in development builds (review 1 F13): production exposes no handle to it.
  if (process.env.NODE_ENV !== "production") {
    const slot = globalThis as typeof globalThis & {
      __veinedGuardConnectChain?: () => void;
    };
    slot.__veinedGuardConnectChain?.();
    slot.__veinedGuardConnectChain = unguard;
  }
}
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
  },
});

class LayerBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    walletStore.unavailable("WALLET_UNAVAILABLE");
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Bridge() {
  const controller = useMemo(
    () => new ExternalWalletController(walletStore),
    [],
  );
  // Only a connection the user started from VEINED (and has not since cancelled) may become the active wallet.
  const intent = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const { connector, address, chainId, status } = useAccount();
  const { disconnect, disconnectAsync } = useDisconnect();
  const connections = useConnections();
  const openRef = useRef(openConnectModal);
  const statusRef = useRef(status);
  const disconnectRef = useRef(disconnectAsync);
  // RainbowKit hands out openConnectModal only while disconnected; a request made before that waits here.
  const pendingOpen = useRef(false);
  useEffect(() => {
    openRef.current = openConnectModal;
    statusRef.current = status;
    disconnectRef.current = disconnectAsync;
    if (pendingOpen.current && openConnectModal) {
      pendingOpen.current = false;
      openConnectModal();
    }
  }, [openConnectModal, status, disconnectAsync]);
  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => {
    if (walletStore.get().status === "loading")
      walletStore.set({ ...walletStore.get(), status: "disconnected" });
    return walletStore.register({
      open: () => {
        opener.current =
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== document.body
            ? document.activeElement
            : null;
        intent.current = true;
        // "Change wallet": RainbowKit opens its connect modal only while disconnected, so the current connection
        // (and with it the VEINED session) ends first; the modal opens as soon as RainbowKit allows it.
        if (statusRef.current === "connected" || !openRef.current) {
          pendingOpen.current = true;
          if (statusRef.current === "connected") void disconnectRef.current();
        } else openRef.current();
      },
      disconnect: () => {
        intent.current = false;
        controller.disconnect();
      },
    });
  }, [controller]);
  // The user's pick in the modal becomes the active wallet through the controller (bounded live reads, new epoch).
  useEffect(() => {
    if (!intent.current || status !== "connected" || !connector || !address)
      return;
    intent.current = false;
    const picked = connector;
    void controller.select(
      toExternalWallet({
        connector: picked,
        address,
        chainId: chainId ?? 0,
        disconnect: () => disconnect({ connector: picked }),
      }),
    );
  }, [status, connector, address, chainId, controller, disconnect]);
  // A connection that ends on the wallet side (or in wagmi) ends the session; the list never selects a wallet.
  useEffect(() => {
    controller.syncConnected(
      connections.map((c) => ({
        connectorType: c.connector.type,
        walletClientType: c.connector.id,
      })),
    );
  }, [connections, controller]);
  // Closing the modal without a connection cancels the intent; focus returns to the control that opened it.
  useEffect(() => {
    if (connectModalOpen) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    if (statusRef.current === "disconnected") intent.current = false;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const target = opener.current?.isConnected
        ? opener.current
        : document.querySelector<HTMLElement>("header .wallet-button");
      target?.focus();
    });
  }, [connectModalOpen]);
  return null;
}

export default function RainbowWalletLayer({ language }: { language: string }) {
  return (
    <LayerBoundary>
      <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider
            theme={null}
            modalSize="compact"
            locale={rainbowLocale(language) as Locale}
            appInfo={{ appName: "VEINED", learnMoreUrl: "/docs/safety" }}
          >
            <Bridge />
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </LayerBoundary>
  );
}
