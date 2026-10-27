// Operational alerts (SERVER-ONLY). Always logs loudly; additionally delivers
// to ALERT_WEBHOOK_URL when set (payload carries a Slack-compatible `text`, so
// a Slack/Discord/generic JSON webhook all work). Alert failures are swallowed —
// an alert must never take down the flow it is alerting about.
// Session 24: alerts are tenant-tagged — the subject carries [tenant] and the
// payload a `tenant` field, so one webhook serves the whole platform.
import { tenantId } from "./tenant-context.js";

export async function sendAlert(subject, detail = {}) {
  const tenant = tenantId();
  const tagged = tenant === "_default" ? subject : `[${tenant}] ${subject}`;
  console.error(`[ALERT] ${tagged} ${JSON.stringify(detail)}`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return { delivered: false, reason: "ALERT_WEBHOOK_URL not set" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `🚨 storeasy: ${tagged}`,
        subject,
        tenant,
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
