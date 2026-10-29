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
import { getBlockRow, getContentPage, brandDefaultsApply } from "./cms/store.js";
import { BLOCK_KEYS } from "./cms/defaults.js";
import { validateBrand } from "./brand.js";
import { tenantOwnCfg, tenantOwnSecret, tenantId } from "./tenant-context.js";
import { enqueueJob, cancelPendingJob } from "./platform/jobs.js";
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
        effective_at: r.effective_at || null,
        family: r.family || "page",
        window_start: r.window_start || null,
        window_end: r.window_end || null,
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

// S52: journal/quiz/bundles/wishlist/account joined — links to them used to
// raise false "isn't a storefront route" warnings on every publish.
const KNOWN_PATHS = /^\/($|#|\?|collections($|\/)|products\/|search($|\?)|about$|contact$|policies\/|campaigns\/|orders\/|cart$|journal($|\/)|quiz\/|bundles\/|wishlist$|account($|\/))/;

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
      const where = `${which === "nav_header" ? "Header" : "Footer"} nav "${item.label}"`;
      await checkInternalLink(item.href, errors, warnings, where);
      for (const c of item.children || []) await checkInternalLink(c.href, errors, warnings, `${where} → "${c.label}"`);
    }
  }
  // S38: banner sections carry links too
  for (const [i, s] of (Array.isArray(b.home_sections) ? b.home_sections : []).entries()) {
    if (s?.kind === "banner" && s.href) await checkInternalLink(s.href, errors, warnings, `Home section ${i + 1} (banner)`);
  }
  // S38 (SF02): curated collection handles must exist in the catalog
  const ci = b.collections_index;
  if (ci) {
    for (const [label, list] of [["Featured", ci.featured], ["Ordered", ci.order]]) {
      for (const h of Array.isArray(list) ? list : []) {
        const row = await db.selectFrom("collections").select("handle").where("handle", "=", h).executeTakeFirst();
        if (!row) errors.push(`Collections index: ${label.toLowerCase()} handle "${h}" isn't a collection in the catalog`);
      }
    }
  }
  // S38 (SF14): a store selling to the public should publish its legal pages —
  // warn (not block) when none of privacy/terms/refund-ish pages is enabled.
  const pages = Array.isArray(content.pages) ? content.pages : [];
  const hasPolicy = (re) => pages.some((p) => p.enabled && re.test(p.slug));
  if (!brandDefaultsApply()) {
    if (!hasPolicy(/privacy/)) warnings.push("No enabled privacy policy page — add one before launch (checkout links to it)");
    if (!hasPolicy(/terms|refund|return/)) warnings.push("No enabled terms/refund page — add one before launch");
  }
  return { ok: !errors.length, errors, warnings };
}

// S52: the per-item answer to "what will publishing change?" — the draft
// snapshot compared against the LIVE release's content, item by item. The
// single dirty hash stays authoritative; this names the pieces behind it.
export async function releaseDiff() {
  const [snap, live] = await Promise.all([snapshotContent(), getLiveRelease()]);
  const liveC = live?.content || { blocks: {}, pages: [], brand: null, theme: null };
  const same = (a, b) => stableStringify(a ?? null) === stableStringify(b ?? null);
  const items = [];
  for (const key of BLOCK_KEYS) {
    const d = snap.content.blocks[key];
    const l = liveC.blocks?.[key];
    if (d !== undefined && l === undefined) items.push({ type: "block", key, change: "customized" });
    else if (d === undefined && l !== undefined) items.push({ type: "block", key, change: "reset" });
    else if (d !== undefined && l !== undefined && !same(d, l)) items.push({ type: "block", key, change: "edited" });
  }
  const livePages = new Map((liveC.pages || []).map((p) => [p.slug, p]));
  for (const p of snap.content.pages) {
    const l = livePages.get(p.slug);
    if (!l) items.push({ type: "page", key: p.slug, change: "added", family: p.family });
    else if (!same(p, l)) items.push({ type: "page", key: p.slug, change: "edited", family: p.family });
    livePages.delete(p.slug);
  }
  for (const [slug, l] of livePages) items.push({ type: "page", key: slug, change: "removed", family: l.family || "page" });
  if (!same(snap.content.brand, liveC.brand))
    items.push({ type: "brand", key: "brand", change: liveC.brand == null ? "customized" : snap.content.brand == null ? "reset" : "edited" });
  if (!same(snap.content.theme, liveC.theme)) items.push({ type: "theme", key: "theme", change: "edited" });
  return {
    firstPublish: !live,
    dirty: !live || live.content_hash !== snap.hash,
    draftHash: snap.hash,
    liveHash: live?.content_hash || null,
    items,
  };
}

