import { NextResponse } from "next/server";
import { requireAdmin, adminSessionTokenFor, adminBootstrapMode, ADMIN_COOKIE } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { settingsView, buildSettingsPatch } from "@/lib/admin/settings";
import { rateChanges } from "@/lib/markets";
import { smsAvailable } from "@/lib/messaging/sms";
import { patchTenant } from "@/lib/platform/control.js";
import { currentTenant, tenantId } from "@/lib/tenant-context.js";
import { db } from "@/lib/db";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";

// Tenant settings console API (Session 22). GET = current view (secret values
// never serialized — presence flags only). PUT = validated merge-patch into the
// CONTROL PLANE for the ACTIVE tenant (resolved from the request Host; the
// tenant id is never taken from the body, so one console can't patch another).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";


async function syncCounts() {
  try {
    const [p, c] = await Promise.all([
      db.selectFrom("products").select([(eb) => eb.fn.countAll().as("n"), (eb) => eb.fn.max("synced_at").as("last")]).executeTakeFirst(),
      db.selectFrom("collections").select((eb) => eb.fn.countAll().as("n")).executeTakeFirst(),
    ]);
    return { products: Number(p?.n || 0), collections: Number(c?.n || 0), lastSyncedAt: p?.last || null };
  } catch {
    return null;
  }
}

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "settings.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ ok: true, settings: settingsView(currentTenant(), { counts: await syncCounts() }) });
});

export const PUT = tenantHandler(async (request) => {
  // requireAdmin covers the CSRF origin check for write actions (S27)
  const auth = await requireAdmin(request, "settings.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default")
    return NextResponse.json(
      { error: "This store runs on environment config — settings are read-only here" },
      { status: 409 },
    );

  const body = await request.json().catch(() => ({}));
  // Phase 8 line 2: SMS codes only where a provider is set (lib/messaging/sms.js)
  const { ok, errors, patch } = buildSettingsPatch(body, tenant.config, { smsAvailable: smsAvailable() });
  if (!ok) return NextResponse.json({ error: "Validation failed", errors }, { status: 422 });

  const updated = await patchTenant(tenant.id, patch);
  slog("admin_settings_saved", {
    tenant: tenant.id,
    config_keys: Object.keys(patch.config),
    secret_keys: Object.keys(patch.secrets), // names only, never values
  });
  await audit({
    actor: auth.actor,
    action: "settings.write",
    resource: "settings",
    // Phase 8 line 4: a markets save lists its rate changes ("US: 84.2 → 85")
    diff: {
      config_keys: Object.keys(patch.config),
      secret_keys: Object.keys(patch.secrets),
      ...(patch.config.markets ? { rate_changes: rateChanges(tenant.config?.markets || [], patch.config.markets) } : {}),
    },
  });

  const res = NextResponse.json({
    ok: true,
    // Phase 8 line 4: the saved markets go back only to the writer who saved them
    settings: { ...settingsView(updated, { counts: await syncCounts() }), ...(patch.config.markets ? { markets: updated?.config?.markets ?? patch.config.markets } : {}) },
    ...(patch.secrets.admin_password ? { passwordRotated: true } : {}),
  });
  // A BOOTSTRAP-password rotation kills the old derived cookie token — re-issue
  // so the merchant stays signed in on THIS browser. In account mode (S26) the
  // admin_password is only the dormant bootstrap credential and the signed-in
  // session cookie must NOT be replaced by a legacy token.
  if (patch.secrets.admin_password && (await adminBootstrapMode())) {
    res.cookies.set(ADMIN_COOKIE, await adminSessionTokenFor(tenantId(), patch.secrets.admin_password), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
  }
  return res;
});
