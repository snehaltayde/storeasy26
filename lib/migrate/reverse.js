// P4-REVERSE (MIG-04, OVL-17): putting a store that moved to the new editor
// (documents) back on the old one (legacy), with no live product or collection
// row left behind for shoppers to read. Command-line only
// (scripts/reverse-documents.js); edge-safe all the same (no node: imports).
// Everything runs inside the store's own context (withTenant).
//
//   reversalPlan()          read-only: what goes back, and what was edited in the
//                           new editor that won't show any more (by product name)
//   reverseDryRun()         the plan, its refusals and its digest (--dry-run)
//   reverseDocuments(opts)  the reversal, or its resume (--resume)
//   abortReversal()         --abort: stay on the new editor (between the steps only)
//   reverseStatus()         --status (read only)
//   __reverseTestHooks      test seams (never set outside tests)
//
// Preconditions, checked here before anything is written (each a plain
// refusal): the store is on the new editor and was moved there by the cutover
// tool (a store that started on the new editor has no old content to go back
// to); no other run holds it; the ledger holds 0021 to 0025; the release it goes
// back to still exists and is an old-editor release; for a database not on this
// machine --hosted --confirm <id> --backup-ref <iso> (the cutover's rule,
// preconditions.js hostedRefusal); the digest of a reversal dry run equal to
// this one's (so the owner's message to the founder names exactly what stops
// showing). Builders never pass --hosted.
//
// The steps, each recorded in the run row (cms_migration_runs, kind 'reverse'):
//   1. lock     ONE batch: [documentsGuardStatement, mode 'migrating', the run
//               row (step 'locked')]. From here every live-row publish, Undo and
//               discard aborts in its own batch (LIVEROW's documents guard), and
//               the old editors still refuse (legacy guard), so nothing can add
//               an overlay after the copy. The plan is read again after the
//               lock: it must be the dry run's (else back to the new editor).
//   2. reverse  ONE batch under migratingGuardStatement(run): every
//               product_content_live and collection_content_live row copied
//               into content_live_reversed; a search_outbox row (reason
//               'reverse') per product row; both live tables emptied; the
//               pointer moved to cms_state.cutover_release_id (NULL for a store
//               that had no release: the old editor's drafts), guarded on that
//               release still existing; mode 'legacy'; the run finished
//               (outcome 'done', step 'reversed'). A crash before this batch
//               leaves the store on the new editor, paused (--resume or
//               --abort); after it, a complete legacy store.
//   (search)    kickSearchReindex (P4-SEARCH), best effort, so search shows
//               Shopify's names without waiting for a full sync; a failure is
//               reported and the next full sync catches up.
//   3. look     config.theme_pin set back to the old editor's value (the key
//               removed, so the operator screens read config.theme again), then
//               read back from the control plane and reported. A failure is
//               reported; --resume on the store does steps (search) and 3 again.
//
// Plain words for every refusal and stop; codes are for tests and Details.
import { libsql } from "../db.js";
import { currentTenant, tenantId } from "../tenant-context.js";
import { documentsGuardStatement, migratingGuardStatement, isGuardAbort, classifyAbort } from "../cms-mode.js";
import { stableStringify } from "../registry/index.js";
import { PRODUCT_LIVE_COLUMNS, COLLECTION_LIVE_COLUMNS, liveRowFor } from "../documents/live-rows.js";
import { LEGACY_RELEASE_VERSIONS } from "../releases.js";
import { sha256Hex } from "./ids.js";
import { newRunId, openRun, anyOpenRun, latestRun, readMode, parseReport, finishStatement } from "./runs.js";
import { hostedRefusal, missingMigrations, refusal, digestRefusal } from "./preconditions.js";
import { PRODUCT_LEGACY_COLUMNS, COLLECTION_LEGACY_COLUMNS, ACTOR as CUTOVER_ACTOR } from "./backfill.js";
import { plainName } from "./report.js";

export const REVERSE_KIND = "reverse";
export const REVERSE_STEPS = Object.freeze(["locked", "reversed", "searched", "pinned"]);
export const OUTBOX_REASON = "reverse";
const nowIso = () => new Date().toISOString();

