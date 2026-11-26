import { NextResponse } from "next/server";
import { operatorError } from "@/lib/platform/operator-error";
import { requireOperator } from "@/lib/platform/require-operator";
import { buildTenantExport, mintExportToken, spendExportToken } from "@/lib/platform/export";
import { audit, operatorActor } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { getTenant } from "@/lib/platform/control";

// Tenant export (S43 / BE29).
//   POST (operator cookie)     → mint a download link: single-use, 15 minutes,
//                                tenant-bound (Phase 3 audit P3-A)
//   GET ?token=<x.exp.jti.hmac> → the export itself (manifest + data JSON) —
//                                the token IS the auth so the link can be
//                                handed to the merchant; the first use spends
//                                it in one batch with its
//                                tenant.export_downloaded audit row (no row,
//                                no download: 503 and the link stays unspent).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request, { params }) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const { id } = await params;
  // no PLATFORM_SECRET: answer 503 before anything decrypts store secrets (getTenant would throw a 500
  // whenever its cache had expired, which made test-platform-permissions fail only under full-run load)
  if (!process.env.PLATFORM_SECRET) return NextResponse.json({ error: "Exports aren't available: PLATFORM_SECRET isn't set on this server." }, { status: 503 });
  if (!(await getTenant(id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let token;
  try {
    token = await mintExportToken(id, { operator: auth.operator });
  } catch {
    return NextResponse.json({ error: "Exports aren't available: PLATFORM_SECRET isn't set on this server." }, { status: 503 });
  }
  await audit({ actor: operatorActor(auth.operator), action: "tenant.export", resource: `tenant:${id}`, tenantId: id, diff: { export_link_minted: true } });
  slog("tenant_export_link", { tenant: id });
  return NextResponse.json({ ok: true, url: `/api/platform/tenants/${id}/export?token=${token}`, expires_in: "15 minutes", single_use: true });
}

export async function GET(request, { params }) {
  const { id } = await params;
  const token = new URL(request.url).searchParams.get("token");
  let spent;
  try {
    spent = await spendExportToken(id, token);
  } catch (e) {
    // the download's audit row couldn't be written: the link stays unspent
    if (e?.code === "EXPORT_AUDIT_FAILED") return NextResponse.json({ error: "The download couldn't be recorded, so it wasn't served. Try the same link again in a minute." }, { status: 503 });
    // no PLATFORM_SECRET: no link can be checked, so none is honoured
    return NextResponse.json({ error: "exports are not available on this server" }, { status: 503 });
  }
  if (!spent) {
    return NextResponse.json({ error: "invalid, expired or already used export link" }, { status: 401 });
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
    // P3-B: the driver's error can name the store's database; it goes to the log scrubbed
    return operatorError(e, { tenant: await getTenant(id).catch(() => null), words: "We couldn't build this store's export just now. Mint a new link and try again.", event: "tenant_export_failed" });
  }
}
