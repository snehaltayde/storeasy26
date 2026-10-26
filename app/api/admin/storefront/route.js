import { NextResponse } from "next/server";
import { verifyAdminToken, ADMIN_COOKIE } from "@/lib/admin-auth";
import { getBlock, setBlock, deleteBlock, getAnnouncement, getHero, getHomeSections, getNav, listContentPages, getContentPage, upsertContentPage, deleteContentPage } from "@/lib/cms/store";
import { validateBlock } from "@/lib/cms/validate";
import { BLOCK_KEYS } from "@/lib/cms/defaults";
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

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

async function view() {
  const [announcement, hero, homeSections, navHeader, navFooter, pages] = await Promise.all([
    getAnnouncement(),
    getHero(),
    getHomeSections(),
    getNav("header"),
    getNav("footer"),
    listContentPages(),
  ]);
  const customized = {};
  for (const key of BLOCK_KEYS) customized[key] = (await getBlock(key)) != null;
  return {
    blocks: { announcement, hero, home_sections: homeSections, nav_header: navHeader, nav_footer: navFooter },
    customized,
    pages,
  };
}

export const GET = tenantHandler(async (request) => {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value))) return unauthorized();
  return NextResponse.json({ ok: true, ...(await view()) });
});

export const PUT = tenantHandler(async (request) => {
  if (!(await verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value))) return unauthorized();
  const body = await request.json().catch(() => ({}));

  try {
    if (body.block) {
      if (body.reset) {
        await deleteBlock(body.block);
        slog("cms_block_reset", { block: body.block });
      } else {
        const { ok, errors, value } = validateBlock(body.block, body.value);
        if (!ok) return NextResponse.json({ error: "Validation failed", errors }, { status: 422 });
        await setBlock(body.block, value);
        slog("cms_block_saved", { block: body.block });
      }
    } else if (body.page) {
      await upsertContentPage(body.page);
      slog("cms_page_saved", { slug: body.page.slug });
    } else if (body.deletePage) {
      await deleteContentPage(body.deletePage);
      slog("cms_page_deleted", { slug: body.deletePage });
    } else if (body.getPage) {
      // editor prefill: effective content for one slug (default or override)
      return NextResponse.json({ ok: true, page: await getContentPage(body.getPage) });
    } else {
      return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...(await view()) });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 422 });
  }
});
