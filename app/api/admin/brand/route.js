import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { currentTenant } from "@/lib/tenant-context";
import { patchTenant } from "@/lib/platform/control.js";
import { validateBrand, resolveBrand, accentShades, DEFAULT_BRAND } from "@/lib/brand";
import { brandReadability as readability } from "@/lib/admin/brand-readability";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { legacyWritesRefusal, getCmsMode, DOCUMENTS_MESSAGE } from "@/lib/cms-mode";
import { editorHref } from "@/lib/admin/editor-entry";

// Brand tokens console API (S35 / MC10, TOK-02).
//   GET                      → effective brand + customized flag + derived shades
//   PUT {brand}              → store config.brand (a draft). Only a malformed
//                              value is refused (422). Readability never blocks
//                              a save: the answer carries `warnings` (plain
//                              words, each naming the colour pair and the
//                              nearest colour that fixes it) and `notes` (where
//                              the store uses a readable shade of the accent).
//                              Publishing refuses a changed pair that fails.
//   PUT {preview: brand}     → the same check, nothing stored
//   PUT {reset: true}        → back to the platform default look
//
// P3-DESIGN (TOK-03), a documents store: the brand is the design document's
// (doc_design), edited and published in the editor. GET answers the DRAFT
// design's brand (what the editor shows) with documents: true and the
// editor's address; PUT {preview} still checks a brand against the live
// design and stores nothing; save and reset keep refusing (409
// STORE_USES_DOCUMENTS) in words that send the founder to the editor, with
// `editor` (/admin/editor?doc=doc_design) to link to.
// This file is on the TOK-03 guard's allowlist: only its legacy branch reads
// config.brand.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const view = (tenantBrand) => {
  const brand = resolveBrand(tenantBrand);
  return { brand, customized: !!tenantBrand, shades: accentShades(brand.accent), default: DEFAULT_BRAND };
};

const DESIGN_EDITOR = editorHref("doc_design");
const BRAND_IN_EDITOR = `${DOCUMENTS_MESSAGE}, so nothing was saved here. Change your brand in the editor: open Brand there, then publish.`;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// a design never saved reads as the platform default
const notFound = (err) => err?.status === 404 || err?.name === "NotFoundError";

async function draftDesignBrand() {
  const Docs = await import("@/lib/documents/service");
  const d = await Docs.getDocument("doc_design").catch((err) => (notFound(err) ? null : Promise.reject(err)));
  return d && isObj(d.body?.settings?.brand) ? d.body.settings.brand : null;
}

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  // a read: when the mode can't be read, the legacy view, as before TOK-03
  const mode = await getCmsMode().catch(() => "legacy");
  if (mode === "documents") return NextResponse.json({ ok: true, ...view(await draftDesignBrand()), documents: true, editor: DESIGN_EDITOR });
  return NextResponse.json({ ok: true, ...view(currentTenant()?.config?.brand || null) });
});

export const PUT = tenantHandler(async (request) => {
  const body = await request.json().catch(() => ({}));
  const auth = await requireAdmin(request, body.preview ? "storefront.read" : "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (body.preview) {
    const r = validateBrand(body.preview);
    if (!r.ok) return NextResponse.json({ ok: false, errors: r.errors, warnings: [], value: r.value, shades: null });
    return NextResponse.json({ ok: true, errors: [], value: r.value, shades: accentShades(r.value.accent), ...(await readability(r.value)) });
  }

  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default")
    return NextResponse.json({ error: "This store runs on environment config — brand is read-only here" }, { status: 409 });

  // P2-GUARD: save and reset write config.brand, which a store on the new
  // editor keeps in its design document (TOK-03): refused with a 409. The
  // preview above stores nothing and stays open.
  const refused = await legacyWritesRefusal({ route: "admin/brand" });
  if (refused) {
    // TOK-03: a documents store changes its brand in the editor; say where
    const documents = refused.status === 409 && refused.body?.code === "STORE_USES_DOCUMENTS" && (await getCmsMode().catch(() => null)) === "documents";
    const body = documents ? { ...refused.body, error: BRAND_IN_EDITOR, editor: DESIGN_EDITOR } : refused.body;
    return NextResponse.json(body, { status: refused.status });
  }

  if (body.reset) {
    await patchTenant(tenant.id, { config: { brand: null } });
    slog("brand_reset", {});
    await audit({ actor: auth.actor, action: "storefront.write", resource: "brand", diff: { reset: true } });
    return NextResponse.json({ ok: true, ...(await readability(null)), ...view(null) });
  }

  const r = validateBrand(body.brand);
  if (!r.ok) return NextResponse.json({ error: "Validation failed", errors: r.errors, warnings: r.warnings }, { status: 422 });
  await patchTenant(tenant.id, { config: { brand: r.value } });
  slog("brand_saved", { accent: r.value.accent });
  await audit({ actor: auth.actor, action: "storefront.write", resource: "brand", diff: r.value });
  return NextResponse.json({ ok: true, ...(await readability(r.value)), ...view(r.value) });
});
