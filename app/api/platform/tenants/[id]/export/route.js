import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { sameOrigin } from "@/lib/origin-check";
import { buildTenantExport, mintExportToken, verifyExportToken } from "@/lib/platform/export";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";

// Tenant export (S43 / BE29).
//   POST (operator cookie)     → mint an EXPIRING download link (1h, tenant-bound)
//   GET ?token=<x.exp.hmac>    → the export itself (manifest + data JSON) —
//                                the token IS the auth so the link can be
//                                handed to the merchant; it expires and is
//                                useless for any other tenant.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request, { params }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const token = await mintExportToken(id);
  await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.status", tenantId: id, diff: { export_link_minted: true } });
  slog("tenant_export_link", { tenant: id });
  return NextResponse.json({ ok: true, url: `/api/platform/tenants/${id}/export?token=${token}`, expires_in: "1 hour" });
}

export async function GET(request, { params }) {
  const { id } = await params;
  const token = new URL(request.url).searchParams.get("token");
  if (!(await verifyExportToken(id, token))) {
    return NextResponse.json({ error: "invalid or expired export link" }, { status: 401 });
  }
  try {
    const exp = await buildTenantExport(id);
    slog("tenant_exported", { tenant: id, tables: Object.keys(exp.manifest.tables).length });
    return new NextResponse(JSON.stringify(exp, null, 1), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="storeasy-export-${id}-${exp.manifest.generated_at.slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
}