// Test seams. Each is async () => void, or null. P4-FIX6: beforeLock (after
// every precondition passed, right before the lock batch) and beforeAbort
// (--abort, after it read the open run, right before its batch), so the
// tests can race a second run or an --abort against each guarded batch.
export const __reverseTestHooks = { beforeLock: null, afterLock: null, beforeReverse: null, afterReverse: null, beforeAbort: null, pinWrite: null };
export function resetReverseTestHooks() {
  for (const k of Object.keys(__reverseTestHooks)) __reverseTestHooks[k] = null;
}

export const REVERSE_WORDS = Object.freeze({
  ALREADY_LEGACY: "This store already uses the old editor, so there is nothing to move back.",
  NEVER_MOVED: "This store started on the new editor, so it has no old editor content to go back to.",
  OPEN_RUN: "A reversal of this store is already under way. Check it with --status, then carry on with --resume or stop it with --abort.",
  BUSY: "This store is being updated by another run right now (a move to the new editor). Check it with the move tool's --status first.",
  UNKNOWN_MODE: "This store is in a state the reversal doesn't expect. Ask Storeasy support to look at it.",
  TARGET_MISSING: "The published version the store had before the move is no longer stored, so the store can't go back to it. Ask Storeasy support to look at it.",
  TARGET_NEW_EDITOR: "The published version the store had before the move is one made by the new editor, so the old editor can't show it. Ask Storeasy support to look at it.",
  NO_DIGEST: "Run the reversal's dry run first (--dry-run), read it with the founder, then give its digest: --dry-run-digest <the digest it printed>.",
  CHANGED: "Something was published in the new editor since the dry run you gave, so the store stayed on the new editor and nothing else changed. Run the dry run again, read it, and pass its new digest.",
  LOST_LOCK: "Someone published in the new editor just now, so the reversal didn't start. Run the dry run again, then the reversal.",
  LOST_RUN: "This reversal no longer holds the store (it was stopped or finished elsewhere), so nothing was moved back.",
  FAILED: "Going back to the old editor failed, so nothing was moved back. The store is still paused on the new editor; shoppers see it as before.",
  UNKNOWN: "We couldn't tell whether the store went back. Check with --status before anything else.",
});

export const ABORT_WORDS = Object.freeze({
  NOTHING: "There is no reversal under way, so there is nothing to stop.",
  AFTER: "The store is already back on the old editor, so the reversal can't be stopped any more. To use the new editor again, move the store with the move tool (the migrate:documents command; see the runbook).",
  DONE: "The reversal was stopped and the store stays on the new editor. Publishing works again; nothing shoppers see changed.",
  NOT_PAUSED: "The store isn't paused for this reversal any more, so nothing was changed. Check it with --status.",
});

class Stop extends Error {
  constructor(code, words, { detail = null, unlock = false } = {}) {
    super(words);
    this.code = code;
    this.words = words;
    this.detail = detail;
    this.unlock = unlock;
  }
}

const rows = async (sql, args = []) => (await libsql.execute({ sql, args })).rows.map((r) => ({ ...r }));
const str = (v) => (v == null ? null : String(v));
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// ---- the plan (read only) ---------------------------------------------------------------

// The newest finished reversal (outcome 'done'), or null.
async function lastDone() {
  const r = (await rows("SELECT * FROM cms_migration_runs WHERE kind = 'reverse' AND outcome = 'done' ORDER BY finished_at DESC, rowid DESC LIMIT 1"))[0];
  return r || null;
}

// The cutover run that put the store on the new editor (its flip time), or null.
async function cutoverRun() {
  for (const r of await rows("SELECT * FROM cms_migration_runs WHERE kind = 'cutover' ORDER BY started_at DESC, rowid DESC")) {
    const rep = parseReport(r);
    if (rep.flippedAt) return { id: String(r.id), flippedAt: String(rep.flippedAt) };
  }
  return null;
}

async function titles(table, ids) {
  const out = {};
  const want = [...new Set(ids)].sort();
  for (let i = 0; i < want.length; i += 200) {
    const part = want.slice(i, i + 200);
    for (const r of await rows(`SELECT id, title FROM ${table} WHERE id IN (${part.map(() => "?").join(", ")})`, part)) out[String(r.id)] = String(r.title ?? "");
  }
  return out;
}

