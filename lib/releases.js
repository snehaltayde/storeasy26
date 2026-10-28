// Content releases (Session 36 / BE09). Edge-safe, server-only (imports db).
//
// Model: drafts live where they always did (cms_blocks / cms_pages / the
// tenant's config.brand). A RELEASE is an immutable snapshot of that whole
// content set, canonically serialized and content-hashed. release_state holds
// the single live pointer; publish and rollback are one atomic UPDATE of it
// and never touch drafts. The storefront serves the LIVE release once one
// exists (lib/content/resolve.js); before the first publish it serves drafts,
// which is exactly the pre-S36 behavior. Previews are signed expiring tokens
// that switch one browser (cookie) to draft content — the token never ends up
// in a cacheable published URL.
import { db } from "./db.js";
import { getBlockRow, getContentPage } from "./cms/store.js";
import { BLOCK_KEYS } from "./cms/defaults.js";
import { validateBrand } from "./brand.js";
import { tenantOwnCfg, tenantOwnSecret, tenantId } from "./tenant-context.js";
import { enqueueJob } from "./platform/jobs.js";
import { audit } from "./platform/audit.js";
import { slog } from "./log.js";

const nowIso = () => new Date().toISOString();

// ---- canonical serialization + hash -----------------------------------------

// Deterministic JSON: object keys sorted recursively, so the same content
// always produces the same bytes and therefore the same hash.
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

// ---- snapshot ----------------------------------------------------------------

