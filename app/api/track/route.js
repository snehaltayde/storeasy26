import { NextResponse, after } from "next/server";
import { CART_COOKIE } from "@/lib/cart";
import { storeEvent, enqueueForward, runEventSweep, isFunnelEvent } from "@/lib/events";
import {
  ga4ClientId,
  newClientId,
  newFbp,
  extractTrackingIds,
  fbcFromFbclid,
  hashEmail,
  hashPhone,
} from "@/lib/tracking";

// First-party event collector (Session 14, productionizes the S9 spike).
// Same-origin with the storefront → cookies are first-party; when the app runs
// on a BeastLife subdomain, set COOKIE_DOMAIN=.beastlife.in so identity spans
// www/shop/track. STORE-THEN-FORWARD: the event is durably persisted before we
// answer; GA4/Meta forwarding happens after the response and is retried by the
// sweep — a downstream blip never drops an event.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const YEAR = 60 * 60 * 24 * 365;
const DAY90 = 60 * 60 * 24 * 90;

const clientIp = (request) => {
  const xff = request.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0].trim() : request.headers.get("x-real-ip") || null;
};

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const { name, event_id: eventId } = body;
  if (!name || !isFunnelEvent(name))
    return NextResponse.json({ error: `Unknown event name "${name}"` }, { status: 400 });
  if (!eventId) return NextResponse.json({ error: "event_id is required" }, { status: 400 });

  const cookies = {};
  for (const c of request.cookies.getAll()) cookies[c.name] = c.value;

  // ---- first-party identity: read, else mint + persist ----
  let clientId = ga4ClientId(cookies);
  const setCid = clientId ? null : (clientId = newClientId());
  let fbp = cookies._fbp;
  const setFbp = fbp ? null : (fbp = newFbp());

  const { fbclid, gclid: urlGclid } = extractTrackingIds(body.url || "");
  let fbc = cookies._fbc || null;
  const setFbc = !fbc && fbclid ? (fbc = fbcFromFbclid(fbclid)) : null;
  let gclid = cookies._fp_gclid || null;
  const setGclid = !gclid && urlGclid ? (gclid = urlGclid) : null;

  // Raw PII never enters storage — hash-and-discard if a caller ever sends it.
  const userData = {};
  if (body.email) userData.em = hashEmail(body.email);
  if (body.phone) userData.ph = hashPhone(body.phone);

  const stored = await storeEvent({
    eventId,
    name,
    clientId,
    fbp,
    fbc,
    gclid,
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
    url: body.url || request.headers.get("referer") || null,
    referrer: body.referrer || null,
    cartId: cookies[CART_COOKIE] || null,
    orderId: name === "purchase" ? body.params?.transaction_id || eventId : null,
    payload: {
      ...(body.value != null ? { value: Number(body.value) } : {}),
      ...(body.currency ? { currency: body.currency } : {}),
      ...(body.items ? { items: body.items } : {}),
      ...(body.params ? { params: body.params } : {}),
      ...(Object.keys(userData).length ? { user_data: userData } : {}),
    },
  });

  // durable first, forward after the response (+ a tiny straggler sweep)
  after(async () => {
    await enqueueForward(eventId);
    await runEventSweep({ limit: 3 }).catch((e) => console.error(`[events] sweep: ${e?.message || e}`));
  });

  const res = NextResponse.json(
    { ok: true, event_id: eventId, ...(stored.deduped ? { deduped: true } : { stored: true }) },
    { status: 202 },
  );

  // Persist first-party identity cookies (non-httpOnly: browser tags may align).
  const domain = process.env.COOKIE_DOMAIN || undefined;
  const base = { sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", domain };
  if (setCid) res.cookies.set("_fp_cid", setCid, { ...base, maxAge: YEAR * 2 });
  if (setFbp) res.cookies.set("_fbp", setFbp, { ...base, maxAge: YEAR * 3 });
  if (setFbc) res.cookies.set("_fbc", setFbc, { ...base, maxAge: DAY90 });
  if (setGclid) res.cookies.set("_fp_gclid", setGclid, { ...base, maxAge: DAY90 });
  return res;
}