// The overlay columns a product live row sets, as edits (title, description,
// photos, display_*, seo_*, photos per option).
const OVERLAY_EDITS = [
  ["title", (r) => r.title != null],
  ["description_html", (r) => r.description_html != null || r.description != null],
  ["gallery", (r) => r.gallery != null || r.featured_image != null],
  ["display_type", (r) => r.display_type != null],
  ["display_vendor", (r) => r.display_vendor != null],
  ["keep_variant_images", (r) => r.keep_variant_images != null],
  ["seo_title", (r) => r.seo_title != null || r.seo_description != null],
  ["og_image", (r) => r.og_image != null],
];

const legacyPart = (row, cols) => stableStringify(Object.fromEntries(cols.map((c) => [c, row?.[c] ?? null])));

// What the cutover put live for this document (its 'migrated' log row's
// version), or null when the move put nothing live for it.
async function movedBodies(ids) {
  const out = new Map();
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const got = await rows(
      `SELECT l.document_id AS d, v.id AS v, v.body AS body FROM publish_log l JOIN document_versions v ON v.id = l.to_version_id WHERE l.action = 'migrated' AND l.document_id IN (${part.map(() => "?").join(", ")}) ORDER BY l.created_at, l.rowid`,
      part,
    );
    for (const r of got) out.set(String(r.d), { versionId: String(r.v), body: parse(String(r.body)) });
  }
  return out;
}

const productName = (names, id) => (names[id] ? `“${names[id]}”` : "A product that is no longer in your catalog");

/**
 * What a reversal does to this store, read only (SELECTs): the release it goes
 * back to, the live rows, and what was edited in the new editor that won't
 * show any more, by name.
 */
