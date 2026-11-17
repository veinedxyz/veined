"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import ManualWalletView from "./manual-wallet-view";
import { walletStore, EMPTY_SESSION } from "../features/wallet/store";
import {
  manualApi,
  manualAuthority,
  resetManualSession,
} from "../manual-wallet/client";
import type { ManualLane, ManualPreparation } from "../manual-wallet/protocol";
import type { LaneReview } from "../swap/lane/engine";
import type { BridgeLaneReview } from "../swap/lane/bridge-engine";
import "./manual-wallet-premium.css";
import {
  runFastflow,
  trackingMessage,
  type FastReview,
  type FastTracking,
} from "../manual-wallet/fastflow";

type Review = LaneReview | BridgeLaneReview;
export interface ManualWalletViewProps {
  lane: ManualLane;
  connected: boolean;
  address?: string;
  walletName?: string;
  chainId?: number;
  review?: Review;
  preparation?: ManualPreparation;
  tracking?: unknown;
  error: string;
  busy: boolean;
  hash: string;
  now: number;
  fresh: boolean;
  status: string;
  onConnect: () => void;
  onSwitch: () => void;
  onAction: (action: "review" | "execute" | "track") => void;
}

export default function ManualWallet({
  lane,
  onConnect,
}: {
  lane: ManualLane;
  onConnect: () => void;
}) {
  const session = useSyncExternalStore(
    walletStore.subscribe,
    walletStore.get,
    () => EMPTY_SESSION,
  );
  const [review, setReview] = useState<Review>();
  const [preparation, setPreparation] = useState<ManualPreparation>();
  const [tracking, setTracking] = useState<unknown>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState("");
  const [now, setNow] = useState(0);
  const [status, setStatus] = useState("");
  const operating = useRef(false);
  const mounted = useRef(true);
  const connected = session.status === "connected" && Boolean(session.provider);
  useEffect(() => {
    mounted.current = true;
    resetManualSession();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const initial = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, []);
  const fresh = Boolean(now > 0 && review?.ready && review.expiresAt > now);
  async function run(action: "review" | "execute" | "track") {
    if (operating.current) return;
    operating.current = true;
    if (action !== "track") setBusy(true);
    setError("");
    const adapter = session.provider,
      epoch = session.epoch;
    const current = () =>
      mounted.current &&
      walletStore.get().epoch === epoch &&
      walletStore.get().provider === adapter;
    try {
      if (!adapter || session.status !== "connected")
        throw Error("WALLET_NOT_CONNECTED");
      const identity = await adapter.identity();
      if (identity.chainId !== 8453) throw Error("WALLET_CHAIN_MISMATCH");
      if (!current()) throw Error("WALLET_SESSION_STALE");
      const common = { lane, account: identity.account, chainId: 8453 };
      const getReview = async () => {
        setStatus("Checking quote & Guardian…");
        const reply = await manualApi({ ...common, action: "review" });
        if (!current()) throw Error("WALLET_SESSION_STALE");
        setReview(reply.review);
        return reply.review as Review;
      };
      if (action === "execute") {
        const started = performance.now();
        await runFastflow(
          {
            review: getReview,
            prepare: async (r: FastReview) => {
              const reply = await manualApi({
                ...common,
                action: "prepare",
                reviewId: r.reviewId,
              });
              if (current()) setPreparation(reply.preparation);
              return reply.preparation;
            },
            send: async (p) => {
              const authority = await manualAuthority(
                adapter,
                lane,
                p,
                current,
              );
              if (current())
                setStatus(
                  `Confirm in wallet · ${((performance.now() - started) / 1000).toFixed(1)}s to request`,
                );
              return adapter.sendManualTransaction(authority);
            },
            track: async () => {
              const reply = await manualApi({ ...common, action: "track" });
              if (current()) setTracking(reply.tracking);
              return reply.tracking as FastTracking;
            },
            current,
            status: (message) => {
              if (current()) setStatus(message);
            },
            submitted: (txHash) => {
              if (current()) {
                setHash(txHash);
                setPreparation(undefined);
                setReview(undefined);
              }
            },
            wait: () => new Promise((resolve) => setTimeout(resolve, 2500)),
            now: Date.now,
          },
          review,
        );
      } else if (action === "review") {
        setPreparation(undefined);
        await getReview();
        if (current()) setStatus("");
      } else {
        const reply = await manualApi({ ...common, action: "track" });
        if (current()) {
          setTracking(reply.tracking);
          setStatus(trackingMessage(String(reply.tracking.state)));
          if (reply.tracking.state === "SETTLED_VERIFIED") {
            setReview(undefined);
            setPreparation(undefined);
          }
        }
      }
    } catch (e) {
      if (current()) {
        setError(
          String(
            (e as { code?: unknown; message?: unknown }).code ??
              (e as Error).message ??
              "MANUAL_REQUEST_FAILED",
          ),
        );
        if (action === "execute") {
          setPreparation(undefined);
          setReview(undefined);
        }
      }
    } finally {
      operating.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!connected || session.chainId !== 8453) return;
    const timer = setTimeout(() => void run("review"), 100);
    return () => clearTimeout(timer);
    // Identity changes remount this controller; no repeated quote loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, session.epoch, session.chainId]);
  useEffect(() => {
    if (
      !hash ||
      !connected ||
      (tracking as { state?: string } | undefined)?.state === "SETTLED_VERIFIED"
    )
      return;
    const timer = setInterval(() => {
      if (!operating.current && !document.hidden) void run("track");
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hash,
    connected,
    session.epoch,
    (tracking as { state?: string } | undefined)?.state,
  ]);
  async function switchBase() {
    try {
      await session.provider?.switchManualBase();
    } catch (e) {
      setError(
        String((e as { code?: unknown }).code ?? "WALLET_SWITCH_REFUSED"),
      );
    }
  }
  return (
    <ManualWalletView
      lane={lane}
      connected={connected}
      address={session.address}
      walletName={session.walletName}
      chainId={session.chainId}
      review={review}
      preparation={preparation}
      tracking={tracking}
      error={error}
      busy={busy}
      hash={hash}
      now={now}
      fresh={fresh}
      status={status}
      onConnect={onConnect}
      onSwitch={() => void switchBase()}
      onAction={(action) => void run(action)}
    />
  );
}
