// Phase 9 line 5: what the Copilot page shows, for the page and GET
// /api/admin/copilot alike. SERVER-ONLY, inside withTenant. A read (every role
// that holds storefront.read, support included); `can` says which run buttons
// this role gets (the route refuses the rest anyway).
//   copilotView(role) -> { state, can: { starter, product_seo, offer_ideas },
//                          products: [{ id, title, handle }], history: [run] }
// No copy and no prompt is ever shown again: a run is its task, who, when,
// tokens and links to its drafts.
import { db } from "../db.js";
import { tenantId } from "../tenant-context.js";
import { roleAllows } from "../platform/authz.js";
import { namesFor, plainName } from "../documents/versions.js";
import { TASKS, copilotState } from "./copilot.js";
import { listRuns } from "./budget.js";

export async function copilotView(role) {
  const state = await copilotState();
  const can = Object.fromEntries(Object.entries(TASKS).map(([k, t]) => [k, roleAllows(role, t.action)]));
  const products = (await db.selectFrom("products").select(["id", "title", "handle"]).orderBy("title").limit(200).execute()).map((p) => ({ id: String(p.id), title: String(p.title), handle: String(p.handle) }));
  let history = [];
  if (state.ledgerReady) {
    const [runs, names] = await Promise.all([listRuns({ limit: 30 }), namesFor(tenantId())]);
    history = runs.map(({ actor, ...r }) => ({ ...r, label: TASKS[r.task]?.label || r.task, by: plainName(actor, names) }));
  }
  return { state, can, products, history };
}
