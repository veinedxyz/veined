"use client";
// V1.10 shared product primitives. Small on purpose: product.tsx is in the first-load bundle, so everything here is
// plain markup plus class names (CSP: no style attributes; geometry goes through components/virtual.ts).
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "./icons";
// Every code-split view imports this module, so the non-core icons are registered before any of them renders.
import "./icons-extra";

export type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

export function PageHeader({
  title,
  lede,
  meta,
  actions,
  id,
}: {
  title: ReactNode;
  lede?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <div className="page-heading">
      <div className="page-heading-text">
        <h1 id={id}>{title}</h1>
        {lede && <p className="page-lede">{lede}</p>}
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Pill({
  tone = "neutral",
  icon,
  dot = false,
  children,
  className,
  title,
}: {
  tone?: Tone;
  icon?: IconName;
  dot?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={`pill tone-${tone}${className ? ` ${className}` : ""}`}
      title={title}
    >
      {dot && <span className="pill-dot" aria-hidden="true" />}
      {icon && <Icon name={icon} size={14} />}
      <span className="pill-text">{children}</span>
    </span>
  );
}

// Deterministic, CSP-safe token monogram: the hue comes from one of eight static classes picked by a hash of the
// symbol, never from runtime CSS text.
export function tokenHue(symbol: string) {
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return h % 8;
}
export function TokenAvatar({
  symbol,
  size = "md",
}: {
  symbol: string;
  size?: "sm" | "md" | "lg";
}) {
  const text = [...(symbol || "?").replace(/[^\p{L}\p{N}]/gu, "")]
    .slice(0, 3)
    .join("")
    .toUpperCase();
  return (
    <span
      className={`token-avatar token-avatar-${size} tk-${tokenHue(symbol)}${text.length > 2 ? " token-avatar-3" : ""}`}
      aria-hidden="true"
    >
      {text || "?"}
    </span>
  );
}

export function Skeleton({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div
      className={`skeleton-block${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    >
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton-line" />
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
  className,
}: {
  icon: IconName;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`empty-state${className ? ` ${className}` : ""}`}>
      <span className="empty-icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <div className="empty-text">
        <h2>{title}</h2>
        {children}
      </div>
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}

export function useCopy(onError?: () => void) {
  const [copied, setCopied] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(value);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(""), 2000);
      } catch {
        onError?.();
      }
    },
    [onError],
  );
  return { copied, copy };
}

export const shortAddress = (value: string) =>
  value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
