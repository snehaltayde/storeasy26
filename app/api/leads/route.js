import { NextResponse } from "next/server";
import { isPlatformSiteHost } from "@/lib/platform-site";
import { platformDb, platformConfigured } from "@/lib/platform/control";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { closedStoreGate, STORE_CLOSED_CODE, STORE_CLOSED_MESSAGE } from "@/lib/content/resolve";

// Marketing lead capture (S44 / MK08). Marketing-host only, rate-limited,
// honeypot-guarded, CONSENT-AWARE: submitting the form is consent to be
// contacted about the inquiry (that's its purpose); marketing updates are a
// SEPARATE explicit opt-in stored with the lead. Leads land durably in the
// control plane; a copy goes to the platform inbox when mail is configured
// (honestly mocked otherwise).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ error: "Not found" }, { status: 404 });

// PUB-06: a store host never takes leads (marketing hosts only, as before).
// A closed store says so in its own words; every other store host, and any
// host that doesn't resolve to a store, gets the same 404 as before.
const storeHostAnswer = tenantHandler(async () => {
  const closed = await closedStoreGate();
  return closed && !closed.preview ? NextResponse.json({ error: STORE_CLOSED_MESSAGE, code: STORE_CLOSED_CODE }, { status: 403 }) : NOT_FOUND();
});

const ldId = () => "ld_" + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");

export async function POST(request) {
  // The rate limit comes first, so a store host reads its release pointer and
  // cms_state (the closed-store gate) only within the same budget.
  const limited = rateLimit(request, { name: "leads", limit: 5, windowMs: 60 * 60 * 1000 });
  if (limited) return limited;
  if (!isPlatformSiteHost(request.headers.get("host"))) {
    // Only the closed store's 403 is passed on. An unknown or suspended host
    // (tenantHandler's 404 TENANT_UNKNOWN / 503 TENANT_SUSPENDED) and every
    // open store host get today's plain 404.
    const res = await storeHostAnswer(request).catch(() => null);
    return res?.status === 403 ? res : NOT_FOUND();
  }
  if (!platformConfigured()) return NextResponse.json({ error: "temporarily unavailable" }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  if (String(body.website || "").trim()) return NextResponse.json({ ok: true, received: true }); // honeypot

  const name = String(body.name || "").trim().slice(0, 120);
  const email = String(body.email || "").trim().slice(0, 200);
  const storeUrl = String(body.storeUrl || "").trim().slice(0, 300);
  const message = String(body.message || "").trim().slice(0, 4000);
  const errors = [];
  if (!name) errors.push("Please tell us your name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push("That email doesn't look right.");
  if (errors.length) return NextResponse.json({ error: errors.join(" "), errors }, { status: 422 });

  const id = ldId();
  await platformDb().execute({
    sql: "INSERT INTO leads (id, name, email, store_url, message, marketing_consent, source, created_at) VALUES (?,?,?,?,?,?,?,?)",
    args: [id, name, email, storeUrl || null, message || null, body.marketingConsent === true ? 1 : 0, String(body.source || "/contact").slice(0, 100), new Date().toISOString()],
  });
  slog("lead_captured", { id, marketing: body.marketingConsent === true });

  // best-effort copy to the platform inbox — never blocks the lead
  const to = process.env.PLATFORM_SUPPORT_EMAIL || "";
  if (to) {
    const { sendMail } = await import("@/lib/mail.js");
    await sendMail({ to, subject: `[Storeasy] New lead: ${name}`, text: `${name} <${email}>${storeUrl ? `\nStore: ${storeUrl}` : ""}\n\n${message || "(no message)"}\n\nMarketing opt-in: ${body.marketingConsent === true ? "YES" : "no"}` }).catch(() => {});
  }
  return NextResponse.json({ ok: true, received: true });
}
