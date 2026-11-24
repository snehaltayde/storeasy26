// P6-POLICY-START (PUB-12, GEN-06 partly, US-41; owner answer OQ-P6-2): the
// policy starters. "Start a privacy page" and "Start a returns page" make a
// draft page from lib/content/templates.js for the founder to read. Node only
// (the console route app/api/admin/policy-start/route.js). Never publishes,
// never puts anything in a publish set, never writes to Shopify.
//
//   startPolicyPage({ kind, actor })        kind 'privacy' | 'returns'
//   markPolicyRead({ id, revision, actor })  "I've read it"
//   -> { status, body }: the route sends it as it is. Refusals are answers
//      here, not DocumentError codes (this file is outside lib/documents). An
//      error that isn't a refusal (the database didn't answer) is thrown, and
//      the route answers it through infraResponse.
//
// startPolicyPage, in order:
//   400 unknown kind
//   403 the actor can't edit (canEdit: storefront.write)
//   500 STORE_MODE_INVALID on a store not in documents mode (thrown, and
//       answered by the route through infraResponse)
//   409 POLICY_PAGE_EXISTS when the store has a page of that kind in any state
//       but 'missing' (policyStatus), naming it, with an editor link
//   then createDocument({ type: 'page' }) under POLICY_STARTER_ACTOR, so
//   updated_by is 'system:policy-starter': the "waiting for your review" mark.
//   A slug clash (SLUG_TAKEN) answers POLICY_PAGE_EXISTS when the page now at
//   that address is a page of that kind (a double click), and otherwise
//   SLUG_TAKEN's own words plus an editor link to the document that holds the
//   address (for example a campaign at /terms), so the founder can move it and
//   press Start again.
//
// The body: the template from templatesFor({ returnsWindowDays:
// returnsWindowDays(), plain: true }), read at the call, so the returns text
// always says the engine's window for this store, and the refund-timing day
// count no setting backs is left out (no unset promise); turned into a page with
// pageBodyFromTemplate (fresh section ids, the registry adapter, re-validated);
// then meta.slug and meta.description from the template.
//
// markPolicyRead re-saves the page's current draft, unchanged, under the
// founder (saveDraft), so its last writer is the founder and it counts as
// reviewed. Only for a page that is not archived and whose last writer is the
// policy starter.
//
// THE REVIEW RULE (owner answers OQ-P6-2 and OQ-P6-3; lib/documents/policy-pages.js):
// a policy page counts for opening and onboarding when it is live, in the
// publish set, or a draft whose last writer is not the policy starter (the
// founder saved it in the editor, pressed "I've read it", or it is the
// founder's own text from the cutover). A starter draft that was created but
// never saved by the founder does not count, unless the founder publishes it
// in the set.
import { libsql } from "../db.js";
import { getCmsMode } from "../cms-mode.js";
import { returnsWindowDays } from "../returns.js";
import { templatesFor, POLICY_STARTERS } from "../content/templates.js";
import { pageBodyFromTemplate } from "../admin/saved-templates.js";
import { canEdit } from "../admin/entity-entry.js";
import { editorHref } from "../admin/editor-entry.js";
import { createDocument, saveDraft, getDocument, actorString, DocumentError } from "../documents/service.js";
import { POLICY_KINDS, POLICY_STARTER_ACTOR, POLICY_STARTER_BY, policyStatus, readPolicyRows } from "../documents/policy-pages.js";
import { notMigratedYet } from "../schema-shape.js";
import { NotFoundError } from "../cms/issues.js";

const NOUN = Object.freeze({ privacy: "privacy page", returns: "returns page" });

export const POLICY_START_WORDS = Object.freeze({
  unknownKind: "We can only start a privacy page or a returns page. Pick one of those and try again.",
  readOnly: "You can look at this, but your role can't change it. Ask the store owner or an admin.",
  // P6-FIX1: "by you" only when the last writer is this actor; anyone else
  // (another staff member, the cutover's system:cutover, a different session
  // kind) gets alreadySavedOther, which names no one
  alreadySaved: "This page was already saved by you.",
  alreadySavedOther: "This page was already saved, so it already counts as reviewed. Open it in the editor to read it.",
  notStarter: "This isn't a page we started for you, so there is nothing to mark as read. Open it in the editor instead.",
  gone: "This page no longer exists. It may have been deleted. Reload to see your pages.",
  badRequest: "We couldn't tell which page you meant. Reload the page and try again.",
});

export const startedMessage = (kind) =>
  `We started your ${NOUN[kind]} from a template. It's a starting point, not legal advice: read it, change what you need and save it.`;
export const existsMessage = (kind, title) => `You already have a ${NOUN[kind]}: ${title}. Open it to read it.`;
export const READ_MESSAGE = "Marked as read. This page now counts as yours.";

const answer = (status, body) => ({ status, body });
const docAnswer = (e) => answer(e.status, { error: e.message, code: e.code, ...e.extra });


