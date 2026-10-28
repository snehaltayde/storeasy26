import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { sameOrigin } from "@/lib/origin-check";
import { platformDb } from "@/lib/platform/control";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";

// Incidents (S43 / OP12): operator-declared, internal notes separated from
// the PUBLIC message merchants see in their console while the incident is
// open. tenant_id NULL = platform-wide.
//   GET                                  → all incidents (newest first)
//   POST {action:"open", title, tenant?, publicMessage?, internalNote?}
//   POST {action:"update", id, publicMessage?, internalNote?}
//   POST {action:"resolve", id}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const incId = () => "inc_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });

export async function GET(request) {
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const r = await platformDb().execute("SELECT * FROM incidents ORDER BY created_at DESC LIMIT 50");
  return NextResponse.json({ ok: true, incidents: r.rows.map((row) => ({ ...row })) });
}

export async function POST(request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) return unauthorized();
  const body = await request.json().catch(() => ({}));
  const db = platformDb();
  try {
    if (body.action === "open") {
      const title = String(body.title || "").trim().slice(0, 200);
      if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
      const id = incId();
      await db.execute({
        sql: "INSERT INTO incidents (id, tenant_id, title, internal_note, public_message, status, created_at) VALUES (?,?,?,?,?, 'open', ?)",
        args: [id, body.tenant || null, title, String(body.internalNote || "").slice(0, 2000) || null, String(body.publicMessage || "").slice(0, 500) || null, new Date().toISOString()],
      });
      slog("incident_opened", { id, tenant: body.tenant || "platform" });
      await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.status", resource: `incident:${id}`, diff: { opened: title.slice(0, 80) } });
    } else if (body.action === "update") {
      await db.execute({
        sql: "UPDATE incidents SET public_message = COALESCE(?, public_message), internal_note = COALESCE(?, internal_note) WHERE id = ?",
        args: [body.publicMessage != null ? String(body.publicMessage).slice(0, 500) : null, body.internalNote != null ? String(body.internalNote).slice(0, 2000) : null, String(body.id || "")],
      });
    } else if (body.action === "resolve") {
      await db.execute({ sql: "UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?", args: [new Date().toISOString(), String(body.id || "")] });
      slog("incident_resolved", { id: body.id });
      await audit({ actor: { kind: "operator", id: "operator" }, action: "tenant.status", resource: `incident:${body.id}`, diff: { resolved: true } });
    } else {
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    const r = await db.execute("SELECT * FROM incidents ORDER BY created_at DESC LIMIT 50");
    return NextResponse.json({ ok: true, incidents: r.rows.map((row) => ({ ...row })) });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
}
