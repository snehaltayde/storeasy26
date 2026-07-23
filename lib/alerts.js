// Operational alerts (SERVER-ONLY). Always logs loudly; additionally delivers
// to ALERT_WEBHOOK_URL when set (payload carries a Slack-compatible `text`, so
// a Slack/Discord/generic JSON webhook all work). Alert failures are swallowed —
// an alert must never take down the flow it is alerting about.
export async function sendAlert(subject, detail = {}) {
  console.error(`[ALERT] ${subject} ${JSON.stringify(detail)}`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return { delivered: false, reason: "ALERT_WEBHOOK_URL not set" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `🚨 storeasy26: ${subject}`,
        subject,
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
