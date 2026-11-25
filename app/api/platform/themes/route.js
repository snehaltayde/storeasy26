import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { listTenants, getTenant } from "@/lib/platform/control.js";
import { KITS, kitFor, kitUpgradeAvailable, themePinOf } from "@/lib/themes/kits";

// Operator theme registry (S37 / OP07): the kit catalog (versions, schema
// range, validation state — kits are code, validated by test:themes) and
// every tenant's EXPLICIT pin. There is no write path here: pins change only
// through a merchant (or operator-with-grant… which is read-only) applying a
// kit in that tenant's own console — versions are never overwritten from here.
// P3-DESIGN (TOK-03): each store's pin is config.theme_pin, the look its last
// design publish put live (lib/documents/after-commit.js), read through
// themePinOf; a store with none yet shows its legacy pin (config.theme).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const tenants = [];
  for (const t of await listTenants()) {
    const full = await getTenant(t.id);
    const theme = themePinOf(full?.config);
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
