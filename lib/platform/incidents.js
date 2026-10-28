// Incident reads (S43 / OP12) — shared by the operator API and the merchant
// console banner. The INTERNAL note never leaves the operator surface.
import { platformDb, platformConfigured } from "./control.js";

// Open incidents visible to a TENANT's console: public message only.
export async function openIncidentsFor(tenantId) {
  if (!platformConfigured()) return [];
  try {
    const r = await platformDb().execute({
      sql: "SELECT id, tenant_id, title, public_message, created_at FROM incidents WHERE status = 'open' AND public_message IS NOT NULL AND (tenant_id IS NULL OR tenant_id = ?) ORDER BY created_at DESC LIMIT 5",
      args: [tenantId || "_none"],
    });
    return r.rows.map((row) => ({ ...row }));
  } catch {
    return []; // pre-migration control plane
  }
}
