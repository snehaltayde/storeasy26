import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { KITS, applyKit, kitUpgradeAvailable, DESIGN_ID } from "@/lib/themes/kits";
import { tenantHandler } from "@/lib/tenant-request";
import { writeRefusalBody } from "@/lib/content-writes";
import { validationBody } from "@/lib/cms/issues";
import { editorHref } from "@/lib/admin/editor-entry";
import { slog } from "@/lib/log";

// Theme library API (Documents-only). Reads and saves doc_design drafts through
// the documents service; never mutates control-plane config directly.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const catalog = () =>
  Object.values(KITS).map(({ id, version, label, vertical, description, fonts, brand, swatch }) => ({
    id,
    version,
    label,
    vertical,
    description,
    fonts,
    brand,
    swatch,
  }));

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
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
  try {
    const Docs = await import("@/lib/documents/service");
    return NextResponse.json({ ok: true, ...(await documentsView(Docs)) });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/theme" });
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: "We couldn't read your look just now. Reload the page and try again." }, { status: 500 });
  }
});

const HERO_FAILED_NOTE =
  "Your new look was saved as a draft. The hero look wasn't added, because something went wrong on our side. Apply the look again in a minute to add it, or change the hero in the editor.";

function watchDesignSave(Docs, seen) {
  return {
    ...Docs,
    async saveDraft(args) {
      const r = await Docs.saveDraft(args);
      if (args?.id === DESIGN_ID) seen.design = r?.document ?? null;
      return r;
    },
    async createDocument(args) {
      const r = await Docs.createDocument(args);
      if (args?.type === "design") seen.design = r?.document ?? null;
      return r;
    },
  };
}

export const POST = tenantHandler(async (request) => {
  const body = await request.json().catch(() => ({}));
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (body.action !== "apply") return NextResponse.json({ error: "action must be apply" }, { status: 400 });
  if (body.revision !== undefined && !Number.isInteger(body.revision)) {
    return NextResponse.json({ error: "revision must be a whole number", code: "MALFORMED" }, { status: 400 });
  }

  const kit = String(body.kit || "");
  if (!KITS[kit]) {
    return NextResponse.json({ error: `There is no look called "${kit.slice(0, 40)}". Choose one from the list.`, code: "UNKNOWN_KIT" }, { status: 422 });
  }

  const seen = { design: null };
  try {
    const Docs = await import("@/lib/documents/service");
    const r = await applyKit(kit, {
      actor: auth.actor,
      withPresets: body.withPresets !== false,
      withBrand: body.withBrand !== false,
      documents: watchDesignSave(Docs, seen),
      revision: body.revision,
    }).catch((e) => (seen.design ? { heroFailed: e } : Promise.reject(e)));
    if (r.heroFailed) return designSavedAnswer(Docs, seen.design, r.heroFailed);
    return NextResponse.json({ ok: true, applied: r, ...(r.note ? { note: r.note } : {}), ...(await documentsView(Docs)), theme: r.theme, upgradeAvailable: false });
  } catch (e) {
    if (e?.issues) return NextResponse.json(validationBody(e.issues), { status: 422 });
    if (e?.expose) return NextResponse.json(writeRefusalBody(e), { status: e.status >= 400 && e.status < 500 ? e.status : 409 });
    const infra = infraResponse(e, { route: "admin/theme" });
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: "The look couldn't be applied, so nothing was saved. Try again in a minute." }, { status: 500 });
  }
});

async function designSavedAnswer(Docs, design, e) {
  slog("theme_hero_failed", { mode: "documents", revision: design.revision ?? null, error: String(e?.message || e).slice(0, 200) });
  const theme = isObj(design.body?.settings?.theme) ? design.body.settings.theme : null;
  const applied = {
    theme,
    brand: isObj(design.body?.settings?.brand) ? design.body.settings.brand : null,
    presets: [],
    document: { id: design.id, revision: design.revision, draftHash: design.draftHash },
    note: HERO_FAILED_NOTE,
  };
  const view = await documentsView(Docs).catch(() => ({
    kits: catalog(),
    theme,
    upgradeAvailable: false,
    design: { id: DESIGN_ID, revision: design.revision ?? null, draftHash: design.draftHash ?? null, editor: editorHref(DESIGN_ID) },
  }));
  return NextResponse.json({ ok: true, applied, note: HERO_FAILED_NOTE, heroApplied: false, ...view, theme, upgradeAvailable: false });
}
