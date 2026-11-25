import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { listAudit, auditFacets, auditChanges } from "@/lib/platform/audit";
import { currentTenant, tenantId } from "@/lib/tenant-context";
import { platformConfigured, platformDb } from "@/lib/platform/control";
import { tenantHandler } from "@/lib/tenant-request";
import { operatorNames } from "@/lib/platform/support";

// Tenant audit trail, read-only (S27 / BE16). Scoped to the HOST-RESOLVED
// tenant — a console can never read another store's rows. Owner/admin only
// (action audit.read). The UI is Settings → Audit log (Phase 2 line 7):
//   ?limit, ?before (the previous page's `next`), and the filters ?actor
//   (an actor id), ?action, ?since / ?until (ISO times); ?facets=1 adds the
//   filter choices. Each entry carries `changes` (its diff as short lines,
//   redacted again on the way out) and never the raw diff.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/;

// Who, in words: a member by their email (this store's audit.read callers see
// the team anyway), Storeasy's team for operators, Storeasy for the system.
// One read for every member on the page and in the filter choices.
async function whoLabels(list) {
  const members = [...new Set(list.filter((a) => a.kind === "merchant").map((a) => a.actor))];
  const emails = new Map();
  for (let i = 0; i < members.length; i += 200) {
    const ids = members.slice(i, i + 200);
    const res = await platformDb()
      .execute({ sql: `SELECT id, email FROM users WHERE id IN (${ids.map(() => "?").join(", ")})`, args: ids })
      .catch(() => ({ rows: [] }));
    for (const r of res.rows) emails.set(r.id, r.email);
  }
  const out = new Map();
  for (const { actor, kind } of list) {
    out.set(actor, kind === "merchant" ? emails.get(actor) || "A former team member" : kind === "operator" ? "Storeasy's team" : kind === "bootstrap" ? "Setup sign-in" : "Storeasy");
  }
  return out;
}

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "audit.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!(platformConfigured() && currentTenant())) {
    return NextResponse.json({ ok: true, entries: [], note: "audit log needs the platform control plane" });
  }
  const p = request.nextUrl.searchParams;
  const time = (k) => (ISO.test(p.get(k) || "") ? p.get(k) : null);
  const limit = Math.min(Math.max(Number(p.get("limit")) || 50, 1), 200);
  const rows = await listAudit({
    tenantId: tenantId(),
    limit,
    before: p.get("before"),
    actor: p.get("actor") || null,
    action: p.get("action") || null,
    since: time("since"),
    until: time("until"),
  });
  const facets = p.get("facets") === "1" ? await auditFacets({ tenantId: tenantId() }) : null;
  const labels = await whoLabels([...rows.map((r) => ({ actor: r.actor, kind: r.actor_kind })), ...(facets?.actors || []).map((a) => ({ actor: a.actor, kind: a.kind }))]);
  // Phase 3 line 5: a support-access row by an operator names that operator
  // (the store's team sees who had access), never their id or email
  const supportRow = (r) => r.actor_kind === "operator" && String(r.action).startsWith("support.");
  const opNames = await operatorNames(rows.filter(supportRow).map((r) => r.actor)).catch(() => new Map());
  // the raw diff never leaves the server: only its redacted lines
  const entries = rows.map(({ diff, ...r }) => ({ ...r, who: (supportRow(r) && opNames.get(String(r.actor))) || labels.get(r.actor), changes: auditChanges(diff) }));
  const last = entries.at(-1);
  return NextResponse.json({
    ok: true,
    entries,
    next: entries.length === limit && last ? `${last.at}|${last.id}` : null,
    ...(facets ? { facets: { actions: facets.actions, actors: facets.actors.map((a) => ({ ...a, label: labels.get(a.actor) })) } } : {}),
  });
});
