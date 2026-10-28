import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { listTenants, getTenant } from "@/lib/platform/control.js";
import { KITS, kitFor, kitUpgradeAvailable } from "@/lib/themes/kits";

// Operator theme registry (S37 / OP07): the kit catalog (versions, schema
// range, validation state — kits are code, validated by test:themes) and
// every tenant's EXPLICIT pin. There is no write path here: pins change only
// through a merchant (or operator-with-grant… which is read-only) applying a
// kit in that tenant's own console — versions are never overwritten from here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  if (!(await verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const tenants = [];
  for (const t of await listTenants()) {
    const full = await getTenant(t.id);
    const theme = full?.config?.theme || null;
    tenants.push({
      id: t.id,
      status: t.status,
      kit: kitFor(theme).id,
      version: theme?.version ?? null, // null = implicit platform default (pulse)
      pinned: Boolean(theme),
      applied_at: theme?.applied_at || null,
      upgradeAvailable: kitUpgradeAvailable(theme),
    });
  }
  return NextResponse.json({
    ok: true,
    kits: Object.values(KITS).map(({ id, version, label, vertical }) => ({ id, version, label, vertical, schema_range: "v1 blocks" })),
    tenants,
  });
}
