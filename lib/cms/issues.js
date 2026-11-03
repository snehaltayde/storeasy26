// One result for save, preview and publish (DOC-04). Pure, with no imports
// beyond the registry's labels, so the server, the edge storefront and the
// console editors all read the SAME shape from this one module.
//
// An issue is exactly:
//   { documentId, sectionId, blockId, field, code, severity, message, autoFix }
//
// Phase 1 (today's system, before documents exist):
//   documentId  the section 8.3 document the content becomes: doc_home (hero and
//               home sections), doc_announcement, doc_header, doc_footer,
//               doc_design, doc_collections_index, doc_product_layout. null for
//               content pages and templates, whose ids DOC-01 mints.
//   sectionId   the durable section id ("sec_…"), or "hero" for the hero, which
//               becomes a real section at DOC-07. null when no section applies.
//   blockId     null. Nested blocks arrive with TREE-02.
//   field       the setting's key, or a path into a list: "items.2.label",
//               "items.0.children.1.href". The editor turns it into words.
//   severity    "error" blocks the save or publish; "warning" rides along.
//   message     plain words, WITHOUT a position. The editor works out "section
//               2" from sectionId against what is on screen, so the number can
//               never go stale or disagree with the form.
//   autoFix     null. Reserved: nothing offers an automatic fix in phase 1.
//
// Validation problems are 422 with the full issue list. Infrastructure
// problems (database down, table missing, timeouts, our own bugs) are 5xx with
// a code and a plain message, and never carry an issue list, so a database
// error can never look like something the founder typed wrong.
import { COMPONENTS } from "./registry.js";

export const ISSUE_KEYS = ["documentId", "sectionId", "blockId", "field", "code", "severity", "message", "autoFix"];

// The hero has no sec_ id until DOC-07 makes it a section. The Designer's
// preview bridge already calls it "hero" (data-sec="hero"), so issues do too.
export const HERO_SECTION_ID = "hero";

// cms_blocks key -> the section 8.3 document it becomes.
export const BLOCK_DOCUMENTS = {
  hero: "doc_home",
  home_sections: "doc_home",
  announcement: "doc_announcement",
  nav_header: "doc_header",
  nav_footer: "doc_footer",
  collections_index: "doc_collections_index",
  pdp_extras: "doc_product_layout",
  surface_templates: null, // spans several documents; the field names the surface
};

export function issue({ documentId = null, sectionId = null, blockId = null, field = null, code, severity = "error", message, autoFix = null }) {
  if (!code || typeof code !== "string") throw new Error("an issue needs a code");
  if (!message || typeof message !== "string") throw new Error("an issue needs a message");
  if (severity !== "error" && severity !== "warning") throw new Error(`unknown issue severity "${severity}"`);
  return { documentId, sectionId, blockId, field, code, severity, message, autoFix };
}

export const errorIssues = (issues) => (issues || []).filter((i) => i.severity === "error");
export const warningIssues = (issues) => (issues || []).filter((i) => i.severity === "warning");
// Messages only, for callers that log or show a flat list (kits, experiments,
// tests). They carry no position, by design.
export const messagesOf = (issues) => (issues || []).map((i) => i.message);

// A save, preview push or publish refused because of what was typed. Carries
// EVERY issue found, not the first.
export class ValidationError extends Error {
  constructor(issues) {
    const list = Array.isArray(issues) ? issues : [];
    super(list.map((i) => i.message).join(" · ") || "validation failed");
    this.name = "ValidationError";
    this.code = "VALIDATION_FAILED";
    this.status = 422;
    this.issues = list;
  }
}
export const isValidationError = (e) => e instanceof ValidationError || (e?.code === "VALIDATION_FAILED" && Array.isArray(e?.issues));

// A request for something that isn't there (a template, a release). 404, not
// a validation problem.
export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.code = "NOT_FOUND";
    this.status = 404;
  }
}

// ---- infrastructure -----------------------------------------------------------

// The schema this code expects isn't there yet: a tenant database that missed
// a migration. Retrying won't help; an operator has to run the migration.
const MISSING_SCHEMA = /no such table|no such column|has no column named/i;
// A write that broke a uniqueness rule. On a CMS save this means two saves
// raced (DOC-02: a race is a 409, never a 422).
const CONSTRAINT = /SQLITE_CONSTRAINT|constraint failed/i;
// The database didn't answer, or couldn't do the work right now.
const UNAVAILABLE =
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timed out|timeout|network|connection (?:closed|reset|refused)|ConnectionFailed|unable to open (?:database|connection)|database is locked|SQLITE_BUSY|SQLITE_LOCKED|SQLITE_IOERR|disk I\/O error|SQLITE_READONLY|readonly database|SQLITE_FULL|database or disk is full|SQLITE_CANTOPEN|SERVER_ERROR|HRANA|HTTP_STATUS/i;

const describe = (e) => `${e?.name || ""} ${e?.code || ""} ${e?.message || (typeof e === "string" ? e : "")}`;

// What kind of infrastructure failure this is, or null when it isn't one.
// Looks through `cause` too, because our own wrappers (the release snapshot)
// re-throw with context.
export function infraKind(e) {
  for (let cur = e, depth = 0; cur && depth < 4; cur = cur.cause, depth++) {
    const text = describe(cur);
    if (MISSING_SCHEMA.test(text)) return "schema";
    if (CONSTRAINT.test(text)) return "conflict";
    if (UNAVAILABLE.test(text)) return "unavailable";
    if (cur.name === "LibsqlError" || cur.name === "LibsqlBatchError" || cur.name === "SqliteError" || /^SQLITE_/.test(String(cur.code || ""))) return "database";
  }
  return null;
}
export const isInfrastructureError = (e) => !isValidationError(e) && infraKind(e) != null;

