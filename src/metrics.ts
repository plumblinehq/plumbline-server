/**
 * A deliberately minimal Prometheus text-format exporter (format version
 * 0.0.4). The server's whole metrics surface is a handful of counters and
 * gauges; a client library for that is weight it does not need, and this
 * keeps the dependency list at exactly what the README claims. Metric names,
 * help strings and label values are fixed at the call site so a typo cannot
 * silently rename a series — the /metrics endpoint is only as good as its
 * stability.
 */

export class Counter {
  #help: string;
  #values = new Map<string, number>();

  constructor(help: string) {
    this.#help = help;
  }

  inc(labels: Record<string, string> = {}, by = 1): void {
    const key = renderLabels(labels);
    this.#values.set(key, (this.#values.get(key) ?? 0) + by);
  }

  reset(): void {
    this.#values.clear();
  }

  render(name: string): string {
    const lines = [`# HELP ${name} ${this.#help}`, `# TYPE ${name} counter`];
    if (this.#values.size === 0) {
      return lines.join("\n");
    }
    for (const [labels, value] of sortedEntries(this.#values)) {
      lines.push(`${name}${labels} ${value}`);
    }
    return lines.join("\n");
  }
}

export class Gauge {
  #help: string;
  #value: number | undefined;

  constructor(help: string) {
    this.#help = help;
  }

  set(value: number): void {
    this.#value = value;
  }

  reset(): void {
    this.#value = undefined;
  }

  render(name: string): string {
    const lines = [`# HELP ${name} ${this.#help}`, `# TYPE ${name} gauge`];
    if (this.#value !== undefined) {
      lines.push(`${name} ${this.#value}`);
    }
    return lines.join("\n");
  }
}

/**
 * The process-wide registry the server scrapes. The scanner feeds scan
 * outcomes in; the HTTP layer feeds request counts in; the /metrics route
 * combines those with live counts from the store.
 */
export class Registry {
  readonly scans = new Counter("Scan passes completed, by status.");
  readonly lastScan = new Gauge("Unix seconds of the last completed scan pass.");
  readonly httpRequests = new Counter("HTTP requests served, by route and status.");

  /** Test seam: tests reset the singleton between cases. */
  reset(): void {
    this.scans.reset();
    this.lastScan.reset();
    this.httpRequests.reset();
  }
}

export const metrics = new Registry();

/** Render every series in a stable order (name, then label key). */
export function renderMetrics(extra: string[] = []): string {
  const blocks = [
    metrics.scans.render("plumbline_scans_total"),
    metrics.lastScan.render("plumbline_last_scan_timestamp_seconds"),
    metrics.httpRequests.render("plumbline_http_requests_total"),
    ...extra,
  ];
  return blocks.filter((b) => b !== "").join("\n") + "\n";
}

/** Deterministic label rendering: `{a="1",b="2"}`, sorted by key. */
function renderLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return "";
  }
  const parts = keys.map((key) => `${key}="${escapeLabelValue(labels[key] ?? "")}"`);
  return `{${parts.join(",")}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function sortedEntries(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}