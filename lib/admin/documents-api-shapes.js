// P3-SCAFFOLD (phase 3 plan decision 3): the one response contract of the
// documents console API (PUT /api/admin/documents, lib/admin/documents-api.js)
// for phase 3. Data only: no imports, no functions, edge-safe.
//
// Who reads it:
//   - the batch 1 and 2 server tests assert each response they get against the
//     example of that outcome here (the same keys, all the way down);
//   - P3-SESSION's client (components/admin/editor/documentsApi.js) imports it,
//     and its tests feed every example below to the client's mapper;
//   - P3-PUBLISHUI and the other editor parts render these examples (SSR).
//
// Shape of this file:
//   SHAPES[operation] = {
//     request:          an example request body, exactly as the editor sends it;
//     requestOptional?: key paths of the request that may be left out;
//     access:           the capability requireAdmin checks for it;
//     outcomes:         { name: { status, since, body, optional?, addedInPhase3? } },
//     sameOutcomesAs?:  the operation whose outcomes this one shares, instead
//                       of its own `outcomes` (publishSet answers what publish
//                       answers). A walker must follow it: publishSet has no
//                       outcomes key.
//   }
//   COMMON.outcomes: the outcomes any operation can give (400 parse, 401/403,
//   404, 428, 5xx, 501) unless the operation lists its own.
//
//   status    the HTTP status of that outcome.
//   since     "p2": the API emits it today (code and fields copied from
//             lib/admin/documents-api.js, lib/documents/*.js and
//             lib/cms/issues.js, nothing renamed); "p3": added in phase 3.
//             An outcome is "p3" when it is new, even if its code is reused
//             from today (PUBLISHED_ELSEWHERE for Undo, for example).
//   body      one example of the whole body: every key it carries. Values are
//             examples of the right type, never real data.
//   optional  key paths that may be absent from a real body, written with
//             "[]" for "every element", e.g. "rows[].note". Every key not
//             listed here is always present. The example still shows every
//             optional key, so its type is known. A key whose value may be
//             null is not optional: it is present with null (its comment says so).
//
// Fields marked "p3" inside a "p2" outcome are added to that outcome in phase 3
// (the owner item is named); until then the API leaves them out. They are
// listed in `addedInPhase3` on that outcome so a phase 2 response can still be
// compared against the rest.
//
// Plain words: every `error` and `message` is founder-facing text. No code,
// hash, raw actor id or version id is ever shown to the founder; the ids in
// these bodies are for the editor only.

export const SHAPES_VERSION = 1;

// ---- shared pieces -------------------------------------------------------------------
// Written out again in each body below (no references), so each example reads
// on its own. These are the named pieces the bodies are made of.

// An issue as lib/cms/issues.js issue() makes it (ISSUE_KEYS). severity is
// "error", "warning" or "incomplete" (draft mode). Any of the position keys
// may be null.
export const ISSUE = {
  documentId: "doc_home",
  sectionId: "sec_hero",
  blockId: null,
  field: "title",
  code: "REQUIRED",
  severity: "error",
  message: "Add a title.",
  autoFix: null,
};

// A publish issue (P3-CHECKS): the issue above plus
//   level    "blocks" | "warns" | "inherited"
//   anchor   the field anchor the editor scrolls to, P3-VALIDATE's
//            fieldAnchor(): "f-<sectionId, or doc for a document-level
//            field>-<field path with . turned into ->" ("f-sec_hero-title")
//   where    plain words for where it is, "<section> · <field>" ("Hero · Title",
//            the "Banner · Button" form)
//   actions  what the founder can do about it, at least one, each one of
//            {type: "hideSection",   documentId, sectionId}   a block in a section
//            {type: "removeSection", documentId, sectionId}   a structure block in
//                                    a section, or a reference warning there
//            {type: "removeItem",    documentId, sectionId?, field, index}
//                                    one entry of a list (a product, a menu
//                                    item, an old address); sectionId only
//                                    inside a section
//            {type: "publishBoth",   documentId}              publish the link's
//                                    target with this (its offer.publishSet entry)
//            {type: "openField",     documentId, sectionId?, field?}
//                                    go to the field (P3-CHECKS: when nothing
//                                    else fits, so every issue has an action)
// level (P3-CHECKS, lib/documents/checks.js levelOf):
//   blocks     severity "error": nothing is published
//   warns      a warning, or an error in a hidden section
//   inherited  already live like this (classify's id-stripped section
//              compare), or a design colour pair unchanged from live
export const PUBLISH_ISSUE = {
  ...ISSUE,
  level: "blocks",
  anchor: "f-sec_hero-title",
  where: "Hero · Title",
  actions: [
    { type: "hideSection", documentId: "doc_home", sectionId: "sec_hero" },
    { type: "removeItem", documentId: "doc_home", sectionId: "sec_hero", field: "buttons", index: 1 },
  ],
};
export const PUBLISH_ISSUE_OPTIONAL = ["actions[].sectionId", "actions[].field", "actions[].index"];
export const PUBLISH_ACTION_TYPES = ["hideSection", "removeSection", "removeItem", "publishBoth", "openField"];

