import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { listTenants } from "@/lib/platform/control.js";
import { listStores, storeHealth, healthIds } from "@/lib/platform/stores-list.js";

// The operator's Stores list (Phase 3 line 1, lib/platform/stores-list.js).
//   GET ?q=&status=&plan=&attention=1&sort=&dir=&offset=
//       -> { stores, total, offset, pageSize, counts, plans, params }
//       control-plane SQL only: no store database is opened
//   GET ?health=id,id  -> { health: { id: { state, reasons, ... } } }
//       live checks for the visible rows only, 5 seconds a store
//   GET ?legacy=1      -> { tenants: [... with health] } for the old console
//       at /platform/legacy (removed by Phase 3 line 7)
// No answer carries db_url, a database token or a secret value. Phase 1 line 9
// retired POST: operators create stores through /api/platform/stores.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (body) => NextResponse.json({ ok: true, ...body }, { headers: { "Cache-Control": "no-store" } });

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  const sp = new URL(request.url).searchParams;
  if (sp.has("health")) return json({ health: await storeHealth(healthIds(sp.get("health"))) });
  if (sp.get("legacy") === "1") {
    const rows = await listTenants();
    const health = await storeHealth(rows.map((r) => r.id));
    return json({ tenants: rows.map(({ id, name, status, domains, created_at, updated_at }) => ({ id, name, status, domains, created_at, updated_at, health: health[id] })) });
  }
  return json(await listStores(sp));
}