// What the founder was doing, for the message: nothing is "saved" by a
// publish, and a preview push changes nothing at all.
const OUTCOME = {
  save: "nothing was saved. Your changes are still here",
  preview: "the preview didn't update. Your changes are still here",
  publish: "nothing was published. Your live store hasn't changed",
  load: "this couldn't load",
};

export const INFRA_CODES = {
  schema: { status: 503, code: "DATABASE_NOT_READY" },
  unavailable: { status: 503, code: "DATABASE_UNAVAILABLE" },
  database: { status: 503, code: "DATABASE_ERROR" },
  conflict: { status: 409, code: "SAVE_CONFLICT" },
  internal: { status: 500, code: "INTERNAL_ERROR" },
};

export function infraMessage(kind, doing = "save") {
  const outcome = OUTCOME[doing] || OUTCOME.save;
  if (kind === "schema") return `Your store needs an update on our side first, so ${outcome}. Please contact support and we'll finish it.`;
  if (kind === "unavailable" || kind === "database") return `We couldn't reach your store's data just now, so ${outcome}. Try again in a minute.`;
  if (kind === "conflict") return `Someone else saved at the same moment, so ${outcome}. Reload to see their version, then try again.`;
  return `Something went wrong on our side, so ${outcome}. Try again, and contact support if it keeps happening.`;
}

// Any caught error -> { status, body, kind }. ValidationError -> 422 with the
// issues. A deliberate 4xx (NotFoundError, a refusal that set e.status and
// e.expose) keeps its status. Everything else is ours, never the founder's:
// 5xx with a code, and a 409 for a uniqueness race. The raw message never
// reaches the body; the caller logs it.
export function failure(e, { doing = "save" } = {}) {
  if (isValidationError(e)) return { status: 422, kind: "validation", body: validationBody(e.issues) };
  if (e instanceof NotFoundError) return { status: 404, kind: "not_found", body: { error: e.message, code: e.code } };
  const kind = infraKind(e) || "internal";
  const { status, code } = INFRA_CODES[kind];
  return { status, kind, body: { error: infraMessage(kind, doing), code, retryable: kind !== "schema" } };
}

// The 422 body. `error` is a one-line summary; `issues` is the full list;
// `errors` and `warnings` are the messages alone, for older readers.
export function validationBody(issues, extra = {}) {
  const errs = errorIssues(issues);
  const summary = errs.length === 1 ? "There's 1 thing to fix" : `There are ${errs.length} things to fix`;
  return { error: summary, code: "VALIDATION_FAILED", issues, errors: messagesOf(errs), warnings: messagesOf(warningIssues(issues)), ...extra };
}

// ---- words for the editor --------------------------------------------------------

const DOCUMENT_LABELS = {
  doc_home: "Homepage",
  doc_announcement: "Announcement bar",
  doc_header: "Header menu",
  doc_footer: "Footer menu",
  doc_design: "Brand",
  doc_collections_index: "Collections page",
  doc_product_layout: "Product page accordions",
};
const ITEM_NOUNS = { doc_header: "item", doc_footer: "item", doc_product_layout: "accordion" };

const sectionKey = (s) => s?.pid ?? s?.id;
export const kindLabel = (kind) => COMPONENTS[kind]?.label || kind || "section";

// Where an issue is, in words, worked out from its ids against the list the
// reader is looking at. ctx.sections: the sections on screen (editor form
// rows carry the durable id as `pid`, stored sections as `id`).
// ctx.sectionLabel(section, index): how this screen names a section.
// ctx.itemNumber(section, j): the on-screen number of item j in a section,
// when the screen holds rows the payload left out.
export function issueWhere(issue, ctx = {}) {
  const parts = [];
  let section = null;
  if (issue.sectionId === HERO_SECTION_ID) {
    if (ctx.documentLabels !== false) parts.push("Hero");
  } else if (issue.sectionId) {
    const list = Array.isArray(ctx.sections) ? ctx.sections : [];
    const at = list.findIndex((s) => sectionKey(s) === issue.sectionId);
    if (at >= 0) {
      section = list[at];
      parts.push(ctx.sectionLabel ? ctx.sectionLabel(section, at) : `Section ${at + 1} (${kindLabel(section.kind)})`);
    } else parts.push(issue.documentId === "doc_home" ? "A homepage section" : "A section");
  } else if (issue.documentId && DOCUMENT_LABELS[issue.documentId] && ctx.documentLabels !== false) parts.push(DOCUMENT_LABELS[issue.documentId]);

  const m = /^items\.(\d+)(?:\.children\.(\d+))?/.exec(issue.field || "");
  if (m) {
    const j = Number(m[1]);
    const n = section && ctx.itemNumber ? ctx.itemNumber(section, j) : j + 1;
    const noun = section?.kind === "faq" ? "question" : ITEM_NOUNS[issue.documentId] || "item";
    parts.push(`${noun} ${n}`);
    if (m[2] != null) parts.push(`sub-item ${Number(m[2]) + 1}`);
  }
  return parts.join(", ");
}

export function issueText(issue, ctx = {}) {
  const where = issueWhere(issue, ctx);
  return where ? `${where}: ${issue.message}` : issue.message;
}