// A document as the console gets it: lib/documents/service.js fromRow() plus
// publicDocument() (live, unpublishedChanges). slug, entityId,
// publishedVersionId, publishedHash, undoneVersionId and archivedAt may be null.
export const DOCUMENT = {
  id: "doc_home",
  type: "home",
  slug: null,
  entityId: null,
  label: "Home page",
  body: { type: "home", sections: [] },
  draftHash: "h_draft",
  revision: 3,
  schemaVersion: 1,
  publishedVersionId: "ver_live",
  publishedHash: "h_live",
  undoneVersionId: null,
  archivedAt: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-02T10:00:00.000Z",
  live: true,
  unpublishedChanges: true,
};

// P3-COMMIT: getDocument's document and every listDocuments row carry what
// this actor may do with it. reason is null when canPublish is true; for staff
// it is "Only the store owner or an admin can publish. You can edit and preview."
export const ACCESS = { canPublish: false, reason: "Only the store owner or an admin can publish. You can edit and preview." };

// The `current` of a 409 refusal: the document as it is now (DOCUMENT), plus
// (P3-CHANGES, service.js stale 409; P3-UNDO for PUBLISHED_ELSEWHERE;
// P3-CHECKS for the publish conflicts DOCUMENT_CHANGED, DRAFT_CHANGED and
// PUBLISHED_ELSEWHERE, sent from batch 2)
//   updatedBy      who saved it last, "<kind>:<id>" (for the editor only); null
//                  when nobody is recorded
//   updatedByName  that person's plain name; "another tab" for the same actor
export const CURRENT = { ...DOCUMENT, updatedBy: "merchant:usr_1", updatedByName: "Asha" };

// A set the founder may publish instead (P3-CHECKS): the documents and the
// revision and draft hash the server saw, to send back as publishSet.
export const OFFER = {
  publishSet: [
    { id: "doc_home", revision: 3, draftHash: "h_draft", label: "Home page" },
    { id: "doc_7Q2M4K8P1R5T9V3X", revision: 2, draftHash: "h_draft2", label: "Diwali sale" },
  ],
};

// Undo arguments for one published row (P3-CHECKS on publish, P3-UNDO on
// listRecentlyPublished): send as { undo: { id, logId }, revision }.
export const UNDO_ARGS = { id: "doc_home", revision: 4, logId: "log_1" };

// A dry run of undo, unpublish or undoSet (P3-UNDO): nothing is written.
//   willTakeOffline  true when this would take a page offline
//   linkers          live documents that link to it (document_refs)
//   changes          what would change, in words (lib/documents/diff.js)
//   target           the version it goes back to, or null when it goes offline
//                    (and for a set)
export const DRY_RUN = {
  ok: true,
  willTakeOffline: false,
  linkers: [{ id: "doc_7Q2M4K8P1R5T9V3X", label: "Diwali sale" }],
  changes: [{ words: "Hero: title changed" }],
  target: { versionId: "ver_prev", name: "Published 2 Nov, 10:00 by Asha" },
};

// ---- outcomes every operation can give -----------------------------------------------

const UNREADABLE = "The editor sent something we couldn't read, so nothing was saved. Reload the page and try again.";
const UNREADABLE_PUBLISH = "The editor sent something we couldn't read, so nothing was published. Reload the page and try again.";

export const COMMON = {
  outcomes: {
    // parseDocumentsOperation, before any authorization (documents-api.js).
    // P3-COMMIT: for publish operations the words say "…nothing was published…".
    noOperation: { status: 400, since: "p2", body: { error: UNREADABLE, code: "NO_OPERATION" } },
    unknownOperation: { status: 400, since: "p2", body: { error: UNREADABLE, code: "UNKNOWN_OPERATION" } },
    ambiguousOperation: { status: 400, since: "p2", body: { error: UNREADABLE, code: "AMBIGUOUS_OPERATION" } },
    malformed: { status: 400, since: "p2", body: { error: UNREADABLE, code: "MALFORMED" } },
    // P3-COMMIT: a malformed publish, publishSet, unpublish, undo or undoSet
    malformedPublish: { status: 400, since: "p3", body: { error: UNREADABLE_PUBLISH, code: "MALFORMED" } },
    // requireAdmin (lib/admin-auth.js): no code, by design. 403 names the
    // role: "Your role (<role>) can't do that" (staff here).
    unauthorized: { status: 401, since: "p2", body: { error: "Unauthorized" } },
    forbidden: { status: 403, since: "p2", body: { error: "Your role (staff) can't do that" } },
    // NotFoundError through failure() (lib/cms/issues.js).
    notFound: { status: 404, since: "p2", body: { error: "This page no longer exists. It may have been deleted. Reload to see your pages.", code: "NOT_FOUND" } },
    // ValidationError through failure(): validationBody(issues).
    validationFailed: {
      status: 422,
      since: "p2",
      body: { error: "There's 1 thing to fix", code: "VALIDATION_FAILED", issues: [ISSUE], errors: ["Add a title."], warnings: [] },
    },
    // infrastructure, through failure() (INFRA_CODES): never the founder's.
    databaseNotReady: { status: 503, since: "p2", body: { error: "Your store needs an update on our side first, so nothing was saved. Your changes are still here. Please contact support and we'll finish it.", code: "DATABASE_NOT_READY", retryable: false } },
    databaseUnavailable: { status: 503, since: "p2", body: { error: "We couldn't reach your store's data just now, so nothing was saved. Your changes are still here. Try again in a minute.", code: "DATABASE_UNAVAILABLE", retryable: true } },
    databaseError: { status: 503, since: "p2", body: { error: "We couldn't reach your store's data just now, so nothing was saved. Your changes are still here. Try again in a minute.", code: "DATABASE_ERROR", retryable: true } },
    saveConflict: { status: 409, since: "p2", body: { error: "Someone else saved at the same moment, so nothing was saved. Your changes are still here. Reload to see their version, then try again.", code: "SAVE_CONFLICT", retryable: true } },
    internalError: { status: 500, since: "p2", body: { error: "Something went wrong on our side, so nothing was saved. Your changes are still here. Try again, and contact support if it keeps happening.", code: "INTERNAL_ERROR", retryable: true } },
    // P3-COMMIT: the stubs in lib/documents/undo.js and changes.js until
    // their owners land (NotBuiltError, lib/documents/build.js).
    notBuilt: { status: 501, since: "p3", body: { error: "This isn't available yet.", code: "NOT_BUILT" } },
  },
};

