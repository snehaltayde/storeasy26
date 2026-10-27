import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { currentTenant } from "@/lib/tenant-context";
import { patchTenant } from "@/lib/platform/control.js";
import { validateBrand, resolveBrand, accentShades, DEFAULT_BRAND } from "@/lib/brand";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Brand tokens console API (S35 / MC10).
//   GET                      → effective brand + customized flag + derived shades
//   PUT {brand}              → validate (contrast gate) + store config.brand
//   PUT {preview: brand}     → validation/shades only, nothing stored
//   PUT {reset: true}        → back to the platform default look
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const view = (tenantBrand) => {
  const brand = resolveBrand(tenantBrand);
  return { brand, customized: !!tenantBrand, shades: accentShades(brand.accent), default: DEFAULT_BRAND };
};

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ ok: true, ...view(currentTenant()?.config?.brand || null) });
});

export const PUT = tenantHandler(async (request) => {
  const body = await request.json().catch(() => ({}));
  const auth = await requireAdmin(request, body.preview ? "storefront.read" : "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (body.preview) {
    const r = validateBrand(body.preview);
    return NextResponse.json({ ok: r.ok, errors: r.errors, warnings: r.warnings, value: r.value, shades: r.ok ? accentShades(r.value.accent) : null });
  }

  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default")
    return NextResponse.json({ error: "This store runs on environment config — brand is read-only here" }, { status: 409 });

  if (body.reset) {
    await patchTenant(tenant.id, { config: { brand: null } });
    slog("brand_reset", {});
    await audit({ actor: auth.actor, action: "storefront.write", resource: "brand", diff: { reset: true } });
    return NextResponse.json({ ok: true, ...view(null) });
  }

  const r = validateBrand(body.brand);
  if (!r.ok) return NextResponse.json({ error: "Validation failed", errors: r.errors, warnings: r.warnings }, { status: 422 });
  await patchTenant(tenant.id, { config: { brand: r.value } });
  slog("brand_saved", { accent: r.value.accent });
  await audit({ actor: auth.actor, action: "storefront.write", resource: "brand", diff: r.value });
  return NextResponse.json({ ok: true, warnings: r.warnings, ...view(r.value) });
});
