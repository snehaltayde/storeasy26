// Minimal mail transport (Session 26) — enough for invitations and password
// resets. Full notification service (durable intents, bounces, consent) is
// BE23 (W3). Provider: Resend when RESEND_API_KEY is set; otherwise a clearly
// labeled console MOCK (nothing is sent — the caller's result says so).
export const mailConfigured = () => Boolean(process.env.RESEND_API_KEY);

export async function sendMail({ to, subject, text }) {
  const from = process.env.MAIL_FROM || "Storeasy <onboarding@resend.dev>";
  if (!mailConfigured()) {
    console.log(`[mail:MOCK — not sent] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
    return { ok: true, mock: true };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, text }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body?.message || `HTTP ${res.status}` };
    return { ok: true, id: body?.id };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