// The two legacy refusals (documents-api.js LEGACY and the publish variant).
// P3-COMMIT: listChanges and listRecentlyPublished answer the read variant.
const LEGACY_SAVE = { status: 409, since: "p2", body: { error: "This store still uses the current Storefront editor, so nothing was saved here. Make this change in Storefront instead.", code: "STORE_USES_LEGACY" } };
const LEGACY_PUBLISH = { status: 409, since: "p2", body: { error: "This store still uses the current Storefront editor, so nothing was published here. Publish from Storefront instead.", code: "STORE_USES_LEGACY" } };
const LEGACY_READ = { status: 409, since: "p3", body: { error: "This store still uses the current Storefront editor, so this isn't available here yet.", code: "STORE_USES_LEGACY" } };

const REVISION_SAVE = { status: 428, since: "p2", body: { error: "The editor didn't say which version you started from, so nothing was saved. Reload the page and try again.", code: "REVISION_REQUIRED" } };
const REVISION_PUBLISH = { status: 428, since: "p2", body: { error: "The editor didn't say which version you started from, so nothing was published. Reload the page and try again.", code: "REVISION_REQUIRED" } };

// service.js stale(): 409 with the current document.
const CHANGED_SAVE = {
  status: 409,
  since: "p2",
  addedInPhase3: ["current.updatedBy", "current.updatedByName"],
  body: { error: "This page was changed somewhere else since you opened it, so nothing was saved. Your changes are still here: compare them with the current version, then save again.", code: "DOCUMENT_CHANGED", current: CURRENT },
};
const ARCHIVED_SAVE = { status: 409, since: "p2", body: { error: "This page was archived, so nothing was saved. Reload to see your pages.", code: "DOCUMENT_ARCHIVED", current: DOCUMENT } };
// service.js slugTaken(): `other` is null when the other page couldn't be
// read back. P3: other gains `label` (the document's label) beside today's
// `title` (its meta title, else its label); `title` is kept, not renamed.
const SLUG_TAKEN_SAVE = {
  status: 409,
  since: "p2",
  addedInPhase3: ["other.label"],
  body: { error: "Another page already uses /about: About us", code: "SLUG_TAKEN", slug: "about", other: { id: "doc_7Q2M4K8P1R5T9V3X", title: "About us", label: "About us" } },
};
const CART_LOCKED = { status: 409, since: "p2", body: { error: "Cart suggestions can't be changed here yet, so nothing was saved. Change them on the Upsells screen for now.", code: "CART_NOT_AVAILABLE" } };

// A draft write's 200: the document and the issues that ride along
// (incomplete and warnings; draft mode never refuses for those).
const SAVED = { status: 200, since: "p2", body: { ok: true, document: DOCUMENT, issues: [{ ...ISSUE, severity: "incomplete" }] } };

// The busy and unknown answers of a guarded build (publish.js; P3-UNDO reuses
// them through runGuardedBuild).
const PUBLISH_BUSY = { status: 503, since: "p2", body: { error: "Publishing is busy, try again in a moment: nothing was published. Your live store hasn't changed.", code: "PUBLISH_BUSY" } };
const PUBLISH_UNKNOWN = { status: 503, since: "p2", body: { error: "Your publish may have gone live. Reload to check.", code: "PUBLISH_UNKNOWN", release: { id: "rel_1" } } };
const PUBLISH_FAILED = { status: 500, since: "p2", body: { error: "Something went wrong on our side, so nothing was published. Your live store hasn't changed. Try again, and contact support if it keeps happening.", code: "PUBLISH_FAILED", reason: "THREW" } };
const DOCUMENT_DELETED = { status: 404, since: "p2", body: { error: "This page was deleted while you were publishing. Reload to see the current pages.", code: "DOCUMENT_DELETED", missing: ["doc_home"] } };

