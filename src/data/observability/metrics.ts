// V1.5 Prometheus-compatible, self-hosted metrics registry. Bounded cardinality by construction:
// label names/values are validated, wallet/token addresses are rejected, and every metric has a hard
// series cap (excess series are dropped and counted, never stored). Shared per process via globalThis
// so separately bundled server modules (Next instrumentation vs. route handlers) see one registry.
type Labels = Record<string, string>;
type Kind = "counter" | "gauge" | "histogram";
interface Family {
  kind: Kind;
  help: string;
  series: Map<
    string,
    {
      labels: Labels;
      value: number;
      buckets?: number[];
      sum?: number;
      count?: number;
      samples?: number[];
    }
  >;
  bounds?: number[];
}
const ADDRESS =
  /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])|(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/;
const NAME = /^[a-z_][a-z0-9_]{0,80}$/;
const LABEL_NAME = /^[a-z_][a-z0-9_]{0,40}$/;
export const DEFAULT_SERIES_CAP = 600;
export const LATENCY_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
];
class Registry {
  families = new Map<string, Family>();
  dropped = new Map<string, number>();
  constructor(private cap = DEFAULT_SERIES_CAP) {}
  private family(name: string, kind: Kind, help = "", bounds?: number[]) {
    if (!NAME.test(name)) throw Error("METRIC_NAME_INVALID");
    let f = this.families.get(name);
    if (!f) {
      f = { kind, help, series: new Map(), bounds };
      this.families.set(name, f);
    } else if (f.kind !== kind) throw Error("METRIC_KIND_CONFLICT");
    if (help && !f.help) f.help = help;
    return f;
  }
  private key(labels: Labels) {
    const entries = Object.entries(labels).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [k, v] of entries) {
      if (!LABEL_NAME.test(k)) throw Error("METRIC_LABEL_NAME_INVALID");
      // Developer error: an address in a label is a privacy and cardinality bug.
      if (ADDRESS.test(v)) throw Error("ADDRESS_IN_METRIC_LABEL");
    }
    const clean = Object.fromEntries(
      entries.map(([k, v]) => [
        k,
        String(v)
          .replace(/[^A-Za-z0-9_.:/-]/g, "_")
          .slice(0, 80) || "_",
      ]),
    );
    return { id: JSON.stringify(clean), labels: clean };
  }
  private slot(f: Family, name: string, labels: Labels) {
    const { id, labels: clean } = this.key(labels);
    let s = f.series.get(id);
    if (!s) {
      if (f.series.size >= this.cap) {
        this.dropped.set(name, (this.dropped.get(name) ?? 0) + 1);
        return null;
      }
      s = { labels: clean, value: 0 };
      if (f.kind === "histogram") {
        s.buckets = new Array(f.bounds!.length).fill(0);
        s.sum = 0;
        s.count = 0;
        s.samples = [];
      }
      f.series.set(id, s);
    }
    return s;
  }
  inc(name: string, labels: Labels = {}, value = 1, help = "") {
    if (!Number.isFinite(value) || value < 0) return;
    const s = this.slot(this.family(name, "counter", help), name, labels);
    if (s) s.value += value;
  }
  set(name: string, labels: Labels, value: number, help = "") {
    if (!Number.isFinite(value)) return;
    const s = this.slot(this.family(name, "gauge", help), name, labels);
    if (s) s.value = value;
  }
  observe(
    name: string,
    labels: Labels,
    value: number,
    help = "",
    bounds = LATENCY_BUCKETS_MS,
  ) {
    if (!Number.isFinite(value) || value < 0) return;
    const f = this.family(name, "histogram", help, bounds);
    const s = this.slot(f, name, labels);
    if (!s) return;
    f.bounds!.forEach((b, i) => {
      if (value <= b) s.buckets![i]++;
    });
    s.sum! += value;
    s.count!++;
    s.samples!.push(value);
    if (s.samples!.length > 2000) s.samples!.shift();
  }
  reset() {
    this.families.clear();
    this.dropped.clear();
  }
  // Prometheus text exposition format 0.0.4.
  render(prefix = "otherbridge_") {
    const esc = (v: string) =>
      v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    const fmt = (labels: Labels, extra: Labels = {}) => {
      const all = { ...labels, ...extra };
      const parts = Object.entries(all).map(([k, v]) => `${k}="${esc(v)}"`);
      return parts.length ? `{${parts.join(",")}}` : "";
    };
    const lines: string[] = [];
    for (const [name, f] of [...this.families].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const full = `${prefix}${name}`;
      lines.push(`# HELP ${full} ${(f.help || name).replace(/\n/g, " ")}`);
      lines.push(`# TYPE ${full} ${f.kind}`);
      for (const s of f.series.values()) {
        if (f.kind !== "histogram") {
          lines.push(`${full}${fmt(s.labels)} ${s.value}`);
          continue;
        }
        f.bounds!.forEach((b, i) =>
          lines.push(
            `${full}_bucket${fmt(s.labels, { le: String(b) })} ${s.buckets![i]}`,
          ),
        );
        lines.push(`${full}_bucket${fmt(s.labels, { le: "+Inf" })} ${s.count}`);
        lines.push(`${full}_sum${fmt(s.labels)} ${s.sum}`);
        lines.push(`${full}_count${fmt(s.labels)} ${s.count}`);
      }
    }
    lines.push(
      `# HELP ${prefix}metrics_series_dropped_total Series refused by the cardinality cap.`,
    );
    lines.push(`# TYPE ${prefix}metrics_series_dropped_total counter`);
    for (const [name, n] of this.dropped)
      lines.push(
        `${prefix}metrics_series_dropped_total{metric="${esc(name)}"} ${n}`,
      );
    return `${lines.join("\n")}\n`;
  }
  snapshot() {
    const counters: Record<string, number> = {};
    const histograms: Record<
      string,
      { count: number; p50: number; p95: number }
    > = {};
    for (const [name, f] of this.families)
      for (const s of f.series.values()) {
        const key = `${name}{${Object.entries(s.labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(",")}}`;
        if (f.kind === "histogram") {
          const sorted = [...s.samples!].sort((a, b) => a - b);
          histograms[key] = {
            count: s.count!,
            p50: sorted[Math.floor((sorted.length - 1) * 0.5)] ?? 0,
            p95: sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0,
          };
        } else counters[key] = s.value;
      }
    return { counters, histograms };
  }
}
const GLOBAL = Symbol.for("otherbridge.metrics.registry.v15");
export function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (g[GLOBAL] ??= new Registry());
}
export function newRegistry(cap?: number) {
  return new Registry(cap);
}
export type MetricsRegistry = Registry;
// Status class keeps HTTP status labels bounded even if an unexpected status appears.
export const statusClass = (status: number) =>
  status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : "other";
