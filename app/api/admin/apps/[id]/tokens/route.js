import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { tenantHandler } from "@/lib/tenant-request";
import { appErrorAnswer } from "@/lib/plugins/installs";
import { mintToken, revokeToken, setScopes, tokensView } from "@/lib/plugins/tokens";

// A custom app's API access (Phase 4 line 4). [id] is the install id (pin_…).
//   GET  apps.read → { scopes, offered, tokens, maxActive, expiryDays, defaultExpiryDays }
//        (never a token's secret or hash)
//   POST apps.manage, one of
//        { create: { name, scopes, days } } (→ { token, secret }: the secret once)
//        | { revoke: "<tok_…>" } | { scopes: { scopes, confirm? } }
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });
const appFailure = (e) => {
  const f = appErrorAnswer(e, "admin/apps/[id]/tokens");
  const body = e?.added ? { ...f.body, added: e.added } : f.body;
  return NextResponse.json(body, { status: f.status });
};
const ACTIONS = ["create", "revoke", "scopes"];
const NO_STORE = { headers: { "cache-control": "no-store" } };

export const GET = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "apps.read");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  try {
    return NextResponse.json({ ok: true, ...(await tokensView(String(id || ""))) });
  } catch (e) {
    return appFailure(e);
  }
});

export const POST = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "apps.manage");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const asked = ACTIONS.filter((a) => body && body[a] !== undefined && body[a] !== false && body[a] !== null);
  if (asked.length !== 1) return NextResponse.json({ error: "Choose one thing to change.", code: "BAD_REQUEST" }, { status: 400 });
  const installId = String(id || "");
  const opts = { actor: auth.actor };
  const obj = (v) => (typeof v === "object" && v ? v : {});
  try {
    if (asked[0] === "create") return NextResponse.json({ ok: true, ...(await mintToken(installId, obj(body.create), opts)) }, NO_STORE);
    if (asked[0] === "revoke") return NextResponse.json({ ok: true, ...(await revokeToken(installId, String(body.revoke), opts)) });
    return NextResponse.json({ ok: true, ...(await setScopes(installId, obj(body.scopes), opts)) });
  } catch (e) {
    return appFailure(e);
  }
});