// ---- operations ----------------------------------------------------------------------

export const SHAPES = {
  // ---- reads (storefront.read) ----
  getDocument: {
    access: "storefront.read",
    request: { getDocument: "doc_home" }, // or { getDocument: { id } }
    outcomes: {
      ok: { status: 200, since: "p2", addedInPhase3: ["document.access"], body: { ok: true, document: { ...DOCUMENT, access: ACCESS } } },
      notFound: COMMON.outcomes.notFound,
    },
  },
  listDocuments: {
    access: "storefront.read",
    request: { listDocuments: { type: "page", includeArchived: false } }, // or { listDocuments: true }
    outcomes: {
      // service.js listDocuments(): no body. slug, entityId and archivedAt may be null.
      ok: {
        status: 200,
        since: "p2",
        addedInPhase3: ["documents[].access"],
        body: {
          ok: true,
          documents: [
            { id: "doc_home", type: "home", slug: null, entityId: null, label: "Home page", revision: 3, live: true, unpublishedChanges: true, archivedAt: null, updatedAt: "2026-11-02T10:00:00.000Z", access: ACCESS },
          ],
        },
      },
    },
  },
  listHistory: {
    access: "storefront.read",
    request: { listHistory: "doc_home" }, // or { listHistory: { id } }
    outcomes: {
      // versions.js listVersions(): by is a plain name, never a raw actor id;
      // note may be null. kind: checkpoint, published, undo_saved.
      ok: { status: 200, since: "p2", body: { ok: true, versions: [{ id: "ver_1", kind: "published", createdAt: "2026-11-02T10:00:00.000Z", by: "Asha", note: null, live: true }] } },
      notFound: COMMON.outcomes.notFound,
    },
  },

  // ---- draft writes (storefront.write) ----
  createDocument: {
    access: "storefront.write",
    request: { createDocument: { type: "page", meta: { slug: "about", title: "About us" }, body: null, entityId: null } },
    outcomes: {
      ok: SAVED,
      legacy: LEGACY_SAVE,
      // `current` only when the existing document could be read (a singleton).
      exists: { status: 409, since: "p2", optional: ["current"], body: { error: "Home page already exists, so nothing new was made. Reload to open it.", code: "DOCUMENT_EXISTS", current: DOCUMENT } },
      slugTaken: SLUG_TAKEN_SAVE,
      cartLocked: CART_LOCKED,
      validationFailed: COMMON.outcomes.validationFailed,
    },
  },
  saveDraft: {
    access: "storefront.write",
    request: { saveDraft: { id: "doc_home", body: { type: "home", sections: [] } }, revision: 3 },
    outcomes: {
      ok: SAVED,
      legacy: LEGACY_SAVE,
      revisionRequired: REVISION_SAVE,
      changed: CHANGED_SAVE,
      archived: ARCHIVED_SAVE,
      slugTaken: SLUG_TAKEN_SAVE,
      cartLocked: CART_LOCKED,
      notFound: COMMON.outcomes.notFound,
      validationFailed: COMMON.outcomes.validationFailed,
    },
  },
  discardDraft: {
    access: "storefront.write",
    request: { discardDraft: "doc_home", revision: 3 },
    outcomes: {
      ok: SAVED,
      legacy: LEGACY_SAVE,
      revisionRequired: REVISION_SAVE,
      nothingPublished: { status: 409, since: "p2", body: { error: "Home page has never been published, so there is no live version to go back to.", code: "NOTHING_PUBLISHED" } },
      changed: CHANGED_SAVE,
      archived: ARCHIVED_SAVE,
      slugTaken: SLUG_TAKEN_SAVE,
      cartLocked: CART_LOCKED,
      notFound: COMMON.outcomes.notFound,
      validationFailed: COMMON.outcomes.validationFailed,
    },
  },
  restoreVersion: {
    access: "storefront.write",
    request: { restoreVersion: { id: "doc_home", versionId: "ver_1" }, revision: 3 },
    outcomes: {
      ok: SAVED,
      legacy: LEGACY_SAVE,
      revisionRequired: REVISION_SAVE,
      changed: CHANGED_SAVE,
      archived: ARCHIVED_SAVE,
      slugTaken: SLUG_TAKEN_SAVE,
      cartLocked: CART_LOCKED,
      notFound: COMMON.outcomes.notFound,
      validationFailed: COMMON.outcomes.validationFailed,
    },
  },
  archive: {
    access: "storefront.write",
    request: { archive: "doc_7Q2M4K8P1R5T9V3X", revision: 2 },
    outcomes: {
      ok: { status: 200, since: "p2", body: { ok: true, document: { ...DOCUMENT, archivedAt: "2026-11-02T10:00:00.000Z", live: false, publishedVersionId: null, publishedHash: null }, issues: [] } },
      legacy: LEGACY_SAVE,
      revisionRequired: REVISION_SAVE,
      cannotArchive: { status: 409, since: "p2", body: { error: "The header is part of every store, so it can't be archived.", code: "CANNOT_ARCHIVE" } },
      live: { status: 409, since: "p2", body: { error: "This page is live. Take it offline first, then archive it.", code: "DOCUMENT_LIVE" } },
      changed: CHANGED_SAVE,
      archived: ARCHIVED_SAVE,
      notFound: COMMON.outcomes.notFound,
    },
  },
  // P3-CHANGES (lib/documents/changes.js): the live version of one section
  // goes back into the draft. A checkpoint is written first.
  keepLiveSection: {
    access: "storefront.write",
    request: { keepLiveSection: { id: "doc_home", sectionId: "sec_banner" }, revision: 3 },
    outcomes: {
      ok: { status: 200, since: "p3", body: { ok: true, document: DOCUMENT } },
      legacy: LEGACY_SAVE,
      revisionRequired: REVISION_SAVE,
      changed: CHANGED_SAVE,
      archived: ARCHIVED_SAVE,
      notFound: COMMON.outcomes.notFound,
      validationFailed: COMMON.outcomes.validationFailed,
      notBuilt: COMMON.outcomes.notBuilt,
    },
  },
  // P3-CHANGES: keeps a body (another tab's draft) as an undo_saved version.
  // No revision: the draft, revision and hash never change.
  keepAsEarlierDraft: {
    access: "storefront.write",
    request: { keepAsEarlierDraft: { id: "doc_home", body: { type: "home", sections: [] } } },
    outcomes: {
      ok: { status: 200, since: "p3", body: { ok: true, savedVersion: { id: "ver_kept", note: "Kept from another tab" } } },
      legacy: LEGACY_SAVE,
      tooManyKept: { status: 409, since: "p3", body: { error: "There are already 10 kept drafts for this page. Open Earlier versions to tidy them.", code: "TOO_MANY_KEPT" } },
      // P3-FIX2: refused like saveDraft (nothing stored)
      archived: ARCHIVED_SAVE,
      cartLocked: CART_LOCKED,
      notFound: COMMON.outcomes.notFound,
      validationFailed: COMMON.outcomes.validationFailed,
      notBuilt: COMMON.outcomes.notBuilt,
    },
  },

  // ---- publishing (storefront.publish) ----
  // publish:    { publish: { id, draftHash, confirmRepublish? }, revision }
  // publishSet: { publishSet: [{ id, revision, draftHash, confirmRepublish? }, …] }
  //             (1 to 200; a top-level revision is 400 MALFORMED)
  publish: {
    access: "storefront.publish",
    request: { publish: { id: "doc_home", draftHash: "h_draft", confirmRepublish: true }, revision: 3 },
    requestOptional: ["publish.confirmRepublish"],
    outcomes: {
      // release and setId are null when every document was already live
      // (all skipped). skipped: ids. issues: the warnings that rode along.
      // P3-CHECKS (sent, so required): each published item carries
      //   liveUrl  '/api/preview?exit=1&to=<path>' (lib/documents/paths.js; no token)
      //   undo     {id, revision, logId} for the new publish_log row
      // and each issue (a warning that rode along) level, anchor, where, actions.
      ok: {
        status: 200,
        since: "p2",
        body: {
          ok: true,
          release: { id: "rel_1" },
          setId: "set_1",
          published: [{ id: "doc_home", versionId: "ver_2", hash: "h_draft", liveUrl: "/api/preview?exit=1&to=%2F", undo: UNDO_ARGS }],
          skipped: [],
          issues: [{ ...PUBLISH_ISSUE, severity: "warning", level: "warns", actions: [{ type: "removeItem", documentId: "doc_home", sectionId: "sec_rail", field: "products", index: 2 }] }],
        },
        optional: ["issues[].actions[].sectionId", "issues[].actions[].field", "issues[].actions[].index"],
      },
      legacy: LEGACY_PUBLISH,
      revisionRequired: REVISION_PUBLISH,
      reviewRequired: { status: 428, since: "p2", body: { error: "The editor didn't say which changes you reviewed, so nothing was published. Reload the page and try again.", code: "REVIEW_REQUIRED" } },
      nothingToPublish: { status: 400, since: "p2", body: { error: "Choose at least one page to publish.", code: "NOTHING_TO_PUBLISH" } },
      setTooLarge: { status: 400, since: "p2", body: { error: "You can publish up to 200 pages at once, so nothing was published. Publish the rest in a second go.", code: "SET_TOO_LARGE" } },
      storeUsesReleases: { status: 409, since: "p2", body: { error: "This store still publishes with Releases, so nothing was published here. Publish from Releases until the move to the new editor is done.", code: "STORE_USES_RELEASES" } },
      notPublishable: { status: 409, since: "p2", body: { error: "The journal index is made by the store itself and is published with the pages that use it.", code: "NOT_PUBLISHABLE", document: "doc_journal_index" } },
      publishNotAvailable: { status: 409, since: "p2", body: { error: "Product content is saved as a draft. Publishing it isn't available yet, so nothing was published.", code: "PUBLISH_NOT_AVAILABLE", document: "doc_X" } },
      // publish.js conflictError(): one 409 for the set. Its code is the first
      // conflict's (DOCUMENT_CHANGED, DRAFT_CHANGED, PUBLISHED_ELSEWHERE or
      // DOCUMENT_ARCHIVED); `current` at the top level only when exactly one
      // document refused. P3-CHECKS sends updatedBy and updatedByName on every
      // DOCUMENT_CHANGED, DRAFT_CHANGED and PUBLISHED_ELSEWHERE current, so
      // they are required (not on DOCUMENT_ARCHIVED, whose current is DOCUMENT).
      changed: {
        status: 409,
        since: "p2",
        optional: ["current"],
        body: {
          error: "Home page was changed since you opened it, so nothing was published. Review the current version, then publish again.",
          code: "DOCUMENT_CHANGED",
          conflicts: [{ id: "doc_home", code: "DOCUMENT_CHANGED", error: "Home page was changed since you opened it, so nothing was published. Review the current version, then publish again.", current: CURRENT }],
          current: CURRENT,
        },
      },
      draftChanged: {
        status: 409,
        since: "p2",
        optional: ["current"],
        body: {
          error: "Home page changed after you reviewed it, so nothing was published. Review the changes, then publish again.",
          code: "DRAFT_CHANGED",
          conflicts: [{ id: "doc_home", code: "DRAFT_CHANGED", error: "Home page changed after you reviewed it, so nothing was published. Review the changes, then publish again.", current: CURRENT }],
          current: CURRENT,
        },
      },
      publishedElsewhere: {
        status: 409,
        since: "p2",
        optional: ["current"],
        body: {
          error: "Someone else published home page at the same moment, so your publish didn't go live. Reload to see what is live now, then publish again.",
          code: "PUBLISHED_ELSEWHERE",
          conflicts: [{ id: "doc_home", code: "PUBLISHED_ELSEWHERE", error: "Someone else published home page at the same moment, so your publish didn't go live. Reload to see what is live now, then publish again.", current: CURRENT }],
          current: CURRENT,
        },
      },
      archived: {
        status: 409,
        since: "p2",
        optional: ["current"],
        body: {
          error: "This page was archived, so nothing was published. Reload to see your pages.",
          code: "DOCUMENT_ARCHIVED",
          conflicts: [{ id: "doc_7Q2M4K8P1R5T9V3X", code: "DOCUMENT_ARCHIVED", error: "This page was archived, so nothing was published. Reload to see your pages.", current: DOCUMENT }],
          current: DOCUMENT,
        },
      },
      // publish.js refusedForIssues(): validationBody plus the blocked
      // documents. P3-CHECKS: each issue carries level, anchor, where and at
      // least one action; offer (as on LINKS_TO_UNPUBLISHED) only when one of
      // the blocks is a link to a document that isn't live, beside other blocks.
      validationFailed: {
        status: 422,
        since: "p2",
        addedInPhase3: ["offer"],
        optional: ["offer", "issues[].actions[].sectionId", "issues[].actions[].field", "issues[].actions[].index"],
        body: {
          error: "There's 1 thing to fix in “Home page”, so nothing was published.",
          code: "VALIDATION_FAILED",
          issues: [PUBLISH_ISSUE],
          errors: ["Add a title."],
          warnings: [],
          documents: [{ id: "doc_home", label: "Home page" }],
          offer: OFFER,
        },
      },
      // publish.js slugClash(): `document` is the set's document that wants
      // the address; `other` the live page holding it. P3: other gains label.
      slugTaken: {
        status: 409,
        since: "p2",
        addedInPhase3: ["other.label"],
        body: {
          error: "Another live page already uses /about: About us. Change the address of “About (new)”, then publish again.",
          code: "SLUG_TAKEN",
          slug: "about",
          document: "doc_7Q2M4K8P1R5T9V3X",
          other: { id: "doc_K3M5P7R9T1V3X5Z7", title: "About us", label: "About us" },
        },
      },
      notFound: COMMON.outcomes.notFound,
      deleted: DOCUMENT_DELETED,
      failed: PUBLISH_FAILED,
      unknown: PUBLISH_UNKNOWN,
      busy: PUBLISH_BUSY,
      // P3-CHECKS: the draft equals the body that was taken offline and
      // confirmRepublish wasn't sent.
      republishConfirmNeeded: { status: 409, since: "p3", body: { error: "You took this page offline. Publish the same content again?", code: "REPUBLISH_CONFIRM_NEEDED", id: "doc_7Q2M4K8P1R5T9V3X" } },
      // P3-CHECKS: a closed store's first publish without the home page. The
      // offer is the set plus doc_home. offer is null when the store has no
      // home page document yet (firstPublishNoHome).
      firstPublishNeedsHome: { status: 409, since: "p3", body: { error: "Publish your home page with this, so the store opens with a home page.", code: "FIRST_PUBLISH_NEEDS_HOME", offer: OFFER } },
      firstPublishNoHome: {
        status: 409,
        since: "p3",
        body: { error: "Your store opens with its home page, and it doesn't have one yet, so nothing was published. Make your home page, then publish it with this.", code: "FIRST_PUBLISH_NEEDS_HOME", offer: null },
      },
      // P3-CHECKS: every block left is a link to an existing, non-archived
      // document that isn't live (never published, or taken offline). The
      // offer is the set plus each target; send it as publishSet. With two or
      // more targets the words list them ("…links to A and B, which aren't
      // published yet."). issues are every issue of the set, as in a 422.
      linksToUnpublished: {
        status: 422,
        since: "p3",
        optional: ["issues[].actions[].sectionId", "issues[].actions[].field", "issues[].actions[].index"],
        body: {
          error: "This page links to Diwali sale, which isn't published yet.",
          code: "LINKS_TO_UNPUBLISHED",
          issues: [{ ...PUBLISH_ISSUE, code: "LINKS_TO_UNPUBLISHED", message: "This page links to Diwali sale, which isn't published yet.", actions: [{ type: "publishBoth", documentId: "doc_7Q2M4K8P1R5T9V3X" }, { type: "removeItem", documentId: "doc_home", sectionId: "sec_promo", field: "links", index: 0 }] }],
          offer: OFFER,
        },
      },
    },
  },
  // publishSet answers exactly what publish answers (one handler, publish.js).
  publishSet: {
    access: "storefront.publish",
    request: {
      publishSet: [
        { id: "doc_home", revision: 3, draftHash: "h_draft" },
        { id: "doc_7Q2M4K8P1R5T9V3X", revision: 2, draftHash: "h_draft2", confirmRepublish: true },
      ],
    },
    requestOptional: ["publishSet[].confirmRepublish"],
    sameOutcomesAs: "publish",
  },

  // P3-UNDO (lib/documents/undo.js). Take a page offline as its own publish.
  // Refused for singletons.
  unpublish: {
    access: "storefront.publish",
    request: { unpublish: { id: "doc_7Q2M4K8P1R5T9V3X", dryRun: false }, revision: 2 },
    requestOptional: ["unpublish.dryRun"],
    outcomes: {
      ok: { status: 200, since: "p3", body: { ok: true, message: "It's offline now. To bring it back, open it and publish it again.", document: { ...DOCUMENT, live: false, publishedVersionId: null, publishedHash: null, undoneVersionId: "ver_2" } } },
      dryRun: { status: 200, since: "p3", body: { ...DRY_RUN, willTakeOffline: true, target: null } },
      legacy: LEGACY_PUBLISH,
      revisionRequired: REVISION_PUBLISH,
      cannotTakeOffline: { status: 409, since: "p3", body: { error: "This part of the store can't be taken offline.", code: "CANNOT_TAKE_OFFLINE" } },
      changed: { status: 409, since: "p3", body: { error: "This page was changed since you opened it, so nothing changed on your live store. Reload to see the latest.", code: "DOCUMENT_CHANGED", current: CURRENT } },
      publishedElsewhere: { status: 409, since: "p3", body: { error: "This was changed after that publish. Reload to see the latest.", code: "PUBLISHED_ELSEWHERE", current: CURRENT } },
      notFound: COMMON.outcomes.notFound,
      unknown: PUBLISH_UNKNOWN,
      busy: PUBLISH_BUSY,
      failed: PUBLISH_FAILED,
      notBuilt: COMMON.outcomes.notBuilt,
    },
  },
  // P3-UNDO: Undo of one publish_log row (logId), the spec 8.6 Undo.
  undo: {
    access: "storefront.publish",
    request: { undo: { id: "doc_home", logId: "log_1", dryRun: false }, revision: 4 },
    requestOptional: ["undo.dryRun"],
    outcomes: {
      // savedVersion: only when the newer unpublished draft was kept as an
      // undo_saved version. liveUrl is null when nothing is live at that
      // address afterwards (taken offline).
      ok: {
        status: 200,
        since: "p3",
        optional: ["savedVersion"],
        body: { ok: true, message: "Home page is back to the version from 2 Nov, 10:00.", savedVersion: { id: "ver_saved", where: "Earlier versions" }, liveUrl: "/api/preview?exit=1&to=%2F", document: DOCUMENT },
      },
      // The floor: nothing earlier to go back to. Nothing was written.
      nothing: { status: 200, since: "p3", body: { ok: true, nothing: true, message: "There's nothing earlier to undo.", liveUrl: null, document: DOCUMENT } },
      dryRun: { status: 200, since: "p3", body: DRY_RUN },
      legacy: LEGACY_PUBLISH,
      revisionRequired: REVISION_PUBLISH,
      publishedElsewhere: { status: 409, since: "p3", body: { error: "This was changed after that publish. Reload to see the latest.", code: "PUBLISHED_ELSEWHERE", current: CURRENT } },
      changed: { status: 409, since: "p3", body: { error: "This page was changed since you opened it, so nothing changed on your live store. Reload to see the latest.", code: "DOCUMENT_CHANGED", current: CURRENT } },
      slugTaken: { status: 409, since: "p3", body: { error: "Another page already uses /about: About us", code: "SLUG_TAKEN", slug: "about", other: { id: "doc_K3M5P7R9T1V3X5Z7", title: "About us", label: "About us" } } },
      publishNotAvailable: { status: 409, since: "p3", body: { error: "Product content can't be undone here yet, so nothing changed.", code: "PUBLISH_NOT_AVAILABLE", document: "doc_X" } },
      notFound: COMMON.outcomes.notFound,
      unknown: PUBLISH_UNKNOWN,
      busy: PUBLISH_BUSY,
      failed: PUBLISH_FAILED,
      notBuilt: COMMON.outcomes.notBuilt,
    },
  },
  // P3-UNDO: Undo of a whole set, all or none. No top-level revision: each
  // member's current revision is read and guarded in the batch.
  undoSet: {
    access: "storefront.publish",
    request: { undoSet: { setId: "set_1", members: [{ id: "doc_home", logId: "log_1" }, { id: "doc_7Q2M4K8P1R5T9V3X", logId: "log_2" }], dryRun: false } },
    requestOptional: ["undoSet.dryRun"],
    outcomes: {
      ok: { status: 200, since: "p3", body: { ok: true, message: "“About us” and “FAQ” are live again, as they were before that publish.", documents: [DOCUMENT] } },
      // for a set: target is null, linkers and changes cover every member
      dryRun: { status: 200, since: "p3", body: { ...DRY_RUN, target: null } },
      legacy: LEGACY_PUBLISH,
      publishedElsewhere: { status: 409, since: "p3", body: { error: "Home page was changed after that publish. Reload to see the latest.", code: "PUBLISHED_ELSEWHERE", current: CURRENT } },
      changed: { status: 409, since: "p3", body: { error: "Home page was changed since you opened it, so nothing changed on your live store. Reload to see the latest.", code: "DOCUMENT_CHANGED", current: CURRENT } },
      notFound: COMMON.outcomes.notFound,
      unknown: PUBLISH_UNKNOWN,
      busy: PUBLISH_BUSY,
      failed: PUBLISH_FAILED,
      notBuilt: COMMON.outcomes.notBuilt,
    },
  },

  // ---- new reads (storefront.read; P3-COMMIT checks the mode for these two) ----
  // P3-UNDO: the Recently published list, newest first, grouped by set.
  listRecentlyPublished: {
    access: "storefront.read",
    request: { listRecentlyPublished: { limit: 20 } }, // limit 1..50, default 20
    requestOptional: ["listRecentlyPublished.limit"],
    outcomes: {
      // action is publish_log.action (migration 0021), each with its words:
      //   publish    "Published"
      //   unpublish  "Took offline"
      //   undo       "Undid"
      //   scheduled  "Published on schedule"
      //   restore    "Restored"
      //   migrated   "Moved to the new editor"
      // byName is a plain name. setId is never null (publish_log.set_id is
      // NOT NULL). undo is null when canUndo is false. note: only on an undo
      // row that took a page offline ("Publish it again from the editor to
      // bring it back.").
      ok: {
        status: 200,
        since: "p3",
        optional: ["rows[].note"],
        body: {
          ok: true,
          rows: [
            {
              logId: "log_1",
              setId: "set_1",
              documentId: "doc_home",
              label: "Home page",
              action: "publish",
              actionWords: "Published",
              byName: "Asha",
              at: "2026-11-02T10:00:00.000Z",
              summary: [{ words: "Hero: title changed" }],
              canUndo: true,
              undo: UNDO_ARGS,
              note: "Publish it again from the editor to bring it back.",
            },
          ],
        },
      },
      legacy: LEGACY_READ,
      notBuilt: COMMON.outcomes.notBuilt,
    },
  },
  // P3-CHANGES: what publishing this document would change, in words.
  listChanges: {
    access: "storefront.read",
    request: { listChanges: { id: "doc_home" } },
    outcomes: {
      // Nothing to publish gives rows: []. kind: added | removed | edited |
      // moved | hidden | shown | settings (diff.js). sectionId: absent for a
      // document-level change. affects: doc_design rows only (token-usage.js).
      // neverPublished (P3-FIX4): doc_design only, true when the design was
      // never published. Its rows compare with the platform default, so
      // firstPublish stays false, and this tells the editor that the publish
      // is a first version with nothing to Undo to.
      ok: {
        status: 200,
        since: "p3",
        optional: ["rows[].sectionId", "rows[].affects", "neverPublished"],
        body: { ok: true, firstPublish: false, neverPublished: true, rows: [{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed", affects: [{ words: "Buttons on every page" }] }] },
      },
      // never published, or offline: what the first publish puts live
      firstPublish: { status: 200, since: "p3", body: { ok: true, firstPublish: true, sections: [{ words: "Hero" }] } },
      legacy: LEGACY_READ,
      notFound: COMMON.outcomes.notFound,
      notBuilt: COMMON.outcomes.notBuilt,
    },
  },
};
