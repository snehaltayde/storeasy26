import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { tenantHandler } from "@/lib/tenant-request";
import { consoleList, consoleDetail } from "@/lib/subscriptions/console";
import { merchantAction, SubscriptionError } from "@/lib/subscriptions/actions";

// Phase 9 line 2: the store's subscriptions.
//   GET ?status=active|paused|cancelled → { subscriptions }   (subscriptions.read;
//       support sees no customer details)
//   GET ?id=<sub_…>                     → { subscription } with its history
//   POST {action: "pause"|"cancel", id, reason}  (subscriptions.manage: staff and
//       up; support 403) — for a customer, the reason audited
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "subscriptions.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (id != null) {
    const subscription = await consoleDetail(id, { role: auth.actor.role });
    if (!subscription) return NextResponse.json({ error: "subscription not found" }, { status: 404 });
    return NextResponse.json({ ok: true, subscription });
  }
  return NextResponse.json({ ok: true, subscriptions: await consoleList({ status: url.searchParams.get("status"), role: auth.actor.role }) });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "subscriptions.manage");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  try {
    const sub = await merchantAction(String(body.action || ""), typeof body.id === "string" ? body.id : "", { reason: body.reason });
    await audit({ actor: auth.actor, action: `subscriptions.${body.action}`, resource: `subscription:${sub.id}`, diff: { status: sub.status, reason: String(body.reason).trim().slice(0, 200) } });
    return NextResponse.json({ ok: true, status: sub.status });
  } catch (e) {
    if (e instanceof SubscriptionError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    throw e;
  }
});
