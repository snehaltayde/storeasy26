import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { platformDb, platformConfigured } from "@/lib/platform/control";
import { currentTenant } from "@/lib/tenant-context";
import { tenantHandler } from "@/lib/tenant-request";

// Store switcher (S41 / MC03): the OTHER stores this signed-in USER belongs
// to — VERIFIED memberships only (control-plane rows, server-side; never a
// client-supplied list). Bootstrap/legacy password sessions have no user
// identity, so they get only the current store. Each entry links to that
// store's own console on its own host (sessions are tenant-bound — the
// switcher navigates, it never shares cookies across stores).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const consoleUrl = (domain) => {
  if (!domain) return null;
  const proto = /localhost|127\.0\.0\.1/.test(domain) ? "http" : "https";
  return `${proto}://${domain}/admin`;
};

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const here = currentTenant();
  if (!platformConfigured() || auth.actor.kind !== "merchant") {
    return NextResponse.json({ ok: true, stores: [], current: here?.id || null });
  }
  const r = await platformDb().execute({
    sql: `SELECT m.tenant_id, m.role, t.name, t.domains, t.status
          FROM memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = ? ORDER BY t.name`,
    args: [auth.actor.id],
  });
  const stores = r.rows
    .filter((row) => row.status === "active")
    .map((row) => {
      let domains = [];
      try {
        domains = JSON.parse(row.domains || "[]");
      } catch { /* malformed row */ }
      return { id: row.tenant_id, name: row.name, role: row.role, url: consoleUrl(domains[0]), current: row.tenant_id === here?.id };
    })
    .filter((s) => s.url);
  return NextResponse.json({ ok: true, stores, current: here?.id || null });
});
