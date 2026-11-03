import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { KITS, applyKit, kitUpgradeAvailable } from "@/lib/themes/kits";
import { tenantOwnCfg } from "@/lib/tenant-context";
import { tenantHandler } from "@/lib/tenant-request";
import { legacyWritesRefusal } from "@/lib/cms-mode";

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
  if (body.action !== "apply") return NextResponse.json({ error: "action must be apply" }, { status: 400 });
  // P2-GUARD: applyKit writes the theme pin, brand and hero preset as legacy
  // drafts; a store on the new editor refuses it (409 STORE_USES_DOCUMENTS)
  const refused = await legacyWritesRefusal({ route: "admin/theme" });
  if (refused) return NextResponse.json(refused.body, { status: refused.status });
  try {
    const r = await applyKit(String(body.kit || ""), { actor: auth.actor, withPresets: body.withPresets !== false, withBrand: body.withBrand !== false });
    // this request's tenant context predates the patch — answer with the pin we just wrote
    // r.note: the theme and brand were applied but the hero preset was not
    // (someone else edited the hero just now); said plainly, never "nothing
    // was saved" (P2-FIX4)
    return NextResponse.json({ ok: true, applied: r, ...(r.note ? { note: r.note } : {}), ...view(), theme: r.theme, upgradeAvailable: false });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/theme" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
