import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { tenantHandler } from "@/lib/tenant-request";
import { currentTenant } from "@/lib/tenant-context";
import { rotateWebhookKey, webhookKeyState } from "@/lib/couriers/tracking";

// Phase 9 line 4: the Shiprocket webhook key. [id] is the install id (pin_…).
//   GET  apps.read   → { set, rotatedAt, address, addressWarning }
//                      (never the key or its hash)
//   POST apps.manage { rotate: true } → { key, rotatedAt }: the key once; the
//                      previous key keeps working for 24 hours
// Audit: apps.shiprocket_token_rotate.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });
const NO_STORE = { headers: { "cache-control": "no-store" } };
const WEBHOOK_PATH = "/api/parcel-updates";
// Shiprocket refuses a webhook address containing these words
const BANNED = /shiprocket|kartrocket|sr|kr/i;

function address() {
  const host = currentTenant()?.domains?.[0] ?? null;
  return host ? `https://${host}${WEBHOOK_PATH}` : WEBHOOK_PATH;
}

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "apps.read");
  if (!auth.ok) return deny(auth);
  const state = await webhookKeyState();
  const a = address();
  return NextResponse.json({ ok: true, ...state, address: a, addressWarning: BANNED.test(a) }, NO_STORE);
});

export const POST = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "apps.manage");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (body?.rotate !== true) return NextResponse.json({ error: "Choose one thing to change.", code: "BAD_REQUEST" }, { status: 400 });
  try {
    const r = await rotateWebhookKey(String(id || ""), { actor: auth.actor });
    if (!r) return NextResponse.json({ error: "Shiprocket isn't installed on your store.", code: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ ok: true, ...r }, NO_STORE);
  } catch (e) {
    if (e?.code === "CHANGED") return NextResponse.json({ error: "The app's settings were changed somewhere else. Nothing was saved. Try again.", code: "CHANGED" }, { status: 409 });
    if (e?.code === "SECRETS_UNAVAILABLE") return NextResponse.json({ error: "Private settings can't be saved on this store right now. Try again later.", code: "SECRETS_UNAVAILABLE" }, { status: 503 });
    throw e;
  }
});
