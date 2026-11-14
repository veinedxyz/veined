"use client";
// V1.9 Privy external-wallet layer (connect-only). Loaded lazily on the first "Connect wallet" click, mounted once
// at the product root, never during SSR. It only wires Privy's hooks to the ExternalWalletController, which owns
// the normalized session. No login, no embedded wallet, no signing hook is used here. If Privy cannot become
// ready (outage, blocked network, bad App ID) the session becomes "unavailable" — there is no fallback to any
// injected provider.
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  PrivyProvider,
  SUPPORTED_CHAINS,
  useConnectWallet,
  useModalStatus,
  usePrivy,
  useWallets,
} from "@privy-io/react-auth";
import { ExternalWalletController, type PrivyWalletLike } from "../controller";
import { walletStore } from "../store";
import { privyConnectOnlyConfig, type ChainLike } from "./config";

const READY_TIMEOUT_MS = 20000;
// Privy snapshots its wallet list when the modal opens and registers injected (EIP-6963) connectors right after
// it initializes — immediately when an extension exposes an injected provider, otherwise after its own ~3 s
// announcement wait. Opening only after that settles keeps the list complete (MetaMask, Rabby, Phantom, ...).
const DETECTION_SETTLE_MS = { injected: 600, none: 3600 };

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

function Bridge({ description }: { description: string }) {
  const { ready } = usePrivy();
  const { wallets } = useWallets();
  const controller = useMemo(
    () => new ExternalWalletController(walletStore),
    [],
  );
  // Only a connection the user started from Otherbridge (and has not since cancelled with Disconnect) may become
  // the active wallet; a late success after Disconnect is ignored.
  const connectIntent = useRef(false);
  // When the layer unmounts (route outside the product shell, crash) the controller detaches and stays silent;
  // the setup re-activates it (React StrictMode runs one setup/cleanup/setup cycle on mount).
  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);
  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet }) => {
      if (!connectIntent.current) return;
      connectIntent.current = false;
      void controller.select(wallet as PrivyWalletLike);
    },
  });
  const connectRef = useRef(connectWallet);
  // Privy's modal traps focus but does not hand it back: return it to the control that opened the modal (or the
  // header wallet control that replaced it after a connection).
  const { isOpen } = useModalStatus();
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (isOpen) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const restore = () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const target = opener.current?.isConnected
        ? opener.current
        : document.querySelector<HTMLElement>("header .wallet-button");
      target?.focus();
    };
    requestAnimationFrame(restore);
  }, [isOpen]);
  useEffect(() => {
    connectRef.current = connectWallet;
  }, [connectWallet]);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(
      () => walletStore.unavailable("WALLET_UNAVAILABLE"),
      READY_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [ready]);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!ready || settled) return;
    const injected =
      "ethereum" in window && !!(window as { ethereum?: unknown }).ethereum;
    const timer = setTimeout(
      () => setSettled(true),
      injected ? DETECTION_SETTLE_MS.injected : DETECTION_SETTLE_MS.none,
    );
    return () => clearTimeout(timer);
  }, [ready, settled]);
  useEffect(() => {
    if (!ready || !settled) return;
    if (walletStore.get().status === "loading")
      walletStore.set({ ...walletStore.get(), status: "disconnected" });
    return walletStore.register({
      open: () => {
        opener.current =
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== document.body
            ? document.activeElement
            : null;
        connectIntent.current = true;
        connectRef.current({ walletChainType: "ethereum-only", description });
      },
      disconnect: () => {
        connectIntent.current = false;
        controller.disconnect();
      },
    });
  }, [ready, settled, controller, description]);
  useEffect(() => {
    controller.syncConnected(wallets as unknown as PrivyWalletLike[]);
  }, [wallets, controller]);
  return null;
}

export default function PrivyWalletLayer({
  appId,
  theme,
  description,
}: {
  appId: string;
  theme: "dark" | "light";
  description: string;
}) {
  const config = useMemo(
    () =>
      privyConnectOnlyConfig({
        theme,
        chains: SUPPORTED_CHAINS as unknown as ChainLike[],
      }),
    [theme],
  );
  return (
    <LayerBoundary>
      <PrivyProvider
        appId={appId}
        config={
          config as unknown as Parameters<typeof PrivyProvider>[0]["config"]
        }
      >
        <Bridge description={description} />
      </PrivyProvider>
    </LayerBoundary>
  );
}
