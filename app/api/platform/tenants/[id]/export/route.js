import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { buildTenantExport, mintExportToken, verifyExportToken } from "@/lib/platform/export";
import { audit, operatorActor } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { getTenant } from "@/lib/platform/control";

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
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const { id } = await params;
  if (!(await getTenant(id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let token;
  try {
    token = await mintExportToken(id);
  } catch {
    return NextResponse.json({ error: "Exports aren't available: PLATFORM_SECRET isn't set on this server." }, { status: 503 });
  }
  await audit({ actor: operatorActor(auth.operator), action: "tenant.export", resource: `tenant:${id}`, tenantId: id, diff: { export_link_minted: true } });
  slog("tenant_export_link", { tenant: id });
  return NextResponse.json({ ok: true, url: `/api/platform/tenants/${id}/export?token=${token}`, expires_in: "1 hour" });
}

export async function GET(request, { params }) {
  const { id } = await params;
  const token = new URL(request.url).searchParams.get("token");
  let valid = false;
  try {
    valid = await verifyExportToken(id, token);
  } catch {
    // no PLATFORM_SECRET: no link can be checked, so none is honoured
    return NextResponse.json({ error: "exports are not available on this server" }, { status: 503 });
  }
  if (!valid) {
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
