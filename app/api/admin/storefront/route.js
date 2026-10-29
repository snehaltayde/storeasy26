import { NextResponse } from "next/server";
import { handleStorefrontGet, handleStorefrontPut } from "@/lib/admin/cms-api";
import { tenantHandler } from "@/lib/tenant-request";

// Storefront CMS console API (Session 23; S53/A1 hardening).
//   GET            → effective blocks (+ which are customized) and the page list
//   PUT {block, value}        → validate + store a block
//   PUT {block, reset: true}  → back to defaults
//   PUT {page}                → upsert a content page
//   PUT {deletePage: slug}    → remove an override/custom page
//   PUT {getPage: slug}       → read one page (editor prefill)
// Exactly ONE operation per request: mixed payloads are rejected before
// authorization, and the permission is derived from the parsed operation.
// The handler lives in lib/admin/cms-api.js so the route-level suite
// (scripts/test-cms-api.js) can exercise real dispatch + storage effects.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const r = await handleStorefrontGet(request);
  return NextResponse.json(r.body, { status: r.status });
});

export const PUT = tenantHandler(async (request) => {
  const r = await handleStorefrontPut(request);
  return NextResponse.json(r.body, { status: r.status });
});
