import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegressionNotifier, type RegressionNotification } from "../src/webhook.js";

const notification: RegressionNotification = {
  homeDomain: "anclap.com",
  network: "pubnet",
  runId: "7",
  checksLibVersion: "0.2.3",
  overallScore: 0.4,
  regressions: [
    {
      checkId: "sep10.challenge-sequence-zero",
      title: "the challenge sequence number is 0",
      message: "The challenge sequence number is 5, not 0.",
      specRef: "SEP-10 §Authentication flow",
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createRegressionNotifier", () => {
  it("is a no-op when no webhook URL is configured", () => {
    const spy = vi.fn();
    const notifier = createRegressionNotifier(undefined, { fetchImpl: spy });
    notifier(notification);
    expect(spy).not.toHaveBeenCalled();
  });

  it("POSTs the notification as JSON to the webhook URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const notifier = createRegressionNotifier("https://hooks.example.com/abc", { fetchImpl });
    notifier(notification);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/abc");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual(notification);
  });

  it("warns on a non-2xx response without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notifier = createRegressionNotifier("https://hooks.example.com/abc", { fetchImpl });
    notifier(notification);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0]?.[0]).toContain("500");
  });

  it("logs and swallows a network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const notifier = createRegressionNotifier("https://hooks.example.com/abc", { fetchImpl });
    notifier(notification);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(error.mock.calls[0]?.[0]).toContain("ECONNREFUSED");
    // The call must not have thrown synchronously.
    expect(true).toBe(true);
  });
});