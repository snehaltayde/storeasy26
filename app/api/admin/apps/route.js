import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { tenantHandler } from "@/lib/tenant-request";
import { appErrorAnswer, catalogView, installPlugin, listInstalls } from "@/lib/plugins/installs";

// Apps (Phase 4 line 1).
//   GET                              apps.read   → { installs, catalog }
//   POST { install: { pluginId, scopes } }  apps.manage → { install }
// scopes are the permissions the admin approved in the install dialog; they
// must be what the plugin asks for now. No secret ever leaves here.
// line 3: create_custom
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });

const appFailure = (e, route) => {
  const f = appErrorAnswer(e, route);
  return NextResponse.json(f.body, { status: f.status });
};

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "apps.read");
  if (!auth.ok) return deny(auth);
  try {
    const [installs, catalog] = await Promise.all([listInstalls(), catalogView()]);
    return NextResponse.json({ ok: true, installs, catalog });
  } catch (e) {
    return appFailure(e, "admin/apps");
  }
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "apps.manage");
  if (!auth.ok) return deny(auth);
  const body = await request.json().catch(() => ({}));
  if (!body || typeof body.install !== "object" || body.install === null) return NextResponse.json({ error: "Choose an app to install.", code: "BAD_REQUEST" }, { status: 400 });
  try {
    const install = await installPlugin({ pluginId: body.install.pluginId, scopes: body.install.scopes }, { actor: auth.actor });
    return NextResponse.json({ ok: true, install });
  } catch (e) {
    return appFailure(e, "admin/apps");
  }
});
