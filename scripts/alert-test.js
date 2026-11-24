// Alert-delivery self-test (S29 / BE19): sends a synthetic info-level alert to
// ALERT_WEBHOOK_URL and reports the actual delivery result.
//   pnpm alert:test
import { sendAlert } from "../lib/alerts.js";

const r = await sendAlert(
  "alert delivery self-test",
  { source: "pnpm alert:test" },
  { severity: "info", runbook: "docs/operations.md#alerts-alert_webhook_url--set-it-in-prod" },
);
if (r.delivered) {
  console.log(`✓ alert delivered (HTTP ${r.status})`);
  process.exit(0);
}
console.error(`✗ alert NOT delivered: ${r.reason || `HTTP ${r.status}`}`);
process.exit(1);
