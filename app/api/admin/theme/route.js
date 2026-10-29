import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { KITS, applyKit, kitUpgradeAvailable } from "@/lib/themes/kits";
import { tenantOwnCfg } from "@/lib/tenant-context";
import { tenantHandler } from "@/lib/tenant-request";

// Theme library API (S37 / MC07).
//   GET → kit catalog + the tenant's pin (+ upgrade availability)
//   POST {action:"apply", kit, withPresets?} → pin kit + seed brand defaults
//        (+hero preset) as DRAFTS — live changes only at the next publish.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const view = () => {
  const theme = tenantOwnCfg("theme", null, null) || null;
  return {
    kits: Object.values(KITS).map(({ id, version, label, vertical, description, fonts, brand, swatch }) => ({ id, version, label, vertical, description, fonts, brand, swatch })),
    theme,
    upgradeAvailable: kitUpgradeAvailable(theme),
  };
};

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ ok: true, ...view() });
});

export const POST = tenantHandler(async (request) => {
  const body = await request.json().catch(() => ({}));
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    if (body.action !== "apply") return NextResponse.json({ error: "action must be apply" }, { status: 400 });
    const r = await applyKit(String(body.kit || ""), { actor: auth.actor, withPresets: body.withPresets !== false, withBrand: body.withBrand !== false });
    // this request's tenant context predates the patch — answer with the pin we just wrote
    return NextResponse.json({ ok: true, applied: r, ...view(), theme: r.theme, upgradeAvailable: false });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
