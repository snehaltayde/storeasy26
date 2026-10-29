import { NextResponse } from "next/server";
import { handleRefsGet } from "@/lib/admin/refs";
import { tenantHandler } from "@/lib/tenant-request";

// Resource references for the console's pickers (S53 / B1): paginated,
// searchable, selected-ID hydrating. See lib/admin/refs.js (the handler the
// route-level suite exercises directly).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const r = await handleRefsGet(request);
  return NextResponse.json(r.body, { status: r.status });
});
