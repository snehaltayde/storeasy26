import { NextResponse } from "next/server";
import { operatorError } from "@/lib/platform/operator-error";
import { requireOperator } from "@/lib/platform/require-operator";
import { offboardTenant } from "@/lib/platform/export";
import { getTenant } from "@/lib/platform/control";

// Offboard a tenant (S43 / BE29): suspend → revoke keys → cancel local
// billing → purge platform-side derived rows. The tenant DATABASE and
// control-plane row are KEPT (export stays possible; deletion is a separate
// manual act). Requires {confirm: "<tenant id>"} typed back — this is the
// console's second-step confirmation, server-enforced.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  if (body.confirm !== id) {
    return NextResponse.json({ error: `type the tenant id ("${id}") as confirm to offboard` }, { status: 400 });
  }
  try {
    const r = await offboardTenant(id, { actor: auth.operator });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    // P3-G: a driver error can name the store's database
    return operatorError(e, { tenant, words: "Offboarding stopped part way. Check the store's state, then try again.", event: "tenant_offboard_failed" });
  }
}
