// The notices every console visitor sees (S34 / OP10, S43 / OP12; moved from
// the old admin root layout in Phase 0 line 8): whenever an operator's
// support grant is active on this store, who, why and until when; and open
// platform incidents with a PUBLIC message (internal notes never). Best-effort:
// a failed read shows no notice and never breaks the console.
//   → { grant: { operator, reason, expires_at } | null, incidents: [{ id, tenant_id, title, public_message }] }
// Phase 2 line 7 (D5): the grant (an operator id and the reason) is only for a
// signed-in console member: pass { member } (the actor the signed-in layout
// resolved). Without one (the sign-in and invite pages) only incidents come back
// and the grant is never read.
import { activeSupportGrant } from "../platform/support.js";
import { openIncidentsFor } from "../platform/incidents.js";
import { currentTenant } from "../tenant-context.js";
import { tfetch } from "../console-request.js";

export async function consoleNotices({ member = null } = {}) {
  return tfetch(() => readNotices({ member })).catch(() => ({ grant: null, incidents: [] }));
}

// The same reads in a store already resolved (consoleNotices runs it inside tfetch).
export async function readNotices({ member = null } = {}) {
  const t = currentTenant();
  const [grant, incidents] = await Promise.all([member && t ? activeSupportGrant(t.id) : null, openIncidentsFor(t?.id || null)]);
  return {
    grant: grant ? { operator: grant.operator, reason: grant.reason, expires_at: grant.expires_at } : null,
    incidents: (incidents || []).map((i) => ({ id: i.id, tenant_id: i.tenant_id, title: i.title, public_message: i.public_message || null })),
  };
}
