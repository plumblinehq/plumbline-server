import { beforeEach, describe, expect, it } from "vitest";
import { Counter, Gauge, metrics, renderMetrics } from "../src/metrics.js";

describe("Counter", () => {
  it("renders a HELP and TYPE header", () => {
    const counter = new Counter("Things counted.");
    expect(counter.render("plumbline_things_total")).toBe(
      "# HELP plumbline_things_total Things counted.\n# TYPE plumbline_things_total counter",
    );
  });

  it("counts with sorted, escaped labels", () => {
    const counter = new Counter("Things counted.");
    counter.inc({ b: "2" });
    counter.inc({ a: 'quote"slash\\', b: "2" });
    expect(counter.render("plumbline_things_total")).toContain(
      'plumbline_things_total{a="quote\\"slash\\\\",b="2"} 1',
    );
    expect(counter.render("plumbline_things_total")).toContain('plumbline_things_total{b="2"} 1');
  });

  it("renders unlabelled series without braces", () => {
    const counter = new Counter("Things counted.");
    counter.inc();
    counter.inc();
    expect(counter.render("plumbline_things_total")).toContain("plumbline_things_total 2");
  });
});

describe("Gauge", () => {
  it("omits the value until set", () => {
    const gauge = new Gauge("A value.");
    expect(gauge.render("plumbline_value")).toBe("# HELP plumbline_value A value.\n# TYPE plumbline_value gauge");
  });

  it("renders the last set value", () => {
    const gauge = new Gauge("A value.");
    gauge.set(1.5);
    expect(gauge.render("plumbline_value")).toContain("plumbline_value 1.5");
  });
});

describe("the process-wide registry", () => {
  beforeEach(() => {
    // The registry is a singleton; reset it so tests do not observe each
    // other's counts.
    metrics.reset();
  });

  it("renders every series in a stable order", () => {
    metrics.scans.inc({ status: "complete" });
    metrics.scans.inc({ status: "aborted" });
    metrics.lastScan.set(1_700_000_000);
    metrics.httpRequests.inc({ route: "healthz", status: "200" });

    const text = renderMetrics(['plumbline_anchors_total{network="pubnet"} 4']);
    expect(text).toContain("# TYPE plumbline_scans_total counter");
    expect(text).toContain('plumbline_scans_total{status="aborted"} 1');
    expect(text).toContain('plumbline_scans_total{status="complete"} 1');
    expect(text).toContain("plumbline_last_scan_timestamp_seconds 1700000000");
    expect(text).toContain('plumbline_http_requests_total{route="healthz",status="200"} 1');
    expect(text).toContain('plumbline_anchors_total{network="pubnet"} 4');
    // Scan series sorts before the last-scan gauge before http requests.
    const order = [
      text.indexOf("# TYPE plumbline_scans_total"),
      text.indexOf("# TYPE plumbline_last_scan_timestamp_seconds"),
      text.indexOf("# TYPE plumbline_http_requests_total"),
      text.indexOf("plumbline_anchors_total"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});