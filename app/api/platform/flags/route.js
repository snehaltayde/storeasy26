import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { listFlags, setFlag, emergencyDisable, deleteFlag } from "@/lib/platform/flags";

// Operator feature flags (S47 / OP13). Server-evaluated rollout/kill flags,
// namespaced ff_* and deliberately separate from billing entitlements.
// Critical flags evaluate uncached, so the emergency disable here stops the
// next request on every instance. All writes are audited.
//   GET                → flags
//   POST {flag:{…}}    → create/update
//   POST {disable:{key}}   → emergency disable (default off, cohorts cleared)
//   POST {remove:{key}}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  return NextResponse.json({ ok: true, flags: await listFlags() });
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  try {
    if (body.flag) return NextResponse.json({ ok: true, ...(await setFlag({ ...body.flag, actor: auth.operator.id })) });
    if (body.disable) return NextResponse.json({ ok: true, ...(await emergencyDisable(String(body.disable.key || ""), auth.operator.id)) });
    if (body.remove) return NextResponse.json({ ok: true, ...(await deleteFlag(String(body.remove.key || ""), auth.operator.id)) });
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
}
