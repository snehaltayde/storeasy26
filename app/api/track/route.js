import { NextResponse } from "next/server";
import {
  ga4Configured,
  metaConfigured,
  ga4ClientId,
  newClientId,
  newFbp,
  hashEmail,
  hashPhone,
  buildGa4Payload,
  sendGa4,
  buildMetaPayload,
  sendMeta,
  META_TEST_EVENT_CODE,
} from "@/lib/tracking";

// Node runtime for node:crypto (SHA-256). First-party: same-origin with the app.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const clientIp = (request) => {
  const xff = request.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0].trim() : request.headers.get("x-real-ip") || null;
};

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const event = body.event || {};
  // event = { name:"Purchase", event_id, value, currency, items:[{id,name,price,quantity}], email, phone }
  if (!event.name || !event.event_id) {
    return NextResponse.json({ error: "event.name and event.event_id are required" }, { status: 400 });
  }
  const debug = body.debug === true || request.nextUrl.searchParams.get("debug") === "1";

  // ---- first-party identifiers (read cookies; mint + persist if absent) ----
  const cookies = {};
  for (const c of request.cookies.getAll()) cookies[c.name] = c.value;

  let clientId = ga4ClientId(cookies);
  const setCid = clientId ? null : (clientId = newClientId());
  let fbp = cookies._fbp;
  const setFbp = fbp ? null : (fbp = newFbp());
  const fbc = cookies._fbc || event.fbc || null;

  // ---- build both payloads ----
  const ga4Payload = buildGa4Payload({ clientId, event, debug });
  const metaPayload = buildMetaPayload({
    event,
    userData: {
      emailHash: hashEmail(event.email),
      phoneHash: hashPhone(event.phone),
      fbp,
      fbc,
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    },
    eventSourceUrl: body.sourceUrl || request.headers.get("referer") || undefined,
    testCode: META_TEST_EVENT_CODE || undefined,
  });

  // ---- relay (resilient: a tracking failure must never break the caller) ----
  const tasks = [sendGa4({ payload: ga4Payload, validate: false })];
  if (debug) tasks.push(sendGa4({ payload: ga4Payload, validate: true }));
  tasks.push(sendMeta({ payload: metaPayload }));
  const settled = await Promise.allSettled(tasks);
  const val = (i) => (settled[i]?.status === "fulfilled" ? settled[i].value : { error: String(settled[i]?.reason) });

  const result = {
    ok: true,
    event_id: event.event_id,
    configured: { ga4: ga4Configured(), meta: metaConfigured() },
    ga4: val(0),
    ...(debug ? { ga4Validation: val(1), meta: val(2) } : { meta: val(1) }),
    ...(debug
      ? {
          sent: {
            ga4: ga4Payload,
            meta: metaPayload, // hashes are one-way; safe to echo in debug
            clientId,
            fbp,
            fbc,
          },
        }
      : {}),
  };

  const res = NextResponse.json(result);
  // persist first-party cookies (non-httpOnly so a browser pixel can align if present)
  const yr = 60 * 60 * 24 * 365;
  if (setCid) res.cookies.set("_fp_cid", setCid, { sameSite: "lax", maxAge: yr * 2, path: "/" });
  if (setFbp) res.cookies.set("_fbp", setFbp, { sameSite: "lax", maxAge: yr * 3, path: "/" });
  return res;
}