// Freeze the current DRAFT content set. Only customized blocks are stored
// (defaults keep healing at render, same as drafts); pages are the tenant's
// own rows; brand is the tenant's token set or null (platform default look).
export async function snapshotContent() {
  const blocks = {};
  for (const key of BLOCK_KEYS) {
    const row = await getBlockRow(key);
    if (row) blocks[key] = row.value;
  }
  let pages = [];
  try {
    const rows = await db.selectFrom("cms_pages").selectAll().execute();
    pages = rows
      .map((r) => ({
        slug: r.slug,
        title: r.title,
        description: r.description || "",
        sections: JSON.parse(r.sections || "[]"),
        enabled: !!r.enabled,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  } catch {
    pages = [];
  }
  // v1 content envelope; `theme` joined in S37 (kit pin rides the release so a
  // kit switch is draft-until-publish too — absent key = platform default kit)
  const content = { v: 1, blocks, pages, brand: tenantOwnCfg("brand", null, null) || null, theme: tenantOwnCfg("theme", null, null) || null };
  return { content, canonical: stableStringify(content), hash: await sha256Hex(stableStringify(content)) };
}

// ---- publish validation ------------------------------------------------------

const KNOWN_PATHS = /^\/($|#|\?|collections($|\/)|products\/|search($|\?)|about$|contact$|policies\/|orders\/|cart$)/;

async function checkInternalLink(href, errors, warnings, where) {
  const h = String(href || "");
  if (!h || h.startsWith("#") || /^https?:\/\//.test(h)) return;
  if (!h.startsWith("/")) {
    errors.push(`${where}: link "${h}" must be a path (/…), #anchor or full URL`);
    return;
  }
  const m = /^\/(collections|products)\/([^/?#]+)/.exec(h);
  if (m) {
    const table = m[1] === "collections" ? "collections" : "products";
    const row = await db.selectFrom(table).select("handle").where("handle", "=", decodeURIComponent(m[2])).executeTakeFirst();
    if (!row) errors.push(`${where}: "${h}" points at a ${table.slice(0, -1)} that doesn't exist in the catalog`);
    return;
  }
  if (!KNOWN_PATHS.test(h)) warnings.push(`${where}: "${h}" isn't a storefront route this platform serves — double-check it`);
}

// Blocking errors stop a publish; warnings ride along in the result.
export async function validateRelease(content) {
  const errors = [];
  const warnings = [];
  const b = content.blocks || {};

  // required slots
  if (b.hero && !String(b.hero.title || "").trim()) errors.push("Hero: a published hero needs a title");
  if (b.home_sections && !b.home_sections.some((s) => s.enabled !== false)) errors.push("Home sections: at least one section must be enabled");

  // brand contrast re-gated at publish (belt and braces over the save gate)
  if (content.brand) {
    const r = validateBrand(content.brand);
    if (!r.ok) errors.push(...r.errors.map((e) => `Brand: ${e}`));
    warnings.push(...(r.warnings || []).map((w) => `Brand: ${w}`));
  }

  // links: hero CTAs, announcement, nav items, page section bodies don't carry links
  if (b.hero?.primary) await checkInternalLink(b.hero.primary.href, errors, warnings, "Hero primary CTA");
  if (b.hero?.secondary) await checkInternalLink(b.hero.secondary.href, errors, warnings, "Hero secondary CTA");
  if (b.announcement?.enabled) await checkInternalLink(b.announcement.href, errors, warnings, "Announcement");
  for (const which of ["nav_header", "nav_footer"]) {
    for (const item of Array.isArray(b[which]) ? b[which] : []) {
      await checkInternalLink(item.href, errors, warnings, `${which === "nav_header" ? "Header" : "Footer"} nav "${item.label}"`);
    }
  }
  return { ok: !errors.length, errors, warnings };
}

// ---- release rows + the live pointer ----------------------------------------

const relId = () => "rel_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

export async function getLiveRelease() {
  try {
    const state = await db.selectFrom("release_state").select("live_release_id").where("id", "=", 1).executeTakeFirst();
    if (!state?.live_release_id) return null;
    const row = await db.selectFrom("releases").selectAll().where("id", "=", state.live_release_id).executeTakeFirst();
    if (!row) return null;
    return { id: row.id, content: JSON.parse(row.content), content_hash: row.content_hash, published_at: row.published_at, note: row.note };
  } catch {
    return null; // pre-migration tenant → drafts serve, as always
  }
}

export async function listReleases({ limit = 20 } = {}) {
  const [rows, state] = await Promise.all([
    db.selectFrom("releases").select(["id", "content_hash", "note", "created_by", "created_at", "scheduled_for", "published_at"]).orderBy("created_at", "desc").limit(Math.min(limit, 100)).execute(),
    db.selectFrom("release_state").select(["live_release_id", "updated_at"]).where("id", "=", 1).executeTakeFirst(),
  ]);
  return { releases: rows.map((r) => ({ ...r })), live: state?.live_release_id || null, liveSince: state?.updated_at || null };
}

async function flipPointer(releaseId) {
  const now = nowIso();
  await db.updateTable("release_state").set({ live_release_id: releaseId, updated_at: now }).where("id", "=", 1).execute();
  // first time this release goes live → stamp it
  await db.updateTable("releases").set({ published_at: now }).where("id", "=", releaseId).where("published_at", "is", null).execute();
}

// Create an immutable release from the current drafts. scheduledFor (UTC ISO)
// defers the pointer flip to the jobs queue; otherwise it flips now.
export async function createRelease({ note = "", actor = null, scheduledFor = null } = {}) {
  const snap = await snapshotContent();
  const validation = await validateRelease(snap.content);
  if (!validation.ok) {
    const err = new Error(validation.errors.join(" · "));
    err.code = "RELEASE_INVALID";
    err.errors = validation.errors;
    err.warnings = validation.warnings;
    throw err;
  }
  const id = relId();
  await db
    .insertInto("releases")
    .values({ id, content: snap.canonical, content_hash: snap.hash, note: String(note || "").slice(0, 300), created_by: actor?.id || null, created_at: nowIso(), scheduled_for: scheduledFor })
    .execute();

  if (scheduledFor) {
    await enqueueJob({
      type: "publish_release",
      tenantId: tenantId() || null,
      payload: { releaseId: id },
      idempotencyKey: `publish_${id}`,
      runAfter: scheduledFor,
    });
    slog("release_scheduled", { release: id, at: scheduledFor });
    await audit({ actor, action: "release.schedule", resource: `release:${id}`, diff: { hash: snap.hash.slice(0, 12), at: scheduledFor } });
    return { id, hash: snap.hash, scheduledFor, warnings: validation.warnings };
  }

  await flipPointer(id);
  slog("release_published", { release: id, hash: snap.hash.slice(0, 12) });
  await audit({ actor, action: "release.publish", resource: `release:${id}`, diff: { hash: snap.hash.slice(0, 12) } });
  return { id, hash: snap.hash, publishedAt: nowIso(), warnings: validation.warnings };
}

// Flip a previously created (scheduled) release live — the worker's entry.
export async function publishReleaseById(releaseId) {
  const row = await db.selectFrom("releases").select(["id"]).where("id", "=", releaseId).executeTakeFirst();
  if (!row) throw new Error(`release ${releaseId} not found`);
  await flipPointer(releaseId);
  slog("release_published", { release: releaseId, scheduled: true });
  return { id: releaseId, publishedAt: nowIso() };
}

// Point live back at an EXISTING release. Drafts are untouched — whatever is
// mid-edit stays mid-edit.
export async function rollbackRelease(releaseId, { actor = null } = {}) {
  const row = await db.selectFrom("releases").select(["id", "content_hash"]).where("id", "=", releaseId).executeTakeFirst();
  if (!row) throw new Error(`release ${releaseId} not found`);
  await flipPointer(releaseId);
  slog("release_rollback", { release: releaseId });
  await audit({ actor, action: "release.rollback", resource: `release:${releaseId}`, diff: { hash: row.content_hash.slice(0, 12) } });
  return { id: releaseId };
}

// ---- preview tokens ----------------------------------------------------------

// `p.<expEpochSecs>.<hmac20>` over tenant|exp — tenant-bound, expiring, HMAC'd
// with the tenant's own link secret (domain-separated from order proofs).
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

export async function previewToken({ now = Date.now() } = {}) {
  const exp = Math.floor((now + PREVIEW_TTL_MS) / 1000);
  return `p.${exp}.${await hmac20(`${tenantId() || "_default"}|${exp}`, previewSecret())}`;
}

export async function verifyPreviewToken(token, { now = Date.now() } = {}) {
  const m = /^p\.(\d{1,12})\.([0-9a-f]{20})$/.exec(String(token || ""));
  if (!m) return false;
  const exp = Number(m[1]);
  if (now > exp * 1000) return false;
  const expect = await hmac20(`${tenantId() || "_default"}|${exp}`, previewSecret());
  return timingSafeEqualStr(m[2], expect);
}