export async function reversalPlan() {
  const tenant = tenantId() || "_default";
  const mode = await readMode();
  const state = (await rows("SELECT mode, cutover_release_id FROM cms_state WHERE id = 1"))[0] || null;
  const target = str(state?.cutover_release_id ?? null);
  const moved = await cutoverRun();
  const since = moved?.flippedAt ?? null;
  let targetRow = null;
  if (target) targetRow = (await rows("SELECT id, content FROM releases WHERE id = ?", [target]))[0] || null;
  const targetV = targetRow ? Number(parse(String(targetRow.content))?.v ?? 1) : null;

  const product = await rows(`SELECT ${PRODUCT_LIVE_COLUMNS.join(", ")} FROM product_content_live ORDER BY product_id`);
  const collection = await rows(`SELECT ${COLLECTION_LIVE_COLUMNS.join(", ")} FROM collection_content_live ORDER BY collection_id`);
  const productNames = await titles("products", product.map((r) => String(r.product_id)));
  const collectionNames = await titles("collections", collection.map((r) => String(r.collection_id)));
  const moves = await movedBodies([...new Set([...product.map((r) => String(r.document_id)), ...collection.map((r) => String(r.document_id))])].sort());

  // products: the overlay fields, plus extras published in the new editor
  // that differ from what the move put live
  const products = [];
  let overlayFields = 0;
  for (const r of product) {
    const id = String(r.product_id);
    const fields = OVERLAY_EDITS.filter(([, has]) => has(r)).map(([f]) => f);
    overlayFields += fields.length;
    const m = moves.get(String(r.document_id));
    const movedRow = m?.body ? liveRowFor("product_content", m.body, { documentId: String(r.document_id), versionId: m.versionId, publishedAt: "" }) : null;
    const extras = legacyPart(r, PRODUCT_LEGACY_COLUMNS) !== legacyPart(movedRow, PRODUCT_LEGACY_COLUMNS);
    if (extras) fields.push("extras");
    if (!fields.length) continue;
    products.push({ id, name: productName(productNames, id), fields, overlay: fields.filter((f) => f !== "extras"), values: { title: r.title ?? null } });
  }
  products.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1));
  const collections = [];
  for (const r of collection) {
    const id = String(r.collection_id);
    const m = moves.get(String(r.document_id));
    const movedRow = m?.body ? liveRowFor("collection_content", m.body, { documentId: String(r.document_id), versionId: m.versionId, publishedAt: "" }) : null;
    if (legacyPart(r, COLLECTION_LEGACY_COLUMNS) === legacyPart(movedRow, COLLECTION_LEGACY_COLUMNS)) continue;
    collections.push({ id, name: collectionNames[id] ? `The collection “${collectionNames[id]}”` : "A collection", fields: ["pinned"] });
  }
  collections.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // everything else published in the new editor since the move
  const log = since ? await rows("SELECT document_id, action FROM publish_log WHERE action <> 'migrated' AND created_at >= ? ORDER BY created_at, rowid", [since]) : [];
  const publishedIds = [...new Set(log.map((l) => String(l.document_id)))].sort();
  const docs = publishedIds.length
    ? await rows(`SELECT id, type, slug, label, entity_id FROM documents WHERE id IN (${publishedIds.map(() => "?").join(", ")}) ORDER BY id`, publishedIds)
    : [];
  const pages = docs
    .filter((d) => d.type !== "product_content" && d.type !== "collection_content")
    .map((d) => ({ id: String(d.id), name: plainName({ type: String(d.type), slug: str(d.slug), label: String(d.label) }) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // unpublished drafts
  // (drafts carried over from the old editor by the move are still in the old
  // editor's own tables, so only those changed since the move count)
  const draftRows = await rows(
    "SELECT id, type, slug, label, entity_id FROM documents WHERE archived_at IS NULL AND type NOT IN ('blueprint') AND draft_hash IS NOT published_hash " +
      "AND updated_by IS NOT ? AND (? IS NULL OR updated_at > ?) ORDER BY id",
    [CUTOVER_ACTOR, since, since],
  );
  const dProducts = await titles("products", draftRows.filter((d) => d.type === "product_content" && d.entity_id).map((d) => String(d.entity_id)));
  const dCollections = await titles("collections", draftRows.filter((d) => d.type === "collection_content" && d.entity_id).map((d) => String(d.entity_id)));
  const drafts = draftRows
    .map((d) => {
      const type = String(d.type);
      const e = str(d.entity_id);
      const name =
        type === "product_content"
          ? `The product ${productName(dProducts, e)}`
          : type === "collection_content"
            ? dCollections[e]
              ? `The collection “${dCollections[e]}”`
              : "A collection"
            : plainName({ type, slug: str(d.slug), label: String(d.label) });
      return { id: String(d.id), name };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    tenant,
    mode,
    target,
    targetFound: target ? !!targetRow : null,
    targetV,
    movedBy: moved?.id ?? null,
    since,
    products,
    collections,
    pages,
    drafts,
    counts: {
      liveProducts: product.length,
      liveCollections: collection.length,
      overlayProducts: products.filter((p) => p.overlay.length).length,
      overlayFields,
      publishedDocuments: publishedIds.length,
      publishes: log.length,
      drafts: drafts.length,
    },
  };
}

// The digest covers what goes back and what stops showing, by id and field,
// not the catalog names (Shopify's, which a webhook may change while the store
// is paused): the report prints the names read at the time.
const unnamed = (list) => (list || []).map(({ name, ...rest }) => rest);
export const planDigest = (plan) =>
  sha256Hex(stableStringify({ ...plan, mode: null, products: unnamed(plan.products), collections: unnamed(plan.collections), pages: unnamed(plan.pages), drafts: unnamed(plan.drafts) }));

// The refusals that need no write (the mode and the open runs are checked by
// the caller, which knows whether it resumes).
function planRefusal(plan) {
  if (!plan.movedBy) return refusal("NEVER_MOVED", REVERSE_WORDS.NEVER_MOVED);
  if (plan.target && !plan.targetFound) return refusal("TARGET_MISSING", REVERSE_WORDS.TARGET_MISSING);
  if (plan.target && !LEGACY_RELEASE_VERSIONS.includes(plan.targetV)) return refusal("TARGET_NEW_EDITOR", REVERSE_WORDS.TARGET_NEW_EDITOR);
  return null;
}

function modeRefusal(mode, run) {
  if (run && run.kind === REVERSE_KIND) return refusal("OPEN_RUN", REVERSE_WORDS.OPEN_RUN, { run: run.id });
  if (run) return refusal("BUSY", REVERSE_WORDS.BUSY, { run: run.id });
  if (mode === "legacy") return refusal("ALREADY_LEGACY", REVERSE_WORDS.ALREADY_LEGACY);
  if (mode !== "documents") return refusal("UNKNOWN_MODE", REVERSE_WORDS.UNKNOWN_MODE, { mode: String(mode).slice(0, 40) });
  return null;
}

/** --dry-run: the plan, the refusal (if any) and the digest. Read only. */
export async function reverseDryRun() {
  const plan = await reversalPlan();
  const run = await anyOpenRun();
  const refused = modeRefusal(plan.mode, run) || planRefusal(plan);
  return { plan, refused, digest: await planDigest(plan) };
}

// ---- the steps ---------------------------------------------------------------------------

async function lockBatch({ runId, at, report, digest }) {
  await libsql.batch(
    [
      documentsGuardStatement(),
      { sql: "UPDATE cms_state SET mode = 'migrating', updated_at = ? WHERE id = 1 AND mode = 'documents'", args: [at] },
      {
        sql: "INSERT INTO cms_migration_runs (id, kind, step, source_hash, dry_run_digest, backup_ref, report, started_at, finished_at, outcome) VALUES (?, ?, 'locked', NULL, ?, ?, ?, ?, NULL, NULL)",
        args: [runId, REVERSE_KIND, digest, report.backupRef ?? null, JSON.stringify(report), at],
      },
    ],
    "write",
  );
}

// Back to the new editor (an abort, or a stop after the lock).
async function unlockBatch(runId, report, { outcome, at }) {
  try {
    await libsql.batch(
      [
        migratingGuardStatement(runId),
        { sql: "UPDATE cms_state SET mode = 'documents', updated_at = ? WHERE id = 1 AND mode = 'migrating'", args: [at] },
        finishStatement(runId, { step: "locked", outcome, report, at }),
      ],
      "write",
    );
  } catch (e) {
    const r = await libsql.execute({ sql: "SELECT (SELECT mode FROM cms_state WHERE id = 1) AS mode, (SELECT outcome FROM cms_migration_runs WHERE id = ? AND finished_at = ?) AS outcome", args: [runId, at] });
    const row = r.rows[0] || {};
    if (!(row.mode === "documents" && row.outcome === outcome)) throw e;
  }
}

const json = (cols, alias) => `json_object(${cols.map((c) => `'${c}', ${alias}.${c}`).join(", ")})`;

export function reverseStatements({ runId, target, at, report }) {
  const stmts = [migratingGuardStatement(runId)];
  stmts.push({
    sql: `INSERT INTO content_live_reversed (run_id, kind, entity_id, row_json, reversed_at) SELECT ?, 'product', p.product_id, ${json(PRODUCT_LIVE_COLUMNS, "p")}, ? FROM product_content_live p`,
    args: [runId, at],
  });
  stmts.push({
    sql: `INSERT INTO content_live_reversed (run_id, kind, entity_id, row_json, reversed_at) SELECT ?, 'collection', c.collection_id, ${json(COLLECTION_LIVE_COLUMNS, "c")}, ? FROM collection_content_live c`,
    args: [runId, at],
  });
  stmts.push({
    sql: "INSERT INTO search_outbox (product_id, handle, reason, created_at, done_at) SELECT p.product_id, (SELECT handle FROM products WHERE id = p.product_id), ?, ?, NULL FROM product_content_live p ORDER BY p.product_id",
    args: [OUTBOX_REASON, at],
  });
  stmts.push({ sql: "DELETE FROM product_content_live", args: [] });
  stmts.push({ sql: "DELETE FROM collection_content_live", args: [] });
  if (target) {
    // the release the store goes back to must still be there
    stmts.push({ sql: "UPDATE release_state SET live_release_id = ?, updated_at = ? WHERE id = 1 AND EXISTS (SELECT 1 FROM releases WHERE id = ?)", args: [target, at, target] });
  } else stmts.push({ sql: "UPDATE release_state SET live_release_id = NULL, updated_at = ? WHERE id = 1", args: [at] });
  stmts.push({ sql: "INSERT INTO release_state (id) SELECT 2 WHERE changes() = 0", args: [] });
  stmts.push({ sql: "UPDATE cms_state SET mode = 'legacy', updated_at = ? WHERE id = 1 AND mode = 'migrating'", args: [at] });
  stmts.push(finishStatement(runId, { step: "reversed", outcome: "done", report, at }));
  return stmts;
}

async function reversedLanded(runId) {
  const r = await libsql.execute({ sql: "SELECT (SELECT mode FROM cms_state WHERE id = 1) AS mode, (SELECT outcome FROM cms_migration_runs WHERE id = ?) AS outcome", args: [runId] });
  const row = r.rows[0] || {};
  return { landed: row.mode === "legacy" && row.outcome === "done", mode: str(row.mode) };
}

async function searchStep({ searchClient = null } = {}) {
  const { kickSearchReindex } = await import("../catalog/search-reindex.js");
  const r = await kickSearchReindex({ client: searchClient });
  if (r.error) return { status: "failed", error: r.error, queued: !!r.queued };
  if (!r.queued && !r.drained && !r.timedOut) return { status: "nothing" };
  if (r.drained) return { status: "drained", queued: !!r.queued, drained: { read: r.drained.read, upserted: r.drained.upserted, done: r.drained.done, skipped: r.drained.skipped ?? null } };
  return { status: "queued", queued: !!r.queued, timedOut: !!r.timedOut };
}

// The old editor's look for the operator screens: no theme_pin (kits.js
// themePinOf then reads config.theme, the legacy pin), removed in one
// targeted statement, then read back.
async function readPinState(client, id) {
  const r = await client.execute({ sql: "SELECT json_type(config, '$.theme_pin') AS t, json_extract(config, '$.theme') AS theme FROM tenants WHERE id = ?", args: [id] });
  const row = r.rows[0];
  if (!row) return null;
  let theme = null;
  try {
    theme = row.theme == null ? null : JSON.parse(String(row.theme));
  } catch {
    theme = null;
  }
  return { pinned: row.t != null, theme };
}

export async function resetPinStep({ platform = null } = {}) {
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default") return { status: "env" };
  const client = platform || (await import("../platform/control.js")).platformDb();
  let error = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (__reverseTestHooks.pinWrite) await __reverseTestHooks.pinWrite(tenant.id);
      await client.execute({
        sql: "UPDATE tenants SET config = json_remove(config, '$.theme_pin', '$.theme_pin_at'), updated_at = ? WHERE id = ? AND json_valid(config)",
        args: [nowIso(), tenant.id],
      });
      error = null;
    } catch (e) {
      error = String(e?.message || e).slice(0, 300);
    }
    let read = null;
    try {
      read = await readPinState(client, tenant.id);
    } catch (e) {
      error = error || String(e?.message || e).slice(0, 300);
    }
    if (read && !read.pinned && !error) {
      try {
        const { getTenant } = await import("../platform/control.js");
        await getTenant(tenant.id, { fresh: true });
      } catch {
        /* the cache refreshes itself soon; the pin is already set back */
      }
      return { status: "reset", look: read.theme && typeof read.theme.kit === "string" ? { kit: read.theme.kit, version: read.theme.version ?? null } : null, tries: attempt };
    }
    if (read && read.pinned && !error) error = "the look read back is still the new editor's";
  }
  return { status: "failed", error: error || "the look couldn't be read back" };
}

async function saveReport(runId, step, report) {
  await libsql.execute({ sql: "UPDATE cms_migration_runs SET step = ?, report = ? WHERE id = ?", args: [step, JSON.stringify(report), runId] });
}

// search, then the look, on a finished reversal (both best effort, both
// redone by --resume while either failed)
async function afterSteps(ctx) {
  const { runId, report } = ctx;
  report.search = await searchStep(ctx);
  await saveReport(runId, "searched", report);
  report.themePin = await resetPinStep({ platform: ctx.platform });
  await saveReport(runId, "pinned", report);
  return report;
}

async function stepTwo(ctx) {
  const { runId, report } = ctx;
  // the plan read again under the pause: what goes back is what the owner
  // read in the dry run (nothing can publish now)
  const plan = await reversalPlan();
  const digest = await planDigest(plan);
  if (digest !== report.digest) throw new Stop("CHANGED", REVERSE_WORDS.CHANGED, { unlock: true, detail: { expected: report.digest, found: digest } });
  const pr = planRefusal(plan);
  if (pr) throw new Stop(pr.code, pr.message, { unlock: true });
  if (__reverseTestHooks.beforeReverse) await __reverseTestHooks.beforeReverse();
  const at = ctx.now();
  const next = {
    ...report,
    plan,
    reversedAt: at,
    finishedAt: at,
    outcome: "done",
    counts: { productRows: plan.counts.liveProducts, collectionRows: plan.counts.liveCollections, outbox: plan.counts.liveProducts },
  };
  try {
    await libsql.batch(reverseStatements({ runId, target: plan.target, at, report: next }), "write");
  } catch (e) {
    let seen;
    try {
      seen = await reversedLanded(runId);
    } catch {
      throw new Stop("UNKNOWN", REVERSE_WORDS.UNKNOWN, { detail: { error: String(e?.message || e).slice(0, 300) } });
    }
    if (!seen.landed) {
      if (!isGuardAbort(e)) throw new Stop("FAILED", REVERSE_WORDS.FAILED, { detail: { error: String(e?.message || e).slice(0, 300) } });
      const c = await classifyAbort(libsql, e, "migrating");
      const open = await openRun(REVERSE_KIND);
      if (c?.kind === "mode" || !open || open.id !== runId) throw new Stop("LOST_RUN", REVERSE_WORDS.LOST_RUN, { detail: { mode: seen.mode } });
      // the release to go back to vanished inside the batch: nothing changed,
      // so the store goes back to the new editor
      throw new Stop("TARGET_MISSING", REVERSE_WORDS.TARGET_MISSING, { unlock: true, detail: { target: plan.target } });
    }
  }
  Object.assign(report, next);
  if (__reverseTestHooks.afterReverse) await __reverseTestHooks.afterReverse();
}

async function continueRun(ctx) {
  const { runId, report } = ctx;
  try {
    if (ctx.at === "locked") {
      await stepTwo(ctx);
      ctx.at = "reversed";
    }
    await afterSteps(ctx);
    return { finished: true };
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    report.stopped = { code: e.code, words: e.words, detail: e.detail };
    if (e.unlock) {
      const when = ctx.now();
      report.finishedAt = when;
      report.outcome = "stopped";
      await unlockBatch(runId, report, { outcome: "stopped", at: when });
      return { stopped: true, unlocked: true, code: e.code, words: e.words };
    }
    try {
      await libsql.execute({ sql: "UPDATE cms_migration_runs SET report = ? WHERE id = ? AND finished_at IS NULL", args: [JSON.stringify(report), runId] });
    } catch {
      /* the words still reach the owner */
    }
    return { stopped: true, code: e.code, words: e.words };
  }
}

function finished(ctx, r) {
  if (r.stopped) return { ok: false, stopped: { code: r.code, words: r.words, unlocked: !!r.unlocked }, report: ctx.report, runId: ctx.runId };
  return { ok: true, report: ctx.report, runId: ctx.runId };
}

/**
 * The reversal. opts:
 *   dryRunDigest  the digest of the reversal dry run the owner read
 *   hosted        { needed, hosted, confirm, backupRef } (the command works out
 *                 `needed` from the database and control-plane URLs)
 *   platform      the control plane's client, or null (_default)
 *   resume        carry on an open reversal; on a store a finished reversal
 *                 left with its search or look step failed, do those again
 *   now           () => ISO time (tests)
 *   searchClient  a Typesense client (tests: a spy)
 * -> { ok, refused?, stopped?, report, runId }
 */
export async function reverseDocuments(opts = {}) {
  const now = opts.now || nowIso;
  const tenant = tenantId() || "_default";
  const ctx = { tenant, now, platform: opts.platform ?? null, searchClient: opts.searchClient ?? null };
  const mode = await readMode();
  const open = await openRun(REVERSE_KIND);
  if (open) {
    if (!opts.resume) return { ok: false, refused: refusal("OPEN_RUN", REVERSE_WORDS.OPEN_RUN, { run: open.id }) };
    Object.assign(ctx, { runId: String(open.id), report: parseReport(open), at: String(open.step) });
    return finished(ctx, await continueRun(ctx));
  }
  const busy = await anyOpenRun();
  // --resume after a finished reversal whose last steps failed: do them again
  if (opts.resume && !busy && mode === "legacy") {
    const last = await lastDone();
    const lr = last ? parseReport(last) : null;
    if (last && (lr.search?.status === "failed" || !["reset", "env"].includes(lr.themePin?.status))) {
      Object.assign(ctx, { runId: String(last.id), report: lr, at: "reversed" });
      await afterSteps(ctx);
      return { ok: true, report: ctx.report, runId: ctx.runId, resumed: true };
    }
  }
  const mr = modeRefusal(mode, busy);
  if (mr) return { ok: false, refused: mr };

  // ---- preconditions (nothing written yet) ----
  const hr = hostedRefusal({ ...(opts.hosted || {}), tenantId: tenant, now: Date.parse(now()) });
  if (hr) return { ok: false, refused: hr };
  const missing = await missingMigrations();
  if (missing.length) return { ok: false, refused: refusal("NOT_MIGRATED", "This store's database is missing the updates the reversal needs. Apply them first (the runbook's first step: tenant:migrate -- --all).", { missing }) };
  const plan = await reversalPlan();
  const pr = planRefusal(plan);
  if (pr) return { ok: false, refused: pr, plan };
  const digest = await planDigest(plan);
  const dr = digestRefusal(opts.dryRunDigest, digest);
  if (dr) return { ok: false, refused: dr.code === "NO_DIGEST" ? refusal("NO_DIGEST", REVERSE_WORDS.NO_DIGEST) : refusal("STALE_DIGEST", REVERSE_WORDS.CHANGED.replace("so the store stayed on the new editor and nothing else changed", "so nothing was changed"), { given: dr.given, actual: digest }), plan };

  // ---- 1. lock ----
  const runId = newRunId();
  const at = now();
  const report = { tool: "reverse-documents", kind: REVERSE_KIND, tenant, runId, target: plan.target, digest, backupRef: opts.hosted?.backupRef ?? null, hosted: !!opts.hosted?.needed, startedAt: at, plan };
  if (__reverseTestHooks.beforeLock) await __reverseTestHooks.beforeLock();
  try {
    await lockBatch({ runId, at, report, digest });
  } catch (e) {
    const mine = await openRun(REVERSE_KIND).catch(() => null);
    if (!(mine && mine.id === runId)) {
      const c = await classifyAbort(libsql, e, "documents");
      if (c?.kind === "mode") return { ok: false, refused: modeRefusal(c.mode, await anyOpenRun()) || refusal("LOST_LOCK", REVERSE_WORDS.LOST_LOCK) };
      if (isGuardAbort(e)) return { ok: false, refused: refusal("LOST_LOCK", REVERSE_WORDS.LOST_LOCK) };
      throw e;
    }
  }
  if (__reverseTestHooks.afterLock) await __reverseTestHooks.afterLock();
  Object.assign(ctx, { runId, report, at: "locked" });
  return finished(ctx, await continueRun(ctx));
}

/** --abort: between step 1 and step 2 only. */
export async function abortReversal({ now = nowIso } = {}) {
  const open = await openRun(REVERSE_KIND);
  if (!open) {
    if ((await readMode()) === "legacy" && (await lastDone())) return { ok: false, refused: refusal("AFTER_REVERSAL", ABORT_WORDS.AFTER) };
    return { ok: false, refused: refusal("NOTHING", ABORT_WORDS.NOTHING) };
  }
  const report = { ...parseReport(open), outcome: "aborted" };
  const at = now();
  report.finishedAt = at;
  if (__reverseTestHooks.beforeAbort) await __reverseTestHooks.beforeAbort();
  try {
    await unlockBatch(String(open.id), report, { outcome: "aborted", at });
  } catch (e) {
    if (isGuardAbort(e)) return { ok: false, refused: refusal("NOT_PAUSED", ABORT_WORDS.NOT_PAUSED) };
    throw e;
  }
  return { ok: true, words: ABORT_WORDS.DONE, runId: String(open.id) };
}

/** --status: read only. */
export async function reverseStatus() {
  const mode = await readMode();
  const run = (await openRun(REVERSE_KIND)) || (await anyOpenRun());
  const last = run ? null : await latestRun(REVERSE_KIND);
  return { mode, run, report: run ? parseReport(run) : null, last, lastReport: last ? parseReport(last) : null };
}
