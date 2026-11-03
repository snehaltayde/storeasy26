// Content releases (Session 36 / BE09). Edge-safe, server-only (imports db).
//
// Model: drafts live where they always did (cms_blocks / cms_pages / the
// tenant's config.brand). A RELEASE is an immutable snapshot of that whole
// content set, canonically serialized and content-hashed. release_state holds
// the single live pointer. P2-GUARD: publish, rollback and the scheduled flip
// are ONE write batch each (the release row when it is new, a guarded
// compare-and-set of the pointer, an abort when the pointer moved, and the
// published_at stamp), so a lost race or a failed stamp leaves nothing
// behind. They never touch drafts. The storefront serves the LIVE release once one
// exists (lib/content/resolve.js); before the first publish it serves drafts,
// which is exactly the pre-S36 behavior. Previews are signed expiring tokens
// that switch one browser (cookie) to draft content — the token never ends up
// in a cacheable published URL.
import { db, libsql } from "./db.js";
import { getCmsMode, assertLegacyContentWrites, publishBadgeState, StoreUsesDocumentsError, DOCUMENTS_MESSAGE } from "./cms-mode.js";
import { getBlockRow, getContentPage, brandDefaultsApply } from "./cms/store.js";
import { BLOCK_KEYS } from "./cms/defaults.js";
import { validateBrand, checkBrand } from "./brand.js";
import { kitAttr } from "./themes/kits.js";
import { tenantOwnCfg, tenantOwnSecret, tenantId } from "./tenant-context.js";
import { enqueueJob, cancelPendingJob } from "./platform/jobs.js";
import { audit } from "./platform/audit.js";
import { slog } from "./log.js";
import { issue, errorIssues, warningIssues, messagesOf, NotFoundError, HERO_SECTION_ID } from "./cms/issues.js";
import { notMigratedYet } from "./schema-shape.js";

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
  // S53 (0B-1): STRICT reads — a transient failure must never slip a partial
  // snapshot into an immutable release ("missing table" alone still means a
  // genuinely pre-migration tenant and reads as empty).
  const blocks = {};
  for (const key of BLOCK_KEYS) {
    const row = await getBlockRow(key, { strict: true });
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
  } catch (e) {
    // P1-FIX-C: only cms_pages itself missing reads as empty, not any table a
    // view or trigger names
    if (!notMigratedYet(e, { table: "cms_pages" })) {
      // DOC-04: `cause` keeps the database error, so the route answers 5xx
      throw new Error(`release snapshot failed reading pages: ${String(e?.message || e).slice(0, 200)}`, { cause: e });
    }
    pages = []; // pre-migration tenant
  }
  // S53 (0B-2): the OTHER presentation tables join the snapshot — product
  // modules/badges, collection pins, upsell placements and slug redirects
  // used to go live on save, outside preview/publish/rollback entirely.
  // Same strictness: only that table being missing reads as empty.
  const tableRows = async (label, table, fn) => {
    try {
      return await fn();
    } catch (e) {
      if (!notMigratedYet(e, { table })) {
        throw new Error(`release snapshot failed reading ${label}: ${String(e?.message || e).slice(0, 200)}`, { cause: e });
      }
      return [];
    }
  };
  const parseJson = (s, fallback) => {
    try {
      return JSON.parse(s ?? "");
    } catch {
      return fallback;
    }
  };
  const product_overrides = (
    await tableRows("product overrides", "product_overrides", () => db.selectFrom("product_overrides").selectAll().execute())
  )
    .map((r) => ({ product_id: r.product_id, modules: parseJson(r.modules, []), badge: r.badge || "" }))
    .sort((a, b) => a.product_id.localeCompare(b.product_id));
  const collection_pins = (
    await tableRows("collection pins", "collection_overrides", () => db.selectFrom("collection_overrides").selectAll().execute())
  )
    .map((r) => ({ collection_id: r.collection_id, pinned: parseJson(r.pinned, []) }))
    .filter((r) => r.pinned.length)
    .sort((a, b) => a.collection_id.localeCompare(b.collection_id));
  const placements = (await tableRows("placements", "placements", () => db.selectFrom("placements").selectAll().execute()))
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      source_product_id: r.source_product_id || null,
      target_product_ids: parseJson(r.target_product_ids, []),
      title: r.title || null,
      enabled: !!r.enabled,
      position: r.position ?? 0,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const redirects = (await tableRows("redirects", "page_redirects", () => db.selectFrom("page_redirects").selectAll().execute()))
    .map((r) => ({ from_slug: r.from_slug, to_slug: r.to_slug }))
    .sort((a, b) => a.from_slug.localeCompare(b.from_slug));

  // v2 envelope (S53): presentation is complete. v1 releases keep rendering —
  // readers fall back to live tables for the sets a v1 snapshot never froze.
  // v3 (S54): sections carry durable instance ids (readers tolerate id-less).
  const content = {
    v: 3,
    blocks,
    pages,
    brand: tenantOwnCfg("brand", null, null) || null,
    theme: tenantOwnCfg("theme", null, null) || null,
    product_overrides,
    collection_pins,
    placements,
    redirects,
  };
  return { content, canonical: stableStringify(content), hash: await sha256Hex(stableStringify(content)) };
}

