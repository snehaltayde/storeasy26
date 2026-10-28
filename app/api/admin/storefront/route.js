import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { setBlock, deleteBlock, getContentPage, upsertContentPage, deleteContentPage, CmsConflictError } from "@/lib/cms/store";
import { storefrontView } from "@/lib/cms/view";
import { validateBlock } from "@/lib/cms/validate";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Storefront CMS console API (Session 23).
//   GET            → effective blocks (+ which are customized) and the page list
//   PUT {block, value}        → validate + store a block
//   PUT {block, reset: true}  → back to defaults
//   PUT {page}                → upsert a content page
//   PUT {deletePage: slug}    → remove an override/custom page
export const runtime = "nodejs";
export const dynamic = "force-dynamic";


// S50: the view builder moved to lib/cms/view.js so the admin PAGE renders
// the exact same shape (it used to hand-roll a subset without the CAS
// revision tokens — the false-409 / block-wipe bug).
const view = storefrontView;

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ ok: true, ...(await view()) });
});

export const PUT = tenantHandler(async (request) => {
  const body = await request.json().catch(() => ({}));
  // getPage is a read (editor prefill); everything else mutates
  const auth = await requireAdmin(request, body.getPage ? "storefront.read" : "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    if (body.block) {
      if (body.reset) {
        await deleteBlock(body.block);
        slog("cms_block_reset", { block: body.block });
        await audit({ actor: auth.actor, action: "storefront.write", resource: `block:${body.block}`, diff: { reset: true } });
      } else {
        const { ok, errors, value } = validateBlock(body.block, body.value);
        if (!ok) return NextResponse.json({ error: "Validation failed", errors }, { status: 422 });
        // body.revision: the revision the editor loaded (null = creating);
        // omitted entirely = no check (pre-S35 clients, scripts)
        await setBlock(body.block, value, "revision" in body ? { expectedRevision: body.revision } : {});
        slog("cms_block_saved", { block: body.block });
        await audit({ actor: auth.actor, action: "storefront.write", resource: `block:${body.block}` });
      }
    } else if (body.page) {
      await upsertContentPage(body.page, "revision" in body ? { expectedRevision: body.revision } : {});
      slog("cms_page_saved", { slug: body.page.slug });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `page:${body.page.slug}` });
    } else if (body.deletePage) {
      await deleteContentPage(body.deletePage);
      slog("cms_page_deleted", { slug: body.deletePage });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `page:${body.deletePage}`, diff: { deleted: true } });
    } else if (body.getPage) {
      // editor prefill: effective content for one slug (default or override)
      return NextResponse.json({ ok: true, page: await getContentPage(body.getPage) });
    } else {
      return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...(await view()) });
  } catch (e) {
    if (e instanceof CmsConflictError) {
      // 409: both versions preserved — the server's current row rides along,
      // the editor's unsaved value stays in their form.
      return NextResponse.json({ error: e.message, code: e.code, current: e.current }, { status: 409 });
    }
    return NextResponse.json({ error: String(e?.message || e) }, { status: 422 });
  }
});
