import { NextResponse } from "next/server";
import { verifyPlatformToken, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
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

const authed = async (request) => verifyPlatformToken(request.cookies.get(PLATFORM_COOKIE)?.value);

export async function GET(request) {
  if (!(await authed(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, flags: await listFlags() });
}

export async function POST(request) {
  if (!(await authed(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  try {
    if (body.flag) return NextResponse.json({ ok: true, ...(await setFlag({ ...body.flag, actor: "operator" })) });
    if (body.disable) return NextResponse.json({ ok: true, ...(await emergencyDisable(String(body.disable.key || ""), "operator")) });
    if (body.remove) return NextResponse.json({ ok: true, ...(await deleteFlag(String(body.remove.key || ""), "operator")) });
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
}
