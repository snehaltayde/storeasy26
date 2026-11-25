import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { tenantHandler } from "@/lib/tenant-request";
import { bodyTextCapped, builtinLooks, listFlagships, listPackages, themeErrorAnswer, themeState, uploadPackage } from "@/lib/themes/packages";

// Themes (Phase 5 line 1).
//   GET  ?status=archived   storefront.read → { builtins, flagships, packages, archived, state }
//        flagships (Phase 7 line 1): the five Storeasy themes (listFlagships);
//        packages: every row, each with source "upload" | "storeasy"
//        state (line 3): { live, draft, design, publishSet } (lib/themes/packages.js themeState)
//   POST <the package file's text>  themes.manage → { package }
// The upload body is the theme file itself, at most 256 KB (413 on the header
// and again while reading). A refusal is 422 with { error, issues: [{ code,
// path, message, text }] }, every issue in plain words with its place.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });
const failure = (e) => {
  const f = themeErrorAnswer(e, "admin/themes");
  return NextResponse.json(f.body, { status: f.status });
};

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return deny(auth);
  const archived = new URL(request.url).searchParams.get("status") === "archived";
  try {
    return NextResponse.json({ ok: true, builtins: builtinLooks(), flagships: await listFlagships(), packages: await listPackages({ archived }), archived, state: await themeState() });
  } catch (e) {
    return failure(e);
  }
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "themes.manage");
  if (!auth.ok) return deny(auth);
  try {
    const text = await bodyTextCapped(request);
    return NextResponse.json({ ok: true, package: await uploadPackage(text, { actor: auth.actor }) });
  } catch (e) {
    return failure(e);
  }
});
