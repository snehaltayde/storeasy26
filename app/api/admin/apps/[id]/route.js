import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { tenantHandler } from "@/lib/tenant-request";
import { appErrorAnswer, disableInstall, enableInstall, getInstall, saveSettings, uninstallInstall } from "@/lib/plugins/installs";

// One installed app (Phase 4 line 1). [id] is the install id (pin_…).
//   GET  apps.read → { install, plugin, activity? } (activity only for audit.read)
//   POST apps.manage, one of { enable: true } | { disable: true } |
//        { uninstall: true } | { settings: { key: value } } → { install }
// A settings refusal is 422 with { errors: { field: message } }; no message
// quotes a value, so a secret never comes back.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });
const appFailure = (e, route) => {
  const f = appErrorAnswer(e, route);
  return NextResponse.json(f.body, { status: f.status });
};
const ACTIONS = ["enable", "disable", "uninstall", "settings"];

export const GET = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "apps.read");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  try {
    const found = await getInstall(String(id || ""), { withActivity: roleAllows(auth.actor.role, "audit.read") });
    if (!found) return NextResponse.json({ error: "This app isn't installed on your store. It may have been uninstalled.", code: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ ok: true, ...found });
  } catch (e) {
    return appFailure(e, "admin/apps/[id]");
  }
});

export const POST = tenantHandler(async (request, { params }) => {
  const auth = await requireAdmin(request, "apps.manage");
  if (!auth.ok) return deny(auth);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const asked = ACTIONS.filter((a) => body && body[a] !== undefined);
  if (asked.length !== 1) return NextResponse.json({ error: "Choose one thing to change.", code: "BAD_REQUEST" }, { status: 400 });
  const opts = { actor: auth.actor };
  const installId = String(id || "");
  try {
    const action = asked[0];
    if (action === "settings") return NextResponse.json({ ok: true, install: await saveSettings(installId, body.settings, opts) });
    const run = { enable: enableInstall, disable: disableInstall, uninstall: uninstallInstall }[action];
    return NextResponse.json({ ok: true, install: await run(installId, opts) });
  } catch (e) {
    return appFailure(e, "admin/apps/[id]");
  }
});
