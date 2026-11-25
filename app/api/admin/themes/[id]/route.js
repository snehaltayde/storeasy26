import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { tenantHandler } from "@/lib/tenant-request";
import { applyFlagship, applyPackage, archivePackage, getPackage, packageFile, themeErrorAnswer } from "@/lib/themes/packages";
import { isFlagshipSlug } from "@/lib/themes/flagships";
import { validationBody } from "@/lib/cms/issues";

// One uploaded theme (Phase 5 line 1). [id] is thm_ + 16 hex, or (Phase 7
// line 1) a Storeasy flagship's slug (volt, bloom, loom, harvest, haven):
// GET gives its newest version, apply installs it on first use (source
// 'storeasy', never counted toward the upload limit, never archived) and
// applies it with the same options; storefront.write, as choosing a theme.
//   GET            storefront.read → { package, content }
//   GET ?download  storefront.read → the stored normalised JSON, as a file
//   POST { archive: true }  themes.manage → { package }
//   POST { apply: { withBrand?, withHome?, confirmHome?, revision? } }
//        storefront.write → { applied } (Phase 5 line 3): a doc_design draft
//        naming this theme, plus its layouts (and home, if asked) as drafts.
//        409 DESIGN_CHANGED / HOME_CONFIRM_NEEDED / ARCHIVED. Publish is the
//        documents publish (storefront.publish).
// Archive is 409 while the theme is live or in the design draft.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });
const failure = (e) => {
  const f = themeErrorAnswer(e, "admin/themes/[id]");
  return NextResponse.json(f.body, { status: f.status });
};
const notFound = () => NextResponse.json({ error: "This theme isn't on your store. Reload the page to see your themes.", code: "NOT_FOUND" }, { status: 404 });

export const GET = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  try {
    if (new URL(request.url).searchParams.has("download")) {
      const file = await packageFile(String(id || ""));
      if (!file) return notFound();
      return new NextResponse(file.text, { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${file.filename}"`, "x-content-type-options": "nosniff", "cache-control": "no-store" } });
    }
    const found = await getPackage(String(id || ""));
    if (!found) return notFound();
    return NextResponse.json({ ok: true, ...found });
  } catch (e) {
    return failure(e);
  }
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const APPLY_KEYS = ["withBrand", "withHome", "confirmHome", "revision"];
function parseApply(a) {
  if (!isObj(a) || Object.keys(a).some((k) => !APPLY_KEYS.includes(k))) return null;
  if (["withBrand", "withHome", "confirmHome"].some((k) => a[k] !== undefined && typeof a[k] !== "boolean")) return null;
  if (a.revision !== undefined && !Number.isInteger(a.revision)) return null;
  return { withBrand: a.withBrand !== false, withHome: a.withHome === true, confirmHome: a.confirmHome === true, revision: a.revision };
}

export const POST = tenantHandler(async (request, { params }) => {
  const body = await request.json().catch(() => ({}));
  const apply = isObj(body) && Object.keys(body).length === 1 && body.apply !== undefined ? parseApply(body.apply) : null;
  if (isObj(body) && Object.hasOwn(body, "apply") && !apply) return NextResponse.json({ error: "Choose how to use this theme.", code: "BAD_REQUEST" }, { status: 400 });
  if (apply) {
    const auth = await requireAdmin(request, "storefront.write");
    if (!auth.ok) return deny(auth);
    const { id } = await params;
    try {
      const Docs = await import("@/lib/documents/service");
      const key = String(id || "");
      const opts = { ...apply, actor: auth.actor, documents: Docs };
      return NextResponse.json({ ok: true, applied: isFlagshipSlug(key) ? await applyFlagship(key, opts) : await applyPackage(key, opts) });
    } catch (e) {
      if (e?.issues) return NextResponse.json(validationBody(e.issues), { status: 422 });
      if (e?.expose && e.status >= 400 && e.status < 500) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
      return failure(e);
    }
  }
  const auth = await requireAdmin(request, "themes.manage");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  if (!body || body.archive !== true) return NextResponse.json({ error: "Choose what to do with this theme.", code: "BAD_REQUEST" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, package: await archivePackage(String(id || ""), { actor: auth.actor }) });
  } catch (e) {
    return failure(e);
  }
});
