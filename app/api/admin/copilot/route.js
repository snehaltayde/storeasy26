import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { CopilotError, TASKS, runTask, taskAction } from "@/lib/ai/copilot";
import { copilotView } from "@/lib/ai/view";

// The AI copilot (Phase 9 line 5).
//   GET                                   storefront.read -> the page's data
//                                         (state, today's budget, the last 30
//                                         runs, the product list, what this
//                                         role may run). Every role, support too.
//   POST { task: "starter" }              storefront.write
//   POST { task: "product_seo", productIds: [gid, … up to 10] }
//                                         storefront.write
//   POST { task: "offer_ideas" }          offers.write
//     -> { ok, task, refs, removed, message, tokens, usage }
// Every run writes drafts only (lib/ai/copilot.js) and records copilot.run in
// the audit log (task and tokens; never the copy).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (a) => NextResponse.json({ error: a.error }, { status: a.status });

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return deny(auth);
  try {
    return NextResponse.json({ ok: true, ...(await copilotView(auth.actor.role)) });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/copilot" });
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    throw e;
  }
});

const STATUS = { AI_UNAVAILABLE: 503, AI_UNCONFIGURED: 503, AI_REFUSED: 502, AI_FAILED: 502, AI_BUDGET: 429 };

export const POST = tenantHandler(async (request) => {
  const body = await request.json().catch(() => null);
  const task = typeof body?.task === "string" ? body.task : "";
  // an unknown task still needs a writer to be told so
  const auth = await requireAdmin(request, taskAction(task) || "storefront.write");
  if (!auth.ok) return deny(auth);
  if (!Object.hasOwn(TASKS, task)) return NextResponse.json({ error: "That isn't something the copilot can do. Reload the page and try again.", code: "UNKNOWN_TASK" }, { status: 400 });
  try {
    const out = await runTask({ task, productIds: body?.productIds ?? null, actor: auth.actor });
    await audit({ actor: auth.actor, action: "copilot.run", resource: `copilot:${task}`, diff: { task, tokens: out.tokens, drafts: out.refs.length, removed: out.removed.length } });
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof CopilotError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    if (e?.code && Object.hasOwn(STATUS, e.code)) {
      const words = e.code === "AI_FAILED" ? "The AI service answered with an error, so nothing was made and no tokens were counted. Try again in a minute." : String(e.message).slice(0, 400);
      return NextResponse.json({ error: words, code: e.code, ...(e.usage ? { usage: e.usage } : {}) }, { status: STATUS[e.code] });
    }
    const infra = infraResponse(e, { route: "admin/copilot" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    slog("copilot_failed", { task, error: String(e?.name || "Error") });
    return NextResponse.json({ error: "Something went wrong, so nothing was made. Try again." }, { status: 500 });
  }
});
