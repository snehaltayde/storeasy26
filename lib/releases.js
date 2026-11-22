// Content releases (Documents-only v4). Edge-safe, server-only (imports db).
//
// Reads the live v4 release pointer (`release_state` JOIN `releases`),
// computes the publishing badge count, lists release history, and signs/verifies
// expiring tenant-bound preview tokens. Writes live in lib/documents/commit.js.
import { db } from "./db.js";
import { publishBadgeState, DOCUMENTS_MESSAGE } from "./cms-mode.js";
import { tenantOwnSecret, tenantId } from "./tenant-context.js";
import { notMigratedYet } from "./schema-shape.js";

// ---- canonical serialization + hash -----------------------------------------

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- live release pointer ---------------------------------------------------

export const LEGACY_RELEASE_VERSIONS = Object.freeze([]);
export const DOCUMENTS_RELEASE_VERSION = 4;

export async function getLiveReleaseState() {
  let row;
  try {
    row = await db
      .selectFrom("release_state as s")
      .leftJoin("releases as r", "r.id", "s.live_release_id")
      .select([
        "s.live_release_id as live_release_id",
        "r.id as id",
        "r.content as content",
        "r.content_hash as content_hash",
        "r.published_at as published_at",
        "r.note as note",
      ])
      .where("s.id", "=", 1)
      .executeTakeFirst();
  } catch (e) {
    const msg = String(e?.message || e);
    return notMigratedYet(e, { table: "release_state" }) ? { state: "none", unmigrated: true } : { state: "error", error: msg.slice(0, 200) };
  }
  if (!row?.live_release_id) return { state: "none" };
  if (row.id == null) return { state: "error", error: `live pointer ${row.live_release_id} has no release row` };

  let content;
  try {
    content = JSON.parse(row.content);
  } catch {
    return { state: "error", error: `release ${row.id} content is not valid JSON` };
  }
  if (!content || typeof content !== "object" || Array.isArray(content) || content.v !== DOCUMENTS_RELEASE_VERSION) {
    return { state: "error", error: `release ${row.id} has an unsupported envelope version (${JSON.stringify(content?.v).slice(0, 40)})` };
  }
  return {
    state: "live",
    release: { id: row.id, content, content_hash: row.content_hash, published_at: row.published_at, note: row.note, v: content.v },
  };
}

export async function getLiveRelease() {
  const s = await getLiveReleaseState();
  if (s.state !== "live") return null;
  const r = s.release;
  return {
    id: r.id,
    v: DOCUMENTS_RELEASE_VERSION,
    documents: true,
    content: null,
    content_hash: r.content_hash,
    published_at: r.published_at,
    note: r.note,
    message: DOCUMENTS_MESSAGE,
  };
}

export async function publishingBadge() {
  const b = await publishBadgeState();
  return b.dirty > 0 ? b.dirty : null;
}

export async function listReleases({ limit = 20 } = {}) {
  const [rows, state] = await Promise.all([
    db
      .selectFrom("releases")
      .select(["id", "content_hash", "note", "created_by", "created_at", "scheduled_for", "published_at"])
      .where((eb) =>
        eb.or([
          eb("published_at", "is not", null),
          eb("scheduled_for", "is not", null),
          eb("id", "in", eb.selectFrom("release_state").select("live_release_id").where("id", "=", 1)),
        ]),
      )
      .orderBy("created_at", "desc")
      .limit(Math.min(limit, 100))
      .execute(),
    db.selectFrom("release_state").select(["live_release_id", "updated_at"]).where("id", "=", 1).executeTakeFirst(),
  ]);
  return { releases: rows.map((r) => ({ ...r })), live: state?.live_release_id || null, liveSince: state?.updated_at || null };
}

// ---- preview tokens ---------------------------------------------------------

const PREVIEW_TTL_MS = 60 * 60 * 1000; // 1h

function previewSecret() {
  const base =
    tenantOwnSecret("order_link_secret", "ORDER_LINK_SECRET") ||
    tenantOwnSecret("razorpay_key_secret", "RAZORPAY_KEY_SECRET") ||
    "dev-only-secret";
  return `${base}|preview`;
}

async function hmac20(message, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 20);
}

function timingSafeEqualStr(a, b) {
  const A = String(a);
  const B = String(b);
  if (!A.length || !B.length) return false;
  let diff = A.length ^ B.length;
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) diff |= (A.charCodeAt(i % A.length) || 0) ^ (B.charCodeAt(i % B.length) || 0);
  return diff === 0;
}

export const PREVIEW_SID_RE = /^ps_[0-9a-f]{16}$/;

export async function previewToken({ now = Date.now(), sid = null, exp: expAt = null } = {}) {
  const exp = expAt ?? Math.floor((now + PREVIEW_TTL_MS) / 1000);
  if (sid != null) {
    if (!PREVIEW_SID_RE.test(String(sid))) throw new Error("previewToken: a sid must look like ps_<16 hex>");
    return `p.${exp}.${sid}.${await hmac20(`${tenantId() || "_default"}|${exp}|${sid}`, previewSecret())}`;
  }
  return `p.${exp}.${await hmac20(`${tenantId() || "_default"}|${exp}`, previewSecret())}`;
}

export async function readPreviewToken(token, { now = Date.now() } = {}) {
  const m = /^p\.(\d{1,12})\.(?:(ps_[0-9a-f]{16})\.)?([0-9a-f]{20})$/.exec(String(token || ""));
  if (!m) return null;
  const exp = Number(m[1]);
  if (now > exp * 1000) return null;
  const sid = m[2] || null;
  const message = sid ? `${tenantId() || "_default"}|${exp}|${sid}` : `${tenantId() || "_default"}|${exp}`;
  const expect = await hmac20(message, previewSecret());
  return timingSafeEqualStr(m[3], expect) ? { exp, sid } : null;
}

export async function verifyPreviewToken(token, opts = {}) {
  return (await readPreviewToken(token, opts)) !== null;
}