const existing = (kind, doc) =>
  answer(409, {
    error: existsMessage(kind, doc.doc.label),
    code: "POLICY_PAGE_EXISTS",
    document: { id: doc.doc.id, title: doc.doc.label, state: doc.state },
    href: editorHref(doc.doc.id),
  });

// The page body a starter writes, from the template (the store's returns
// window read now). Exported for the tests.
export function starterBody(kind) {
  const id = POLICY_STARTERS[kind];
  const tpl = templatesFor({ returnsWindowDays: returnsWindowDays(), plain: true }).find((t) => t.id === id);
  if (!tpl) throw new Error(`policy-start: no template "${id}"`);
  const { body } = pageBodyFromTemplate({ family: "page", name: tpl.page.title, sections: tpl.page.sections });
  return { ...body, meta: { ...body.meta, slug: tpl.page.slug, description: tpl.page.description } };
}

export async function startPolicyPage({ kind, actor = null } = {}) {
  if (!POLICY_KINDS.includes(kind)) return answer(400, { error: POLICY_START_WORDS.unknownKind, code: "UNKNOWN_POLICY_KIND" });
  if (!canEdit(actor)) return answer(403, { error: POLICY_START_WORDS.readOnly, code: "READ_ONLY" });
  // the documents-mode check: any other mode, or one that can't be read, throws (a 5xx)
  await getCmsMode();

  const before = policyStatus(await readPolicyRows())[kind];
  if (before.state !== "missing") return existing(kind, before);

  const body = starterBody(kind);
  let created;
  try {
    created = await createDocument({ type: "page", body, actor: POLICY_STARTER_ACTOR });
  } catch (e) {
    if (!(e instanceof DocumentError)) throw e;
    if (e.code !== "SLUG_TAKEN") return docAnswer(e);
    // a page of this kind now holds the address (a double click): name it
    const now = policyStatus(await readPolicyRows())[kind];
    if (now.state !== "missing") return existing(kind, now);
    // something else holds it (a campaign or journal post, or a page another
    // rule reads): its own words and a way to it, so the founder is never stuck
    const other = e.extra?.other ?? null;
    return answer(409, { error: e.message, code: "SLUG_TAKEN", slug: e.extra?.slug ?? body.meta.slug, document: other, href: editorHref(other?.id ?? null) });
  }
  const d = created.document;
  return answer(200, {
    ok: true,
    document: { id: d.id, revision: d.revision, slug: d.slug, title: d.label, kind },
    href: editorHref(d.id),
    message: startedMessage(kind),
  });
}

// Who wrote the page last, and what it is. listDocuments and getDocument
// don't carry updated_by to callers, so it is read here, once.
async function lastWriter(id) {
  let r;
  try {
    r = await libsql.execute({ sql: "SELECT type, archived_at, updated_by FROM documents WHERE id = ?", args: [id] });
  } catch (e) {
    if (notMigratedYet(e, { table: "documents" })) return null;
    throw e;
  }
  const row = r.rows[0];
  return row ? { type: String(row.type), archivedAt: row.archived_at == null ? null : String(row.archived_at), updatedBy: row.updated_by == null ? null : String(row.updated_by) } : null;
}

export async function markPolicyRead({ id, revision, actor = null } = {}) {
  if (typeof id !== "string" || !id) return answer(400, { error: POLICY_START_WORDS.badRequest, code: "BAD_REQUEST" });
  if (!canEdit(actor)) return answer(403, { error: POLICY_START_WORDS.readOnly, code: "READ_ONLY" });
  await getCmsMode();

  const w = await lastWriter(id);
  if (!w) return answer(404, { error: POLICY_START_WORDS.gone, code: "NOT_FOUND" });
  if (w.archivedAt) return answer(409, { error: "This page was archived, so nothing was saved. Reload to see your pages.", code: "DOCUMENT_ARCHIVED" });
  if (w.type !== "page") return answer(409, { error: POLICY_START_WORDS.notStarter, code: "NOT_A_STARTER" });
  if (w.updatedBy !== POLICY_STARTER_BY) {
    const mine = w.updatedBy != null && w.updatedBy === actorString(actor);
    return answer(409, { error: mine ? POLICY_START_WORDS.alreadySaved : POLICY_START_WORDS.alreadySavedOther, code: "ALREADY_SAVED" });
  }
  try {
    const d = await getDocument(id);
    // the current draft, unchanged, under the founder; saveDraft refuses a
    // stale revision (409 DOCUMENT_CHANGED) and a missing one (428)
    const saved = await saveDraft({ id, revision, body: d.body, actor });
    const s = saved.document;
    return answer(200, { ok: true, document: { id: s.id, revision: s.revision, slug: s.slug, title: s.label, draftHash: s.draftHash }, href: editorHref(s.id), message: READ_MESSAGE });
  } catch (e) {
    if (e instanceof DocumentError) return docAnswer(e);
    if (e instanceof NotFoundError) return answer(404, { error: POLICY_START_WORDS.gone, code: "NOT_FOUND" });
    throw e;
  }
}
