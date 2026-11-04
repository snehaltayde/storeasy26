import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { KITS, applyKit, kitUpgradeAvailable, DESIGN_ID } from "@/lib/themes/kits";
import { tenantOwnCfg } from "@/lib/tenant-context";
import { tenantHandler } from "@/lib/tenant-request";
import { getCmsMode, legacyWritesRefusal } from "@/lib/cms-mode";
import { writeRefusalBody } from "@/lib/content-writes";
import { validationBody } from "@/lib/cms/issues";
import { editorHref } from "@/lib/admin/editor-entry";

// Theme library API (S37 / MC07).
//   GET → kit catalog + the tenant's pin (+ upgrade availability)
//   POST {action:"apply", kit, withPresets?, withBrand?} → pin kit + seed brand
//        defaults (+hero preset) as DRAFTS — live changes only at the next publish.
//
// P3-DESIGN (TOK-03), a documents store: the pin and brand are the design
// document's (doc_design) draft. GET answers the draft's look and its
// revision (design: { id, revision, draftHash, editor }); POST {…, revision?}
// saves the kit into the doc_design DRAFT through the documents service
// (lib/themes/kits.js applyKit), never publishes, and never writes the
// control-plane config. A design save that landed since `revision` is a 409
// DOCUMENT_CHANGED with the current document. A 'migrating' store refuses
// (409 STORE_USES_DOCUMENTS). The legacy path is unchanged.
//
// This file is on the TOK-03 guard's allowlist: the legacy branch reads the
// control-plane theme pin (tenantOwnCfg "theme").
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const catalog = () => Object.values(KITS).map(({ id, version, label, vertical, description, fonts, brand, swatch }) => ({ id, version, label, vertical, description, fonts, brand, swatch }));

const legacyView = () => {
  const theme = tenantOwnCfg("theme", null, null) || null;
  return { kits: catalog(), theme, upgradeAvailable: kitUpgradeAvailable(theme) };
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// a design never saved reads as the platform default (no look of its own)
const notFound = (err) => err?.status === 404 || err?.name === "NotFoundError";

async function documentsView(Docs) {
  const d = await Docs.getDocument(DESIGN_ID).catch((err) => (notFound(err) ? null : Promise.reject(err)));
  const theme = d && isObj(d.body?.settings?.theme) ? d.body.settings.theme : null;
  return {
    kits: catalog(),
    theme,
    upgradeAvailable: kitUpgradeAvailable(theme),
    design: { id: DESIGN_ID, revision: d?.revision ?? null, draftHash: d?.draftHash ?? null, editor: editorHref(DESIGN_ID) },
  };
}

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  // a read: when the mode can't be read, the legacy view, as before TOK-03
  const mode = await getCmsMode().catch(() => "legacy");
  if (mode !== "documents") return NextResponse.json({ ok: true, ...legacyView() });
  try {
    const Docs = await import("@/lib/documents/service");
    return NextResponse.json({ ok: true, ...(await documentsView(Docs)) });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/theme" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: "We couldn't read your look just now. Reload the page and try again." }, { status: 500 });
  }
});

export const POST = tenantHandler(async (request) => {
  const body = await request.json().catch(() => ({}));
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (body.action !== "apply") return NextResponse.json({ error: "action must be apply" }, { status: 400 });
  if (body.revision !== undefined && !Number.isInteger(body.revision)) return NextResponse.json({ error: "revision must be a whole number", code: "MALFORMED" }, { status: 400 });

  // a mode that can't be read is answered by legacyWritesRefusal below (5xx,
  // never a go-ahead)
  const mode = await getCmsMode().catch(() => null);
  if (mode === "documents") return applyDocuments(body, auth);

  // P2-GUARD: on legacy applyKit writes the theme pin, brand and hero preset
  // as legacy drafts; a store moving to the new editor refuses it (409
  // STORE_USES_DOCUMENTS)
  const refused = await legacyWritesRefusal({ route: "admin/theme" });
  if (refused) return NextResponse.json(refused.body, { status: refused.status });
  try {
    const r = await applyKit(String(body.kit || ""), { actor: auth.actor, withPresets: body.withPresets !== false, withBrand: body.withBrand !== false });
    // this request's tenant context predates the patch — answer with the pin we just wrote
    // r.note: the theme and brand were applied but the hero preset was not
    // (someone else edited the hero just now); said plainly, never "nothing
    // was saved" (P2-FIX4)
    return NextResponse.json({ ok: true, applied: r, ...(r.note ? { note: r.note } : {}), ...legacyView(), theme: r.theme, upgradeAvailable: false });
  } catch (e) {
    if (e?.code === "STORE_USES_DOCUMENTS") return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
    const infra = infraResponse(e, { route: "admin/theme" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});

async function applyDocuments(body, auth) {
  const kit = String(body.kit || "");
  if (!KITS[kit]) return NextResponse.json({ error: `There is no look called "${kit.slice(0, 40)}". Choose one from the list.`, code: "UNKNOWN_KIT" }, { status: 422 });
  try {
    const Docs = await import("@/lib/documents/service");
    const r = await applyKit(kit, { actor: auth.actor, withPresets: body.withPresets !== false, withBrand: body.withBrand !== false, documents: Docs, revision: body.revision });
    return NextResponse.json({ ok: true, applied: r, ...(r.note ? { note: r.note } : {}), ...(await documentsView(Docs)), theme: r.theme, upgradeAvailable: false });
  } catch (e) {
    // a broken design is 422 with every issue; a deliberate refusal (409
    // DOCUMENT_CHANGED or DOCUMENT_EXISTS with the current document, 428, the
    // cart lock) keeps its status, code and words
    if (e?.issues) return NextResponse.json(validationBody(e.issues), { status: 422 });
    if (e?.expose) return NextResponse.json(writeRefusalBody(e), { status: e.status >= 400 && e.status < 500 ? e.status : 409 });
    const infra = infraResponse(e, { route: "admin/theme" }); // DOC-04: a database failure (or a mode that can't be read) is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: "The look couldn't be applied, so nothing was saved. Try again in a minute." }, { status: 500 });
  }
}
