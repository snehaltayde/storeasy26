import { NextResponse } from "next/server";
import { handleReleasesGet, handleReleasesPost } from "@/lib/admin/releases-api";
import { tenantHandler } from "@/lib/tenant-request";

// Releases console API (S36 / BE09+MC13). The handler lives in
// lib/admin/releases-api.js (DOC-04), so a suite can drive the real publish
// path; see that file for the actions and the error
// contract (422 with structured issues, 5xx with a code for infrastructure).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const r = await handleReleasesGet(request);
  return NextResponse.json(r.body, { status: r.status });
});

export const POST = tenantHandler(async (request) => {
  const r = await handleReleasesPost(request);
  return NextResponse.json(r.body, { status: r.status });
});
