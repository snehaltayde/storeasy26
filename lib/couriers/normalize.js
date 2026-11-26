// Phase 9 line 4: Shiprocket's answers in Storeasy's words. Pure: no I/O.
//   normalizeStatus(label)          → one of STATUSES
//   parseTrack(json)                → { courier, status, statusLabel, etd, deliveredAt, returnAwb, scans, trackUrl } | null
//   parseServiceability(json)       → { serviceable, cod, minDays, maxDays } | null (unreadable)
//   shiprocketTime("2026-11-27 10:15:00") → ISO 8601 UTC (Shiprocket's times are India time)
// Scans keep only time, hub and Shiprocket's status label (as "activity"); the
// courier's free-text activity is never kept. At most MAX_SCANS, the newest kept.
export const STATUSES = Object.freeze(["placed", "in_transit", "out_for_delivery", "delivered", "returning", "cancelled", "exception"]);
export const OPEN_STATUSES = Object.freeze(["placed", "in_transit", "out_for_delivery", "returning", "exception"]);
export const MAX_SCANS = 50;
export const AWB_RE = /^[A-Za-z0-9-]{4,40}$/;

export function normalizeStatus(label) {
  const s = String(label ?? "").toUpperCase().replace(/[_-]+/g, " ").trim();
  if (!s) return "placed";
  if (/\bRTO\b|RETURN/.test(s)) return "returning";
  if (/CANCEL/.test(s)) return "cancelled";
  if (/OUT FOR DELIVERY/.test(s)) return "out_for_delivery";
  if (/UNDELIVERED|NOT DELIVERED/.test(s)) return "exception";
  if (/DELIVERED/.test(s)) return "delivered";
  if (/LOST|DAMAGE|DESTROY|MISROUTE|DISPOSE|EXCEPTION|NDR|DELAY|HELD|ON HOLD/.test(s)) return "exception";
  if (/^NEW$|AWB ASSIGNED|PICKUP SCHEDULED|PICKUP GENERATED|PICKUP QUEUED|OUT FOR PICKUP|MANIFEST|LABEL GENERATED|READY TO SHIP|PICKUP RESCHEDULED|PICKUP ERROR|PENDING/.test(s)) return "placed";
  return "in_transit";
}

// Shiprocket writes "YYYY-MM-DD HH:MM[:SS]" in India time (UTC+05:30)
export function shiprocketTime(v) {
  if (v == null || v === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(v).trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) - 330 * 60_000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const clip = (s, n) => String(s ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, n);
// A scan's words are Shiprocket's own status label ("OUT FOR DELIVERY" →
// "Out for delivery"), never the courier's free-text activity, which can name
// the recipient or the sender ("Consignee Ramesh Kumar not available"). No
// label: the plain words for the status the activity maps to.
export const STATUS_WORDS = Object.freeze({
  placed: "Waiting for pickup",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  returning: "Returning to the store",
  cancelled: "Cancelled",
  exception: "Delayed",
});
// Shiprocket's own status vocabulary. A label outside it (a courier's text
// that names someone, "DELIVERED TO RAMESH 9876543210") is never kept: the
// plain words for its status are used instead.
export const KNOWN_LABELS = Object.freeze(new Set([
  "NEW", "INVOICED", "READY TO SHIP", "AWB ASSIGNED", "LABEL GENERATED", "MANIFEST GENERATED", "PICKUP SCHEDULED", "PICKUP GENERATED", "PICKUP QUEUED",
  "PICKUP RESCHEDULED", "PICKUP ERROR", "PICKUP EXCEPTION", "OUT FOR PICKUP", "PICKED UP", "SHIPPED", "IN TRANSIT", "IN FLIGHT", "REACHED AT DESTINATION HUB",
  "REACHED DESTINATION HUB", "REACHED WAREHOUSE", "MISROUTED", "DELAYED", "OUT FOR DELIVERY", "DELIVERED", "PARTIAL DELIVERED", "UNDELIVERED", "CONTACT CUSTOMER CARE",
  "CANCELED", "CANCELLED", "CANCELLATION REQUESTED", "RTO INITIATED", "RTO IN TRANSIT", "RTO OFD", "RTO NDR", "RTO DELIVERED", "RTO ACKNOWLEDGED", "LOST", "DAMAGED",
  "DESTROYED", "DISPOSED OFF", "HANDOVER TO COURIER", "SELF FULFILLED", "FULFILLED", "CUSTOMS CLEARED",
]));
// → the known label in upper case, or null
export function knownLabel(label) {
  const s = String(label ?? "").toUpperCase().replace(/[^A-Z ]+/g, " ").replace(/\s+/g, " ").trim();
  return KNOWN_LABELS.has(s) ? s : null;
}
// "OUT FOR DELIVERY" → "Out for delivery"; null when not a known label
export function labelWords(label) {
  const s = knownLabel(label);
  return s ? s.charAt(0) + s.slice(1).toLowerCase() : null;
}
const scanWords = (a) => labelWords(a["sr-status-label"]) || STATUS_WORDS[normalizeStatus(a["sr-status-label"] || a.activity)];

export function parseTrack(json) {
  const td = json?.tracking_data;
  if (!td || typeof td !== "object") return null;
  const head = Array.isArray(td.shipment_track) && td.shipment_track[0] && typeof td.shipment_track[0] === "object" ? td.shipment_track[0] : {};
  const acts = Array.isArray(td.shipment_track_activities) ? td.shipment_track_activities.filter((a) => a && typeof a === "object") : [];
  const scans = acts
    .map((a) => ({ at: shiprocketTime(a.date), hub: clip(a.location, 80) || null, activity: scanWords(a) }))
    .filter((x) => x.at)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .slice(-MAX_SCANS);
  const raw = String(head.current_status || acts[0]?.["sr-status-label"] || "").trim();
  if (!raw && !scans.length) return null;
  const status = normalizeStatus(raw);
  const label = knownLabel(raw) || STATUS_WORDS[status];
  const rto = clip(head.rto_awb || "", 40);
  return {
    courier: clip(head.courier_name, 60) || null,
    status,
    statusLabel: label,
    etd: shiprocketTime(td.etd) || shiprocketTime(head.edd),
    deliveredAt: status === "delivered" ? shiprocketTime(head.delivered_date) || scans.at(-1)?.at || null : null,
    returnAwb: AWB_RE.test(rto) ? rto : null,
    scans,
    lastEventAt: scans.at(-1)?.at ?? null,
  };
}

const days = (v) => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isInteger(n) && n >= 0 && n <= 60 ? n : null;
};

export function parseServiceability(json) {
  if (!json || typeof json !== "object") return null;
  const list = json?.data?.available_courier_companies;
  if (!Array.isArray(list)) return Number(json.status) === 404 ? { serviceable: false, cod: false, minDays: null, maxDays: null } : null;
  const ds = list.map((c) => days(c?.estimated_delivery_days)).filter((d) => d != null);
  if (!list.length) return { serviceable: false, cod: false, minDays: null, maxDays: null };
  return { serviceable: true, cod: list.some((c) => Number(c?.cod) === 1), minDays: ds.length ? Math.min(...ds) : null, maxDays: ds.length ? Math.max(...ds) : null };
}