// ---- release rows + the live pointer ----------------------------------------

const relId = () => "rel_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

// S53 (audit A2): three DISTINCT states, so a read failure can never read as
// "no release yet" and leak drafts to shoppers:
//   { state:"live",  release } — a validated published snapshot
//   { state:"none" }           — genuinely pre-first-publish (release tables
//                                absent = pre-migration tenant, or no pointer)
//   { state:"error", error }   — query failure, a pointer with no release
//                                row, or corrupt/unparseable content
const MISSING_TABLE_RE = /no such table/i;

export async function getLiveReleaseState() {
  let state;
  try {
    state = await db.selectFrom("release_state").select("live_release_id").where("id", "=", 1).executeTakeFirst();
  } catch (e) {
    const msg = String(e?.message || e);
    // the release tables not existing yet IS the pre-first-publish state
    return MISSING_TABLE_RE.test(msg) ? { state: "none" } : { state: "error", error: msg.slice(0, 200) };
  }
  if (!state?.live_release_id) return { state: "none" };

  let row;
  try {
    row = await db.selectFrom("releases").selectAll().where("id", "=", state.live_release_id).executeTakeFirst();
  } catch (e) {
    return { state: "error", error: String(e?.message || e).slice(0, 200) };
  }
  // a live pointer with no release row is corruption, never "no release yet"
  if (!row) return { state: "error", error: `live pointer ${state.live_release_id} has no release row` };

  let content;
  try {
    content = JSON.parse(row.content);
  } catch {
    return { state: "error", error: `release ${row.id} content is not valid JSON` };
  }
  if (!content || typeof content !== "object" || !content.v) {
    return { state: "error", error: `release ${row.id} content has no envelope version` };
  }
  return {
    state: "live",
    release: { id: row.id, content, content_hash: row.content_hash, published_at: row.published_at, note: row.note },
  };
}

// Compat wrapper for ADMIN/operator surfaces that only badge state (error →
// null is acceptable there). The SHOPPER path uses getLiveReleaseState via
// lib/content/resolve.js and fails closed on "error".
export async function getLiveRelease() {
  const s = await getLiveReleaseState();
  return s.state === "live" ? s.release : null;
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

// S52: cancel a scheduled release before it flips live. The queue job goes
// first (only 'pending' jobs are deletable — a leased/done job means the
// publish is happening or happened, so we refuse), then the never-published
// release row is removed. Legacy/env mode without a control plane has no
// queue row; the release-row guard alone decides there.
export async function cancelScheduledRelease(releaseId, { actor = null } = {}) {
  const row = await db
    .selectFrom("releases")
    .select(["id", "published_at", "scheduled_for"])
    .where("id", "=", releaseId)
    .executeTakeFirst();
  const refuse = (msg, status) => {
    const e = new Error(msg);
    e.status = status;
    throw e;
  };
  if (!row) refuse(`release ${releaseId} not found`, 404);
  if (!row.scheduled_for) refuse("not a scheduled release", 409);
  if (row.published_at) refuse("already published — use rollback instead", 409);
  let job = { found: false, cancelled: false };
  try {
    job = await cancelPendingJob(`publish_${releaseId}`);
  } catch {
    /* no control plane (legacy mode) — the row guard below decides */
  }
  if (job.found && !job.cancelled) refuse(`publish job is already ${job.status} — too late to cancel`, 409);
  const del = await db.deleteFrom("releases").where("id", "=", releaseId).where("published_at", "is", null).executeTakeFirst();
  if (Number(del?.numDeletedRows ?? 0) === 0) refuse("release was published while cancelling", 409);
  slog("release_schedule_cancelled", { release: releaseId });
  await audit({ actor, action: "release.cancel", resource: `release:${releaseId}`, diff: { scheduled_for: row.scheduled_for } });
  return { id: releaseId, cancelled: true };
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
