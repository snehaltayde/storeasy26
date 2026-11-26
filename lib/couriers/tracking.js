// Phase 9 line 4: writing a store's parcel tracking, and the Shiprocket
// webhook key. SERVER-ONLY (Node), tenant-scoped: inside withTenant().
//   orderIdForAwb(awb)              the order an AWB belongs to (a tracking
//                                   row, else the Shopify fulfilment projection)
//   applyTracking(awb, parsed, { orderId, source, now })
//       writes what the courier said (parseTrack's shape); a move into
//       out_for_delivery or delivered emits order.delivery_updated once
//       (idempotency key delivery:<awb>:<status>)
//   dueShipments({ now, limit })    parcels to poll again: not delivered or
//       cancelled and not fetched for 4 h, then fulfilments with an AWB and no
//       row yet; at most `limit`
//   webhook keys: the key Shiprocket sends as x-api-key, kept only as a hash
//       bound to this store (sha256 of "<tenant>|<key>") inside the install's
//       encrypted secrets; a rotation keeps the old hash for KEY_OVERLAP_MS.
import { db } from "../db.js";
import { tenantId } from "../tenant-context.js";
import { notMigratedYet } from "../schema-shape.js";
import { encryptJson, decryptJson } from "../platform/crypto.js";
import { newToken, sha256Hex } from "../platform/sessions.js";
import { audit } from "../platform/audit.js";
import { slog } from "../log.js";
import { emitPluginEvent } from "../plugins/events.js";
import { OPEN_STATUSES, AWB_RE } from "./normalize.js";

export const REPOLL_MS = 4 * 60 * 60 * 1000;
export const SWEEP_LIMIT = 50;
export const KEY_OVERLAP_MS = 24 * 60 * 60 * 1000;
export const PLUGIN_ID = "shiprocket";
const KEY_FIELD = "__parcel_key";
const NOTIFY = new Set(["out_for_delivery", "delivered"]);

const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const missing = (e) => notMigratedYet(e, { table: "shipment_tracking" });

export async function orderIdForAwb(awb) {
  if (!AWB_RE.test(String(awb ?? ""))) return null;
  try {
    const row = await db.selectFrom("shipment_tracking").select("order_id").where("awb", "=", awb).executeTakeFirst();
    if (row) return String(row.order_id);
  } catch (e) {
    if (!missing(e)) throw e;
  }
  const f = await db.selectFrom("order_fulfillments").select("order_id").where("tracking_number", "=", awb).orderBy("updated_at", "desc").executeTakeFirst();
  return f ? String(f.order_id) : null;
}

export async function applyTracking(awb, parsed, { orderId = null, source = "shiprocket", now = Date.now() } = {}) {
  if (!parsed || !AWB_RE.test(String(awb ?? ""))) return null;
  const order = orderId || (await orderIdForAwb(awb));
  if (!order) {
    slog("courier_unknown_awb", {});
    return null;
  }
  const at = new Date(now).toISOString();
  const before = await db.selectFrom("shipment_tracking").select(["status"]).where("awb", "=", awb).executeTakeFirst();
  const values = {
    courier: parsed.courier ?? null,
    status: parsed.status,
    status_label: parsed.statusLabel ?? null,
    etd: parsed.etd ?? null,
    delivered_at: parsed.deliveredAt ?? null,
    return_awb: parsed.returnAwb ?? null,
    scans: JSON.stringify(parsed.scans ?? []),
    source,
    last_event_at: parsed.lastEventAt ?? null,
    fetched_at: at,
    updated_at: at,
  };
  await db
    .insertInto("shipment_tracking")
    .values({ awb, order_id: order, ...values, created_at: at })
    .onConflict((oc) => oc.column("awb").doUpdateSet(values))
    .execute();
  if (NOTIFY.has(parsed.status) && before?.status !== parsed.status) {
    await emitPluginEvent("order.delivery_updated", { resource: order, key: `delivery:${awb}:${parsed.status}`, data: { order_id: order, awb, status: parsed.status, at } }, { now: new Date(now) });
  }
  return { awb, orderId: order, status: parsed.status };
}

// A fetch that found nothing still counts as a fetch, so the sweep moves on.
export async function markFetched(awb, now = Date.now()) {
  await db.updateTable("shipment_tracking").set({ fetched_at: new Date(now).toISOString() }).where("awb", "=", awb).execute();
}

