import { consoleLogger, type Logger } from "@plumblinehq/plumbline-checks";

/**
 * Regression alerting, per plumbline-architecture.md §6.3: an error-severity
 * check that moved pass → fail is pushed to a configured webhook (Discord,
 * Slack or any generic endpoint). Emission is deliberately fire-and-forget —
 * a webhook that is down must never abort or delay a scan — and the notifier
 * swallows and logs its own failures. With no URL configured it is a no-op,
 * which is the documented default: alerting is opt-in.
 */
export interface RegressionNotification {
  homeDomain: string;
  network: string;
  runId: string;
  checksLibVersion: string;
  overallScore: number;
  regressions: Array<{ checkId: string; title: string; message: string; specRef: string }>;
}

export type RegressionNotifier = (notification: RegressionNotification) => void;

export function createRegressionNotifier(
  webhookUrl: string | undefined,
  options: { fetchImpl?: typeof fetch; logger?: Logger } = {},
): RegressionNotifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? consoleLogger;
  if (webhookUrl === undefined) {
    return () => undefined;
  }
  return (notification) => {
    void (async () => {
      try {
        const response = await fetchImpl(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(notification),
        });
        if (!response.ok) {
          logger.warn(`regression webhook returned ${response.status} for ${notification.homeDomain}`);
        }
      } catch (error) {
        logger.error(
          `regression webhook failed for ${notification.homeDomain}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  };
}