import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/platform/require-operator";
import { listFlags, setFlag, emergencyDisable, deleteFlag, setFlagOverride, flagHistory } from "@/lib/platform/flags";
import { storeChoices } from "@/lib/platform/incidents";

// Operator feature flags (S47 / OP13; the /platform/flags screen, Phase 3 line 4).
// Server-evaluated rollout/kill flags, namespaced ff_* and deliberately separate
// from billing entitlements. Critical flags evaluate uncached, so the emergency
// disable here stops the next request on every instance. Every write is audited
// with the operator (resource flag:<key>).
//   GET                          → { flags, stores }
//   GET ?history=<key>           → { history } (audit rows for flag:<key>)
//   POST {flag:{…}}              → create/update
//   POST {override:{key, tenant, on}} → one store on, off, or (on: null) removed
//   POST {disable:{key}}         → emergency disable (default off, overrides cleared)
//   POST {remove:{key}}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const failed = (e) => NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: e?.status || 422 });

export async function GET(request) {
  const auth = await requireOperator(request);
  if (auth instanceof Response) return auth;
  try {
    const key = request.nextUrl.searchParams.get("history");
    if (key != null) return NextResponse.json({ ok: true, history: await flagHistory(key) });
    const [flags, stores] = await Promise.all([listFlags(), storeChoices()]);
    return NextResponse.json({ ok: true, flags, stores });
  } catch (e) {
    return failed(e);
  }
}

export async function POST(request) {
  const auth = await requireOperator(request, { write: true });
  if (auth instanceof Response) return auth;
  const body = await request.json().catch(() => ({}));
  try {
    if (body.flag) return NextResponse.json({ ok: true, ...(await setFlag({ ...body.flag, actor: auth.operator })) });
    if (body.override) {
      const { key, tenant, on } = body.override;
      return NextResponse.json({ ok: true, ...(await setFlagOverride({ key: String(key || ""), tenant: String(tenant || ""), on: on == null ? null : Boolean(on), actor: auth.operator })) });
    }
    if (body.disable) return NextResponse.json({ ok: true, ...(await emergencyDisable(String(body.disable.key || ""), auth.operator)) });
    if (body.remove) return NextResponse.json({ ok: true, ...(await deleteFlag(String(body.remove.key || ""), auth.operator)) });
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    return failed(e);
  }
}
