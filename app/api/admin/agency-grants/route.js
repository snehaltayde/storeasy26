import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getUser } from "@/lib/platform/identity";
import { acceptGrant, revokeGrant, grantsForTenant } from "@/lib/platform/agency";
import { audit } from "@/lib/platform/audit";
import { tenantId } from "@/lib/tenant-context";
import { tenantHandler } from "@/lib/tenant-request";

// Client side of agency access (S48 / AG02). ACCEPTANCE IS THE CLIENT'S ACT:
// it happens here, in the client's own console, by a signed-in team manager
// whose email matches the invitation — a wrong recipient or expired code
// creates nothing. The client can revoke at any time; revocation is
// immediate (every agency call re-reads the grant).
//   GET               → this store's grants (agency name, role, status)
//   POST {accept:{token}}
//   POST {revoke:{id}}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ ok: true, grants: await grantsForTenant(tenantId()) });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "team.manage");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  try {
    if (body.accept) {
      if (auth.actor.kind !== "merchant") {
        return NextResponse.json(
          { error: "Agency invitations bind to a person: sign in with your individual account (not the shared bootstrap password) to accept." },
          { status: 403 }
        );
      }
      const user = await getUser(auth.actor.id);
      const grant = await acceptGrant(String(body.accept.token || "").trim(), { tenantId: tenantId(), actorEmail: user?.email || "" });
      if (!grant) return NextResponse.json({ error: "That invitation is expired, already used, or wasn't addressed to your email — nothing was granted." }, { status: 422 });
      return NextResponse.json({ ok: true, grant: { id: grant.id, agency_id: grant.agency_id, role: grant.role } });
    }
    if (body.revoke) {
      const g = (await grantsForTenant(tenantId())).find((x) => x.id === String(body.revoke.id || ""));
      if (!g) return NextResponse.json({ error: "grant not found" }, { status: 404 });
      const r = await revokeGrant(g.id, `merchant:${auth.actor.id}`);
      await audit({ actor: auth.actor, action: "team.manage", resource: `agency_grant:${g.id}`, diff: { revoked: true } });
      return NextResponse.json({ ok: true, ...r });
    }
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
