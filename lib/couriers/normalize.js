// Phase 9 line 4: Shiprocket's answers in Storeasy's words. Pure: no I/O.
//   normalizeStatus(label)          → one of STATUSES
//   parseTrack(json)                → { courier, status, statusLabel, etd, deliveredAt, returnAwb, scans, trackUrl } | null
//   parseServiceability(json)       → { serviceable, cod, minDays, maxDays } | null (unreadable)
//   shiprocketTime("2026-11-27 10:15:00") → ISO 8601 UTC (Shiprocket's times are India time)
// Scans keep only time, hub and activity, with names and phone numbers taken
// out of the activity words; at most MAX_SCANS, the newest kept.
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
// "Delivered to Ramesh Kumar 9876543210" → "Delivered"; "call +91 98765 43210" → "call"
export function scrubActivity(s) {
  let out = clip(s, 200);
  out = out.replace(/\b(delivered|received|handed over|collected|accepted|signed)\s+(to|by)\b.*$/i, "$1");
  out = out.replace(/(\+?\d[\d\s-]{6,}\d)/g, "").replace(/\b(call|contact|phone|mobile)\s*:?\s*$/i, "").replace(/\s+([,.;:])/g, "$1");
  return out.replace(/[\s,;:-]+$/, "").trim().slice(0, 120);
}

export function parseTrack(json) {
  const td = json?.tracking_data;
  if (!td || typeof td !== "object") return null;
  const head = Array.isArray(td.shipment_track) && td.shipment_track[0] && typeof td.shipment_track[0] === "object" ? td.shipment_track[0] : {};
  const acts = Array.isArray(td.shipment_track_activities) ? td.shipment_track_activities.filter((a) => a && typeof a === "object") : [];
  const scans = acts
    .map((a) => ({ at: shiprocketTime(a.date), hub: clip(a.location, 80) || null, activity: scrubActivity(a.activity || a["sr-status-label"] || a.status) || null }))
    .filter((x) => x.at)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .slice(-MAX_SCANS);
  const label = clip(head.current_status || acts[0]?.["sr-status-label"] || "", 60);
  if (!label && !scans.length) return null;
  const status = normalizeStatus(label);
  const rto = clip(head.rto_awb || "", 40);
  return {
    courier: clip(head.courier_name, 60) || null,
    status,
    statusLabel: label || null,
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
