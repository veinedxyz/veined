"use client";
import { stateMessage } from "../i18n/messages";
import { useI18n } from "../i18n/provider";
import type { Locale } from "../i18n/config";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { attachPreviewHash, type RoutePreview } from "../routing/history";
import { routingRead, routingMessage } from "../routing/client";
import {
  RoutingError,
  type RouteStatus,
  type StatusInput,
} from "../routing/model";
const response = z.object({
  status: z.enum([
    "PENDING",
    "COMPLETED",
    "PARTIAL",
    "REFUNDED",
    "FAILED",
    "UNKNOWN",
  ]),
  observedAt: z.number(),
  provider: z.literal("routing-core"),
  authoritative: z.boolean(),
  sourceHash: z.string().max(200).optional(),
  destinationHash: z.string().max(200).optional(),
});
export default function RoutingObservation({
  record,
  lang,
}: {
  record: RoutePreview;
  lang: Locale;
}) {
  const [hash, setHash] = useState(record.sourceHash ?? ""),
    [status, setStatus] = useState<RouteStatus>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [now, setNow] = useState(() => Date.now());
  const generation = useRef(0),
    pending = useRef<AbortController | null>(null);
  const { t } = useI18n();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      pending.current?.abort();
    };
  }, []);
  const fresh =
    !!status &&
    status.authoritative &&
    now >= status.observedAt &&
    now - status.observedAt < 30000;
  async function observe() {
    const attempt = ++generation.current,
      c = new AbortController();
    pending.current?.abort();
    pending.current = c;
    setBusy(true);
    setError("");
    setStatus(undefined);
    try {
      const stored = await attachPreviewHash(record.id, hash);
      const context: StatusInput["context"] = {
        source: stored.source,
        destination: stored.destination,
        sourceAsset: stored.sourceAsset,
        destinationAsset: stored.destinationAsset,
        sourceAddress: stored.sourceAddress,
        destinationAddress: stored.destinationAddress,
        amount: stored.amount,
        minimum: stored.minimum,
        generation: stored.generation,
        slippage: stored.slippage,
        preference: stored.preference,
        walletRevision: stored.walletRevision,
      };
      const current = response.parse(
        await routingRead(
          {
            action: "status",
            source: stored.source,
            destination: stored.destination,
            hash,
            context,
          },
          c.signal,
        ),
      );
      if (attempt === generation.current && !c.signal.aborted) {
        setStatus(current);
        setNow(Date.now());
      }
    } catch (e) {
      if (attempt === generation.current && !c.signal.aborted)
        setError(e instanceof RoutingError ? e.code : "INVALID_RESPONSE");
    } finally {
      if (attempt === generation.current) setBusy(false);
    }
  }
  return (
    <div className="routing-observation">
      <p className="input-hint">{t("ui.youMayAttachAnExternalTransaction")}</p>
      <label htmlFor={`observe-${record.id}`}>
        {t("ui.sourceTransactionHash")}
      </label>
      <input
        id={`observe-${record.id}`}
        className="native-address"
        value={hash}
        autoComplete="off"
        onChange={(e) => {
          generation.current++;
          pending.current?.abort();
          setBusy(false);
          setStatus(undefined);
          setHash(e.target.value);
        }}
      />
      <button disabled={busy || !hash} onClick={() => void observe()}>
        {t("ui.observeStatusReadOnly")}
      </button>
      <p role="status">
        {fresh
          ? stateMessage(lang, status.status)
          : t("ui.noCurrentVerifiedObservation")}
      </p>
      {fresh && (
        <p className="input-hint">
          {new Date(status.observedAt).toLocaleString(lang)} ·{" "}
          {t("ui.routeStatusObservation30S")}
        </p>
      )}
      {fresh && status.destinationHash && (
        <code className="native-address">{status.destinationHash}</code>
      )}
      {error && (
        <p className="notice" role="alert">
          {routingMessage(error, lang)}
        </p>
      )}
    </div>
  );
}
