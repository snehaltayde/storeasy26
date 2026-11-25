import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { tenantHandler } from "@/lib/tenant-request";
import { archivePackage, getPackage, packageFile, themeErrorAnswer } from "@/lib/themes/packages";

// One uploaded theme (Phase 5 line 1). [id] is thm_ + 16 hex.
//   GET            storefront.read → { package, content }
//   GET ?download  storefront.read → the stored normalised JSON, as a file
//   POST { archive: true }  themes.manage → { package }
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

export const POST = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "themes.manage");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (!body || body.archive !== true) return NextResponse.json({ error: "Choose what to do with this theme.", code: "BAD_REQUEST" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, package: await archivePackage(String(id || ""), { actor: auth.actor }) });
  } catch (e) {
    return failure(e);
  }
});
