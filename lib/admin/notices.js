// The notices every console visitor sees (S34 / OP10, S43 / OP12; moved from
// app/(console)/admin/layout.js in Phase 0 line 8): whenever an operator's
// support grant is active on this store, who, why and until when; and open
// platform incidents with a PUBLIC message (internal notes never). Best-effort:
// a failed read shows no notice and never breaks the console.
//   → { grant: { operator, reason, expires_at } | null, incidents: [{ id, tenant_id, title, public_message }] }
import { activeSupportGrant } from "../platform/support.js";
import { openIncidentsFor } from "../platform/incidents.js";
import { currentTenant } from "../tenant-context.js";
import { tfetch } from "../console-request.js";

export async function consoleNotices() {
  const [grant, incidents] = await tfetch(async () =>
    Promise.all([currentTenant() ? activeSupportGrant(currentTenant().id) : null, openIncidentsFor(currentTenant()?.id || null)]),
  ).catch(() => [null, []]);
  return {
    grant: grant ? { operator: grant.operator, reason: grant.reason, expires_at: grant.expires_at } : null,
    incidents: (incidents || []).map((i) => ({ id: i.id, tenant_id: i.tenant_id, title: i.title, public_message: i.public_message || null })),
  };
}