// ---- publish validation ------------------------------------------------------

// S52: journal/quiz/bundles/wishlist/account joined — links to them used to
// raise false "isn't a storefront route" warnings on every publish.
const KNOWN_PATHS = /^\/($|#|\?|collections($|\/)|products\/|search($|\?)|about$|contact$|policies\/|campaigns\/|orders\/|cart$|journal($|\/)|quiz\/|bundles\/|wishlist$|account($|\/))/;

// DOC-04: `at` is where the link lives ({ documentId, sectionId, field }) and
// `subject` names it in the founder's words ("the primary button", "“Shop”").
// The message never carries a position; the reader works it out from the ids.
// With a subject the message is one sentence ("“Shop” links to "/x", which
// isn't …"), so the worded line has one colon, after the place, not two.
async function checkInternalLink(href, report, at, subject = "") {
  const h = String(href || "");
  if (!h || h.startsWith("#") || /^https?:\/\//.test(h)) return;
  if (!h.startsWith("/")) {
    report("error", at, "LINK_INVALID", subject ? `${subject} links to "${h}", but a link must be a path (/…), #anchor or full URL` : `link "${h}" must be a path (/…), #anchor or full URL`);
    return;
  }
  const m = /^\/(collections|products)\/([^/?#]+)/.exec(h);
  if (m) {
    const table = m[1] === "collections" ? "collections" : "products";
    const row = await db.selectFrom(table).select("handle").where("handle", "=", decodeURIComponent(m[2])).executeTakeFirst();
    const kind = table.slice(0, -1);
    if (!row) report("error", at, "LINK_MISSING_TARGET", subject ? `${subject} links to "${h}", a ${kind} that doesn't exist in the catalog` : `"${h}" points at a ${kind} that doesn't exist in the catalog`);
    return;
  }
  if (!KNOWN_PATHS.test(h)) {
    const doubt = "isn't a storefront route this platform serves — double-check it";
    report("warning", at, "LINK_UNKNOWN_ROUTE", subject ? `${subject} links to "${h}", which ${doubt}` : `"${h}" ${doubt}`);
  }
}

// Blocking errors stop a publish; warnings ride along in the result.
// DOC-04: { ok, issues, errors, warnings, sections }. `issues` is the
// structured list (same shape as save and preview); `errors` and `warnings`
// are its messages alone; `sections` is the home sections' ids and kinds in
// the order being published, so the Publish panel can say "section 2" from an
// issue's id. A database failure while checking links throws, and the route
// answers 5xx: it can never come back as a validation problem.
// opts.live: the live release's content to compare the brand against (TOK-02).
// Left out, it is read here; null means "nothing live yet", so every failing
// pair counts as a change from the platform default.
// P2-GUARD: when the live release is a documents list (v4), this legacy check
// has nothing to compare against and the store doesn't publish this way, so
// the answer is the documents marker, never a brand verdict against "nothing".
export async function validateRelease(content, opts = {}) {
  const live = opts.live !== undefined ? opts.live : await liveContentForCheck();
  if (live?.documents) return { ok: true, documents: true, message: DOCUMENTS_MESSAGE, issues: [], errors: [], warnings: [], sections: [] };
  const issues = [];
  const report = (severity, at, code, message) => issues.push(issue({ ...at, code, severity, message }));
  const b = content.blocks || {};
  const home = { documentId: "doc_home" };
  const hero = { documentId: "doc_home", sectionId: HERO_SECTION_ID };

  // required slots
  if (b.hero && !String(b.hero.title || "").trim()) report("error", { ...hero, field: "title" }, "REQUIRED", "a published hero needs a title");
  if (b.home_sections && !b.home_sections.some((s) => s.enabled !== false)) report("error", { ...home, field: "sections" }, "HOME_EMPTY", "at least one section must be enabled");

  // TOK-02: the brand's format, then every colour pair the storefront draws
  // (lib/brand.js PAIRS) on the theme kit's surfaces. Saving never blocks on
  // readability; publishing does, but only for a pair whose colours differ
  // from what the live store shows. A pair the live store already shows warns.
  if (content.brand || content.theme) {
    const r = content.brand ? validateBrand(content.brand) : { ok: true, errors: [], warnings: [] };
    for (const e of r.ok ? [] : r.errors) report("error", { documentId: "doc_design" }, "BRAND_INVALID", e);
    for (const w of r.warnings || []) report("warning", { documentId: "doc_design" }, "BRAND_WARNING", w);
    if (r.ok) {
      const check = checkBrand(content.brand || null, { kit: kitAttr(content.theme), live: live?.brand || null, liveKit: kitAttr(live?.theme) });
      for (const i of check.issues) report(i.severity, { documentId: "doc_design", field: i.fix }, "BRAND_PAIR", i.message);
    }
  }

  // links: hero CTAs, announcement, nav items, page section bodies don't carry links
  if (b.hero?.primary) await checkInternalLink(b.hero.primary.href, report, { ...hero, field: "primary.href" }, "the primary button");
  if (b.hero?.secondary) await checkInternalLink(b.hero.secondary.href, report, { ...hero, field: "secondary.href" }, "the secondary button");
  if (b.announcement?.enabled) await checkInternalLink(b.announcement.href, report, { documentId: "doc_announcement", field: "href" });
  for (const which of ["nav_header", "nav_footer"]) {
    const documentId = which === "nav_header" ? "doc_header" : "doc_footer";
    for (const [i, item] of (Array.isArray(b[which]) ? b[which] : []).entries()) {
      await checkInternalLink(item.href, report, { documentId, field: `items.${i}.href` }, `“${item.label}”`);
      for (const [j, c] of (item.children || []).entries()) {
        await checkInternalLink(c.href, report, { documentId, field: `items.${i}.children.${j}.href` }, `“${item.label}” → “${c.label}”`);
      }
    }
  }
  // S38: banner sections carry links too
  for (const s of Array.isArray(b.home_sections) ? b.home_sections : []) {
    if (s?.kind === "banner" && s.href) await checkInternalLink(s.href, report, { ...home, sectionId: s.id ?? null, field: "href" });
  }
  // S38 (SF02): curated collection handles must exist in the catalog
  const ci = b.collections_index;
  if (ci) {
    for (const [label, list, field] of [["Featured", ci.featured, "featured"], ["Ordered", ci.order, "order"]]) {
      for (const h of Array.isArray(list) ? list : []) {
        const row = await db.selectFrom("collections").select("handle").where("handle", "=", h).executeTakeFirst();
        if (!row) report("error", { documentId: "doc_collections_index", field }, "HANDLE_MISSING", `${label.toLowerCase()} handle "${h}" isn't a collection in the catalog`);
      }
    }
  }
  // S38 (SF14): a store selling to the public should publish its legal pages —
  // warn (not block) when none of privacy/terms/refund-ish pages is enabled.
  const pages = Array.isArray(content.pages) ? content.pages : [];
  const hasPolicy = (re) => pages.some((p) => p.enabled && re.test(p.slug));
  if (!brandDefaultsApply()) {
    if (!hasPolicy(/privacy/)) report("warning", {}, "POLICY_PAGE_MISSING", "No enabled privacy policy page — add one before launch (checkout links to it)");
    if (!hasPolicy(/terms|refund|return/)) report("warning", {}, "POLICY_PAGE_MISSING", "No enabled terms/refund page — add one before launch");
  }
  const errs = errorIssues(issues);
  const sections = (Array.isArray(b.home_sections) ? b.home_sections : []).map((s) => ({ id: s?.id ?? null, kind: s?.kind ?? null }));
  return { ok: !errs.length, issues, errors: messagesOf(errs), warnings: messagesOf(warningIssues(issues)), sections };
}

// The live release's content for the brand comparison. A read failure is
// treated like "nothing live": strict, every failing pair blocks. A v4 live
// release (a documents list, no brand in it) is the documents marker.
async function liveContentForCheck() {
  const s = await getLiveReleaseState();
  if (s.state !== "live") return null;
  return s.release.v === DOCUMENTS_RELEASE_VERSION ? { documents: true } : s.release.content;
}

// The answer every legacy surface gives for a store whose live release is a
// documents list: no legacy diff, no brand verdict, the plain message.
const documentsDiff = (live) => ({
  documents: true,
  message: DOCUMENTS_MESSAGE,
  firstPublish: false,
  dirty: false,
  draftHash: null,
  liveHash: live?.content_hash || null,
  items: [],
});

// S52: the per-item answer to "what will publishing change?" — the draft
// snapshot compared against the LIVE release's content, item by item. The
// single dirty hash stays authoritative; this names the pieces behind it.
export async function releaseDiff() {
  // P2-GUARD: read both at once, as before, but a v4 live release answers
  // with the documents marker whatever the legacy snapshot did
  const [snapR, liveR] = await Promise.allSettled([snapshotContent(), getLiveRelease()]);
  if (liveR.status === "fulfilled" && liveR.value?.documents) return documentsDiff(liveR.value);
  if (snapR.status === "rejected") throw snapR.reason;
  if (liveR.status === "rejected") throw liveR.reason;
  const snap = snapR.value;
  const live = liveR.value;
  const liveC = live?.content || { blocks: {}, pages: [], brand: null, theme: null };
  // S54: section instance ids are rendering identity, not shopper-visible
  // output — an id-only difference (e.g. the lazy legacy-id upgrade) must not
  // read as "unpublished changes". Strip them before comparing.
  const stripSectionIds = (v) => {
    if (Array.isArray(v)) return v.map(stripSectionIds);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (k === "id" && typeof val === "string" && /^sec_[a-z0-9]{2,16}$/.test(val)) continue;
        out[k] = stripSectionIds(val);
      }
      return out;
    }
    return v;
  };
  const same = (a, b) => stableStringify(stripSectionIds(a ?? null)) === stableStringify(stripSectionIds(b ?? null));
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
  // S53 (0B-2): the presentation sets. A v1 live release never froze them
  // (they were live-on-save), so for v1 we only report a difference when the
  // drafts hold rows — anything else would mark every tenant dirty forever.
  const liveV1 = (liveC.v ?? 1) < 2;
  const setDiff = (type, draftRows, liveRows) => {
    const l = liveV1 ? draftRows : (liveRows ?? []);
    if (!same(draftRows, l)) items.push({ type, key: type, change: "edited" });
  };
  setDiff("overrides", snap.content.product_overrides, liveC.product_overrides);
  setDiff("pins", snap.content.collection_pins, liveC.collection_pins);
  setDiff("placements", snap.content.placements, liveC.placements);
  setDiff("redirects", snap.content.redirects, liveC.redirects);
  // The envelope upgrade itself (v1→v2 presentation sets, v2→v3 section ids)
  // changes the hash even when nothing the merchant edited differs — name it
  // instead of showing a bare "dirty".
  if (live && (liveC.v ?? 1) < 3) items.push({ type: "envelope", key: "envelope", change: "upgrade" });
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
//
// P2-VGATE: the envelope version is checked here, before any reader sees the
// row. Only the exact numbers count (the string "3" is not 3):
//   v 1, 2, 3 → live, read by the legacy reader;
//   v 4       → live with release.v 4 (the documents list). The storefront
//               fails closed on it until the v4 reader lands (resolve.js);
//   anything else, a missing v or non-object content → error.
// release.v carries the version so callers branch without re-reading content.
// Pointer and release are one statement (a LEFT JOIN), so a request pays one
// round trip for both (PERF-01).
export const LEGACY_RELEASE_VERSIONS = Object.freeze([1, 2, 3]);
export const DOCUMENTS_RELEASE_VERSION = 4;

export async function getLiveReleaseState() {
  let row;
  try {
    row = await db
      .selectFrom("release_state as s")
      .leftJoin("releases as r", "r.id", "s.live_release_id")
      .select(["s.live_release_id as live_release_id", "r.id as id", "r.content as content", "r.content_hash as content_hash", "r.published_at as published_at", "r.note as note"])
      .where("s.id", "=", 1)
      .executeTakeFirst();
  } catch (e) {
    const msg = String(e?.message || e);
    // the release tables not existing yet IS the pre-first-publish state. Only
    // release_state itself missing (P1-FIX-C): "none" serves drafts to
    // shoppers, so any other schema error must stay an error.
    return notMigratedYet(e, { table: "release_state" }) ? { state: "none" } : { state: "error", error: msg.slice(0, 200) };
  }
  if (!row?.live_release_id) return { state: "none" };
  // a live pointer with no release row is corruption, never "no release yet"
  if (row.id == null) return { state: "error", error: `live pointer ${row.live_release_id} has no release row` };

  let content;
  try {
    content = JSON.parse(row.content);
  } catch {
    return { state: "error", error: `release ${row.id} content is not valid JSON` };
  }
  if (!content || typeof content !== "object" || Array.isArray(content) || content.v === undefined || content.v === null) {
    return { state: "error", error: `release ${row.id} content has no envelope version` };
  }
  const v = content.v;
  if (!LEGACY_RELEASE_VERSIONS.includes(v) && v !== DOCUMENTS_RELEASE_VERSION) {
    return { state: "error", error: `release ${row.id} has an envelope version this code can't read (${JSON.stringify(v).slice(0, 40)})` };
  }
  return {
    state: "live",
    release: { id: row.id, content, content_hash: row.content_hash, published_at: row.published_at, note: row.note, v },
  };
}

// Compat wrapper for ADMIN/operator surfaces that only badge state (error →
// null is acceptable there). The SHOPPER path uses getLiveReleaseState via
// lib/content/resolve.js and fails closed on "error".
// P2-GUARD: a v4 live release (a documents list) comes back as the documents
// marker, { id, v: 4, documents: true, content: null, … }, so no admin
// surface can read its list as legacy content ("every block customized").
export async function getLiveRelease() {
  const s = await getLiveReleaseState();
  if (s.state !== "live") return null;
  const r = s.release;
  if (r.v === DOCUMENTS_RELEASE_VERSION) {
    return { id: r.id, v: DOCUMENTS_RELEASE_VERSION, documents: true, content: null, content_hash: r.content_hash, published_at: r.published_at, note: r.note, message: DOCUMENTS_MESSAGE };
  }
  return r;
}

// P2-GUARD: the console's Publishing badge. Documents mode: one statement, the
// count of documents whose draft differs from what's published (null when
// none). Otherwise today's check: a dot when the drafts differ from live.
export async function publishingBadge() {
  const b = await publishBadgeState();
  if (b.mode === "documents") return b.dirty > 0 ? b.dirty : null;
  const [snap, live] = await Promise.all([snapshotContent(), getLiveRelease()]);
  if (live?.documents) return null;
  return !live || live.content_hash !== snap.hash ? "•" : null;
}

// P2-VGATE: a row that was never published and never scheduled is the
// leftover of a publish that lost its race (or failed between the insert and
// the flip). It is hidden, EXCEPT the row the live pointer names: before
// P2-GUARD the flip and the stamp were two statements, so a live row written
// then can be unstamped. Since P2-GUARD they are one batch, and a publish that
// loses its race leaves no row at all.
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

// ---- the guarded flip (P2-GUARD) ----------------------------------------------
//
// One libsql.batch(stmts, "write"), the GEN-02 guard-and-abort pattern that
// lib/documents/commit.js proved on sqld:
//   1. (a new publish only) INSERT the release row … ON CONFLICT(id) DO NOTHING
//   2. UPDATE release_state SET live_release_id = :new … WHERE id = 1
//        AND (live_release_id IS :expected OR live_release_id = :new)
//        AND EXISTS (the release row)
//   3. INSERT INTO release_state (id) SELECT 2 WHERE changes() = 0
//      release_state has CHECK (id = 1): when the flip matched nothing (the
//      pointer moved since it was read) this insert fails and the whole batch
//      rolls back, the new release row with it.
//   4. stamp published_at the first time the row goes live
// `OR live_release_id = :new` makes a resent batch (lib/db.js resends one whose
// answer was lost) an idempotent success. ON CONFLICT(id) DO NOTHING absorbs
// only that repeated id; NOT NULL and CHECK still fail.

// Test seam: scripts/test-releases.js interleaves two publishes here. Called
// after the pointer is read and before the batch is sent.
export const __releaseTestHooks = { beforeFlip: null };

const isGuardAbort = (e) => {
  const t = `${e?.code || ""} ${e?.message || e} ${e?.cause?.message || ""}`;
  return /CHECK constraint failed/i.test(t) && /(id\s*=\s*1|release_state)/i.test(t);
};

function refusal(message, code, status = 409) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  e.expose = true; // a deliberate refusal: the route answers with this status and message
  return e;
}
const raceLost = () => refusal("Another publish just went live, review again", "PUBLISH_RACE");
const documentsTarget = () => refusal(`${DOCUMENTS_MESSAGE}, so that version can't go live from here. Use the editor instead.`, "STORE_USES_DOCUMENTS");

// The live pointer and the envelope version of the row it names, in one read.
async function readPointer() {
  const r = await libsql.execute(
    "SELECT s.live_release_id AS live, CASE WHEN json_valid(r.content) THEN json_extract(r.content, '$.v') END AS v " +
      "FROM release_state s LEFT JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1",
  );
  const row = r.rows?.[0];
  return { id: row?.live ?? null, v: row?.v ?? null };
}

// A release row's id, hash and envelope version, or null.
async function readTarget(releaseId) {
  const r = await libsql.execute({
    sql: "SELECT id, content_hash, CASE WHEN json_valid(content) THEN json_extract(content, '$.v') END AS v FROM releases WHERE id = ?",
    args: [releaseId],
  });
  const row = r.rows?.[0];
  return row ? { id: row.id, content_hash: String(row.content_hash ?? ""), v: row.v ?? null } : null;
}

// → { ok: true } or { lost: true, pointer }. Anything else throws: the
// database's own error, or PUBLISH_UNKNOWN when even the re-read failed.
async function guardedFlip({ releaseId, expected, now, insert = null, hash = null, info = {} }) {
  if (__releaseTestHooks.beforeFlip) await __releaseTestHooks.beforeFlip({ releaseId, expected, ...info });
  const stmts = [];
  if (insert) stmts.push(insert);
  stmts.push({
    sql:
      "UPDATE release_state SET live_release_id = ?, updated_at = ? WHERE id = 1 AND (live_release_id IS ? OR live_release_id = ?) " +
      `AND EXISTS (SELECT 1 FROM releases WHERE id = ?${hash ? " AND content_hash = ?" : ""})`,
    args: [releaseId, now, expected ?? null, releaseId, releaseId, ...(hash ? [hash] : [])],
  });
  stmts.push({ sql: "INSERT INTO release_state (id) SELECT 2 WHERE changes() = 0", args: [] });
  stmts.push({ sql: "UPDATE releases SET published_at = ? WHERE id = ? AND published_at IS NULL", args: [now, releaseId] });
  try {
    await libsql.batch(stmts, "write");
    return { ok: true };
  } catch (cause) {
    let back;
    try {
      const r = await libsql.execute({
        sql: "SELECT (SELECT live_release_id FROM release_state WHERE id = 1) AS live, (SELECT count(*) FROM releases WHERE id = ?) AS ours",
        args: [releaseId],
      });
      back = { pointer: r.rows?.[0]?.live ?? null, ours: Number(r.rows?.[0]?.ours ?? 0) > 0 };
    } catch {
      const e = new Error("Your publish may have gone live. Reload to check.", { cause });
      e.code = "PUBLISH_UNKNOWN";
      throw e;
    }
    // committed and the answer was lost: the pointer names it, or (for a new
    // release) its row exists, which only the whole batch can have written
    if (back.pointer === releaseId || (insert && back.ours)) return { ok: true, reconciled: true };
    if (isGuardAbort(cause)) return { lost: true, pointer: back.pointer };
    throw cause;
  }
}

// Create an immutable release from the current drafts. scheduledFor (UTC ISO)
// defers the pointer flip to the jobs queue; otherwise it flips now.
// S53 (0B-1): expectedDraftHash binds the publish to the EXACT reviewed
// candidate — if the drafts moved between review and publish, this is a 409,
// never a silent publish of something nobody looked at.
// The warnings that ride along with a release that went through (DOC-04):
// `warnings` are the bare messages, for older readers; `issues` and
// `sections` let the Publishing panel say where each one is ("Announcement
// bar: …", "Section 2 (Banner / CTA): …"), as it does before publishing.
const riding = (validation) => ({ warnings: validation.warnings, issues: warningIssues(validation.issues), sections: validation.sections });

export async function createRelease({ note = "", actor = null, scheduledFor = null, expectedDraftHash = null } = {}) {
  // P2-GUARD: only a legacy store publishes this way, and only over a legacy
  // pointer. The pointer read here is the one this publish replaces: if
  // another publish lands before the flip, this one is a 409 and leaves no row.
  await assertLegacyContentWrites({ doing: "publish" });
  const expected = await readPointer();
  if (expected.id && expected.v === DOCUMENTS_RELEASE_VERSION) throw documentsTarget();
  const snap = await snapshotContent();
  if (expectedDraftHash && expectedDraftHash !== snap.hash) {
    const err = new Error("Drafts changed since you reviewed them — review the updated change list, then publish again");
    err.code = "DRAFTS_CHANGED";
    err.status = 409;
    throw err;
  }
  const validation = await validateRelease(snap.content);
  if (!validation.ok) {
    const err = new Error(validation.errors.join(" · "));
    err.code = "RELEASE_INVALID";
    err.issues = validation.issues; // DOC-04: the structured list, same shape as save
    err.sections = validation.sections;
    err.errors = validation.errors;
    err.warnings = validation.warnings;
    throw err;
  }
  const id = relId();
  const row = { id, content: snap.canonical, content_hash: snap.hash, note: String(note || "").slice(0, 300), created_by: actor?.id || null, created_at: nowIso(), scheduled_for: scheduledFor };

  if (scheduledFor) {
    // a scheduled release flips later, through publishReleaseById
    await db.insertInto("releases").values(row).execute();
    await enqueueJob({
      type: "publish_release",
      tenantId: tenantId() || null,
      payload: { releaseId: id },
      idempotencyKey: `publish_${id}`,
      runAfter: scheduledFor,
    });
    slog("release_scheduled", { release: id, at: scheduledFor });
    await audit({ actor, action: "release.schedule", resource: `release:${id}`, diff: { hash: snap.hash.slice(0, 12), at: scheduledFor } });
    return { id, hash: snap.hash, scheduledFor, ...riding(validation) };
  }

  const now = nowIso();
  const flip = await guardedFlip({
    releaseId: id,
    expected: expected.id,
    now,
    hash: snap.hash,
    insert: {
      sql:
        "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT(id) DO NOTHING",
      args: [row.id, row.content, row.content_hash, row.note, row.created_by, row.created_at],
    },
    info: { kind: "publish" },
  });
  if (flip.lost) {
    slog("release_publish_lost_race", { release: id, expected: expected.id, pointer: flip.pointer });
    throw raceLost();
  }
  slog("release_published", { release: id, hash: snap.hash.slice(0, 12) });
  await audit({ actor, action: "release.publish", resource: `release:${id}`, diff: { hash: snap.hash.slice(0, 12) } });
  return { id, hash: snap.hash, publishedAt: now, ...riding(validation) };
}

// Flip a previously created (scheduled) release live — the worker's entry.
// P2-GUARD: the scheduled release wins at its time. When the compare-and-set
// loses (a manual publish landed between the read and the flip), it re-reads
// the pointer and tries again, up to 3 more times. It fails cleanly, without
// flipping, only for a store not on legacy, a v4 target or pointer, or a
// missing row.
export const SCHEDULED_FLIP_RETRIES = 3;

export async function publishReleaseById(releaseId) {
  const mode = await getCmsMode();
  if (mode !== "legacy") throw new StoreUsesDocumentsError(mode, { doing: "publish" });
  const target = await readTarget(releaseId);
  if (!target) throw new NotFoundError(`release ${releaseId} not found`);
  if (target.v === DOCUMENTS_RELEASE_VERSION) throw documentsTarget();
  for (let attempt = 1; attempt <= 1 + SCHEDULED_FLIP_RETRIES; attempt++) {
    const expected = await readPointer();
    if (expected.id && expected.id !== releaseId && expected.v === DOCUMENTS_RELEASE_VERSION) throw documentsTarget();
    const now = nowIso();
    const flip = await guardedFlip({ releaseId, expected: expected.id, now, info: { kind: "scheduled", attempt } });
    if (flip.ok) {
      slog("release_published", { release: releaseId, scheduled: true, attempt });
      return { id: releaseId, publishedAt: now };
    }
    slog("release_scheduled_flip_lost", { release: releaseId, attempt, pointer: flip.pointer });
  }
  throw new Error(`release ${releaseId}: other publishes kept moving the live pointer (${1 + SCHEDULED_FLIP_RETRIES} tries); the job will try again`);
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
    e.expose = true; // a deliberate refusal: the route answers with this status and message
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
// P2-GUARD: the same guarded flip from the pointer read here; refuses a store
// not on legacy, a v4 target, and a v4 pointer.
export async function rollbackRelease(releaseId, { actor = null } = {}) {
  await assertLegacyContentWrites({ doing: "publish" });
  const row = await readTarget(releaseId);
  if (!row) throw new NotFoundError("That version no longer exists. Reload the page to see the current list.");
  if (row.v === DOCUMENTS_RELEASE_VERSION) throw documentsTarget();
  const expected = await readPointer();
  if (expected.id && expected.v === DOCUMENTS_RELEASE_VERSION) throw documentsTarget();
  const flip = await guardedFlip({ releaseId, expected: expected.id, now: nowIso(), info: { kind: "rollback" } });
  if (flip.lost) throw raceLost();
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

// P2-PREVIEW (PV-03, spec 8.8): a token for a preview SESSION carries its sid,
// `p.<exp>.<sid>.<hmac20>` over tenant|exp|sid. The sid names a
// preview_sessions row (lib/preview-sessions.js). Without `sid` the token is
// today's `p.<exp>.<hmac20>`, which the legacy releases preview keeps minting.
export const PREVIEW_SID_RE = /^ps_[0-9a-f]{16}$/;

export async function previewToken({ now = Date.now(), sid = null, exp: expAt = null } = {}) {
  const exp = expAt ?? Math.floor((now + PREVIEW_TTL_MS) / 1000);
  if (sid != null) {
    if (!PREVIEW_SID_RE.test(String(sid))) throw new Error("previewToken: a sid must look like ps_<16 hex>");
    return `p.${exp}.${sid}.${await hmac20(`${tenantId() || "_default"}|${exp}|${sid}`, previewSecret())}`;
  }
  return `p.${exp}.${await hmac20(`${tenantId() || "_default"}|${exp}`, previewSecret())}`;
}

// Both formats: { exp, sid } for a token this store signed and that has not
// expired (sid is null for the old format), else null. The old format is
// still read so preview tabs opened before a deploy keep working; on a store
// in documents mode an old-format token gets no draft overlay (resolve.js).
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
