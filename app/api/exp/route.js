import { NextResponse } from "next/server";
import { recordExposure, UNIT_COOKIE } from "@/lib/experiments";
import { rateLimit } from "@/lib/rate-limit";
import { tenantHandler } from "@/lib/tenant-request";

// Exposure recording (S47 / BE22). The unit comes from the functional
// cookie and the VARIANT IS RE-DERIVED SERVER-SIDE — the body carries only
// which experiment surface was seen. First exposure per unit wins (INSERT
// OR IGNORE), so repeat views and replays can't inflate a variant.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = tenantHandler(async (request) => {
  const limited = rateLimit(request, { name: "exp", limit: 60 });
  if (limited) return limited;
  const unit = request.cookies.get(UNIT_COOKIE)?.value;
  if (!unit || !/^[a-z0-9-]{8,64}$/.test(unit)) return NextResponse.json({ ok: true, recorded: false });
  const body = await request.json().catch(() => ({}));
  const slug = String(body.slug || "");
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug)) return NextResponse.json({ ok: true, recorded: false });
  const r = await recordExposure(slug, unit);
  return NextResponse.json({ ok: true, recorded: r.recorded });
});
