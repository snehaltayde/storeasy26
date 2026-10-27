// Operational alerts (SERVER-ONLY). Always logs loudly; additionally delivers
// to ALERT_WEBHOOK_URL when set (payload carries a Slack-compatible `text`, so
// a Slack/Discord/generic JSON webhook all work). Alert failures are swallowed —
// an alert must never take down the flow it is alerting about.
// Session 24: alerts are tenant-tagged — the subject carries [tenant] and the
// payload a `tenant` field, so one webhook serves the whole platform.
import { tenantId } from "./tenant-context.js";

// S29 (BE19): severity levels + optional runbook pointer. Existing callers are
// unchanged (default = critical, the old behavior). `pnpm alert:test` is the
// delivery self-test.
const SEVERITY_EMOJI = { critical: "🚨", warn: "⚠️", info: "ℹ️" };

export async function sendAlert(subject, detail = {}, { severity = "critical", runbook = null } = {}) {
  const tenant = tenantId();
  const tagged = tenant === "_default" ? subject : `[${tenant}] ${subject}`;
  console.error(`[ALERT:${severity}] ${tagged} ${JSON.stringify(detail)}`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return { delivered: false, reason: "ALERT_WEBHOOK_URL not set" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `${SEVERITY_EMOJI[severity] || "🚨"} storeasy: ${tagged}`,
        subject,
        tenant,
        severity,
        ...(runbook ? { runbook } : {}),
        detail,
        at: new Date().toISOString(),
      }),
    });
    return { delivered: res.ok, status: res.status };
  } catch (e) {
    console.error(`[alerts] delivery failed: ${e?.message || e}`);
    return { delivered: false, reason: String(e?.message || e) };
  }
}
