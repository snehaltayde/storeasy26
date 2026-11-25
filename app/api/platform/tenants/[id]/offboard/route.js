import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { offboardTenant } from "@/lib/platform/export";

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
  const body = await request.json().catch(() => ({}));
  if (body.confirm !== id) {
    return NextResponse.json({ error: `type the tenant id ("${id}") as confirm to offboard` }, { status: 400 });
  }
  try {
    const r = await offboardTenant(id, { actor: auth.operator });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
}