export async function dueShipments({ now = Date.now(), limit = SWEEP_LIMIT } = {}) {
  const cutoff = new Date(now - REPOLL_MS).toISOString();
  let open = [];
  try {
    open = await db
      .selectFrom("shipment_tracking")
      .select(["awb", "order_id"])
      .where("status", "in", OPEN_STATUSES)
      .where((eb) => eb.or([eb("fetched_at", "is", null), eb("fetched_at", "<", cutoff)]))
      .orderBy("fetched_at", "asc")
      .limit(limit)
      .execute();
  } catch (e) {
    if (missing(e)) return [];
    throw e;
  }
  const out = open.map((r) => ({ awb: String(r.awb), orderId: String(r.order_id) }));
  if (out.length < limit) {
    const fresh = await db
      .selectFrom("order_fulfillments as f")
      .leftJoin("shipment_tracking as s", "s.awb", "f.tracking_number")
      .select(["f.tracking_number as awb", "f.order_id as order_id"])
      .where("f.tracking_number", "is not", null)
      .where("s.awb", "is", null)
      .orderBy("f.updated_at", "desc")
      .limit(limit - out.length)
      .execute();
    for (const r of fresh) if (AWB_RE.test(String(r.awb))) out.push({ awb: String(r.awb), orderId: String(r.order_id) });
  }
  return out;
}

// ---- the webhook key ------------------------------------------------------------

const keyHash = async (key) => sha256Hex(`${tenantId()}|${key}`);
// both sides are sha256 hex (64 characters), compared in constant time
// (every character is looked at; no node: import, so the order page's block
// can load this file anywhere)
const same = (a, b) => {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
};

async function shiprocketInstall() {
  try {
    return await db.selectFrom("plugin_installs").selectAll().where("plugin_id", "=", PLUGIN_ID).where("status", "<>", "uninstalled").orderBy("installed_at", "desc").executeTakeFirst();
  } catch (e) {
    if (notMigratedYet(e, { table: "plugin_installs" })) return null;
    throw e;
  }
}

// → true only when the presented key matches this store's current key, or the
// previous one inside its overlap. The install must be enabled.
export async function checkWebhookKey(presented, { now = Date.now() } = {}) {
  if (typeof presented !== "string" || presented.length < 16 || presented.length > 200) return false;
  const row = await shiprocketInstall();
  if (!row || row.status !== "enabled" || !row.secrets_enc) return false;
  let k;
  try {
    k = (await decryptJson(row.secrets_enc))?.[KEY_FIELD];
  } catch {
    return false;
  }
  if (!k?.hash) return false;
  const h = await keyHash(presented);
  const current = same(h, k.hash);
  const previous = Boolean(k.prev) && Date.parse(k.prevUntil || "") > now && same(h, k.prev);
  return current || previous;
}

export async function webhookKeyState() {
  const row = await shiprocketInstall();
  if (!row?.secrets_enc) return { set: false, rotatedAt: null };
  try {
    const k = (await decryptJson(row.secrets_enc))?.[KEY_FIELD];
    return { set: Boolean(k?.hash), rotatedAt: k?.rotatedAt ?? null };
  } catch {
    return { set: false, rotatedAt: null };
  }
}

// A new key, shown once. The old one keeps working for KEY_OVERLAP_MS, so
// the founder can paste the new one into Shiprocket without missing updates.
export async function rotateWebhookKey(installId, { actor, now = Date.now() }) {
  const row = await shiprocketInstall();
  if (!row || String(row.id) !== String(installId)) return null;
  let secrets = {};
  try {
    secrets = row.secrets_enc ? await decryptJson(row.secrets_enc) : {};
  } catch {
    throw Object.assign(new Error("secrets unreadable"), { code: "SECRETS_UNAVAILABLE" });
  }
  const key = newToken();
  const old = secrets[KEY_FIELD];
  const at = new Date(now).toISOString();
  secrets[KEY_FIELD] = { hash: await keyHash(key), rotatedAt: at, ...(old?.hash ? { prev: old.hash, prevUntil: new Date(now + KEY_OVERLAP_MS).toISOString() } : {}) };
  // the clear list of which secrets are set keeps its own keys (installs.js)
  const settings = parse(row.settings, {});
  const keys = Object.keys(secrets).sort();
  const r = await db
    .updateTable("plugin_installs")
    .set({ secrets_enc: await encryptJson(secrets), settings: JSON.stringify({ ...settings, __secret_keys: keys }), updated_at: at, updated_by: `${actor?.kind ?? "system"}:${actor?.id ?? ""}` })
    .where("id", "=", row.id)
    .where("updated_at", "=", row.updated_at)
    .executeTakeFirst();
  if (!Number(r?.numUpdatedRows ?? 0)) throw Object.assign(new Error("changed"), { code: "CHANGED" });
  await audit({ actor, action: "apps.shiprocket_token_rotate", resource: String(row.id), diff: { overlap_hours: old?.hash ? KEY_OVERLAP_MS / 3_600_000 : 0 } });
  return { key, rotatedAt: at };
}
