// Storefront CMS API handler (S53 / A1). Extracted from the route so the
// route-level suite (scripts/test-cms-api.js) can exercise REAL dispatch —
// request parsing, authorization, storage effects — without Next's module
// alias. The route file is a thin NextResponse wrapper over these.
//
// THE A1 RULE: parse EXACTLY ONE operation first, then authorize THAT
// operation, then dispatch only it. The old handler derived the permission
// from `body.getPage` but dispatched on `body.block` first, so a mixed
// payload ({getPage, block, value}) authorized as a READ (support passed;
// no cross-origin check, since reads skip it) and then executed the
// MUTATION. Ambiguous payloads are now a 400 before any authorization.
import { requireAdmin } from "../admin-auth.js";
import { audit } from "../platform/audit.js";
import { setBlock, deleteBlock, getContentPage, upsertContentPage, deleteContentPage, CmsConflictError } from "../cms/store.js";
import { listTemplates, instantiateTemplate, saveTemplate, deleteTemplate } from "../cms/templates-store.js";
import { appendHistory, listHistory } from "../cms/history.js";
import { setPreviewCandidate, clearPreviewCandidate, CANDIDATE_BLOCKS, PREVIEW_COOKIE } from "../cms/candidates.js";
import { verifyPreviewToken } from "../releases.js";
import { storefrontView } from "../cms/view.js";
import { validateBlock } from "../cms/validate.js";
import { failure, validationBody } from "../cms/issues.js";
import { captureError } from "../errors.js";
import { slog } from "../log.js";
import { assertLegacyContentWrites } from "../cms-mode.js";

// DOC-04: any caught error -> the response. Validation is 422 with every
// issue; a database or other infrastructure failure is 5xx with a code and a
// plain message, and its raw text goes to the log, never to the founder.
async function failed(e, op) {
  const doing = op.kind === "previewCandidate" ? "preview" : ["getPage", "listTemplates", "useTemplate", "history"].includes(op.kind) ? "load" : "save";
  const f = failure(e, { doing });
  if (f.status >= 500 || f.kind === "conflict") {
    slog("cms_api_failure", { op: op.kind, status: f.status, code: f.body.code, error: String(e?.message || e).slice(0, 300) });
    if (f.kind === "internal") await captureError({ source: "cms-api", error: e, extra: { op: op.kind } });
  }
  return { status: f.status, body: f.body };
}

// After the write itself went through, the refresh that follows it (the
// editor's view, the template list) can still fail. "Nothing was saved" would
// then be false, and the editor's next Save would hit a conflict with the
// founder's own save. So this answer says it WAS saved, and to reload first.
const DONE = {
  saveBlock: "Your changes were saved",
  savePage: "Your page was saved",
  resetBlock: "It was reset to the default",
  deletePage: "The page was deleted",
  saveTemplate: "The template was saved",
  deleteTemplate: "The template was deleted",
};
function savedButNotRefreshed(e, op) {
  slog("cms_api_view_failed_after_write", { op: op.kind, error: String(e?.message || e).slice(0, 300) });
  return {
    status: 503,
    body: { error: `${DONE[op.kind]}, but this page couldn't refresh. Reload it before you make more changes.`, code: "SAVED_RELOAD_FAILED", saved: true, retryable: false },
  };
}

const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
// DOC-04: refusals of a request the editor itself got wrong, in plain words.
// The code says which; the founder only needs to know what to do.
const UNREADABLE = "The editor sent something we couldn't read, so nothing was saved. Reload the page and try again.";

// body → { op } | { error, code }. Exactly one of the four operation keys
// must be present; `reset`, `revision` and `force` are modifiers, not
// operations.
export function parseStorefrontOperation(body) {
  if (!body || typeof body !== "object") return { error: UNREADABLE, code: "NO_OPERATION" };
  const hasRevision = "revision" in body;
  const revision = body.revision ?? null;
  const force = body.force === true;
  const ops = [];
  if (body.block !== undefined) {
    ops.push(
      body.reset
        ? { kind: "resetBlock", block: body.block, hasRevision, revision }
        : { kind: "saveBlock", block: body.block, value: body.value, hasRevision, revision, force },
    );
  }
  if (body.page !== undefined) ops.push({ kind: "savePage", page: body.page, hasRevision, revision, force });
  if (body.deletePage !== undefined) ops.push({ kind: "deletePage", slug: body.deletePage, hasRevision, revision });
  if (body.getPage !== undefined) ops.push({ kind: "getPage", slug: body.getPage });
  // S54: tenant-saved templates (reads: list/instantiate · writes: save/delete)
  if (body.listTemplates !== undefined) ops.push({ kind: "listTemplates", family: typeof body.listTemplates === "string" ? body.listTemplates : null });
  if (body.useTemplate !== undefined) ops.push({ kind: "useTemplate", id: body.useTemplate });
  if (body.saveTemplate !== undefined) ops.push({ kind: "saveTemplate", template: body.saveTemplate });
  if (body.deleteTemplate !== undefined) ops.push({ kind: "deleteTemplate", id: body.deleteTemplate });
  // S55: draft revision history (read)
  if (body.history !== undefined) ops.push({ kind: "history", target: body.history });
  // S59: live unsaved-edit preview — push this preview session's candidate
  // blocks (null clears). Ephemeral, never part of drafts or releases.
  if (body.previewCandidate !== undefined) ops.push({ kind: "previewCandidate", blocks: body.previewCandidate });
  if (ops.length === 0) return { error: UNREADABLE, code: "NO_OPERATION" };
  if (ops.length > 1) return { error: UNREADABLE, code: "AMBIGUOUS_OPERATION" };
  // DOC-04: a page that isn't an object is a malformed request (400). It used
  // to throw inside the store and come back as a 422 with a TypeError's text.
  const one = ops[0];
  if ((one.kind === "savePage" && !isObject(one.page)) || (one.kind === "saveTemplate" && one.template != null && !isObject(one.template))) {
    return { error: UNREADABLE, code: "MALFORMED" };
  }
  return { op: one };
}

export async function handleStorefrontGet(request) {
  try {
    const auth = await requireAdmin(request, "storefront.read");
    if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
    return { status: 200, body: { ok: true, ...(await storefrontView()) } };
  } catch (e) {
    return failed(e, { kind: "getPage" });
  }
}

export async function handleStorefrontPut(request) {
  const body = await request.json().catch(() => ({}));
  const parsed = parseStorefrontOperation(body);
  if (parsed.error) return { status: 400, body: { error: parsed.error, code: parsed.code } };
  const op = parsed.op;

  // Authorization derives from the PARSED operation — reads are getPage and
  // the template list/instantiate; everything else is a write (which also
  // gets requireAdmin's same-origin check).
  const READ_OPS = new Set(["getPage", "listTemplates", "useTemplate", "history"]);
  let auth;
  try {
    auth = await requireAdmin(request, READ_OPS.has(op.kind) ? "storefront.read" : "storefront.write");
  } catch (e) {
    return failed(e, op); // a session lookup that failed is ours, not a 401
  }
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  // P2-GUARD: a store on the new editor refuses every write here (save, reset
  // and delete of blocks and pages, templates, the live preview push) with a
  // 409 STORE_USES_DOCUMENTS, checked fresh after parse and authorization and
  // before anything is written. A mode that can't be read is a 5xx, never a
  // go-ahead. Reads are unchanged. Known limit (MIG-03): a pre-check, not part
  // of the write's own statement. Legacy resetBlock and deletePage stay
  // revision-less when the editor sends no revision (DOC-02, MIG-03/ED-05).
  if (!READ_OPS.has(op.kind)) {
    try {
      await assertLegacyContentWrites({ doing: op.kind === "previewCandidate" ? "preview" : "save" });
    } catch (e) {
      return failed(e, op);
    }
  }

  // S53 (0B-1): ordinary saves REQUIRE the revision the editor loaded; a
  // deliberate overwrite is the explicit `force:true` — a client can no
  // longer skip the conflict check by simply omitting the field.
  if ((op.kind === "saveBlock" || op.kind === "savePage") && !op.hasRevision && !op.force) {
    return {
      status: 428,
      // API callers: send the revision you loaded, or force:true to overwrite deliberately
      body: { error: "The editor didn't say which version you started from, so nothing was saved. Reload the page and try again.", code: "REVISION_REQUIRED" },
    };
  }

  let written = false; // the founder's change is stored once this is true
  try {
    if (op.kind === "previewCandidate") {
      // Keyed to the CALLER's preview session — without a valid preview
      // cookie there is nothing to overlay onto.
      const token = request.cookies.get(PREVIEW_COOKIE)?.value;
      if (!token || !(await verifyPreviewToken(token))) {
        return { status: 409, body: { error: "The preview isn't open any more. Reopen the preview, then keep editing.", code: "NO_PREVIEW" } };
      }
      if (op.blocks == null) {
        await clearPreviewCandidate(token);
        return { status: 200, body: { ok: true, candidate: null } };
      }
      if (typeof op.blocks !== "object" || Array.isArray(op.blocks)) {
        return { status: 400, body: { error: UNREADABLE.replace("nothing was saved", "the preview didn't update"), code: "MALFORMED" } }; // previewCandidate: an object of blocks, or null to clear
      }
      const unknown = Object.keys(op.blocks).filter((k) => !CANDIDATE_BLOCKS.includes(k));
      // previewCandidate can carry CANDIDATE_BLOCKS only (the home designer's three blocks)
      if (unknown.length) return { status: 400, body: { error: UNREADABLE.replace("nothing was saved", "the preview didn't update"), code: "UNKNOWN_BLOCK", unknown } };
      const stored = {};
      const issues = [];
      for (const key of CANDIDATE_BLOCKS) {
        if (!(key in op.blocks)) continue;
        const r = validateBlock(key, op.blocks[key]);
        issues.push(...r.issues);
        if (r.ok) stored[key] = r.value; // validated + normalized — the renderer sees saved-draft shapes
      }
      // DOC-04: every block's issues, not the first failing block's
      if (issues.some((i) => i.severity === "error")) return { status: 422, body: validationBody(issues) };
      await setPreviewCandidate(token, stored);
      slog("cms_preview_candidate", { blocks: Object.keys(stored) });
      return { status: 200, body: { ok: true, candidate: Object.keys(stored) } };
    }
    if (op.kind === "getPage") {
      return { status: 200, body: { ok: true, page: await getContentPage(op.slug) } };
    }
    if (op.kind === "listTemplates") {
      return { status: 200, body: { ok: true, templates: await listTemplates(op.family) } };
    }
    if (op.kind === "history") {
      const kind = op.target?.kind === "page" ? "page" : "block";
      const key = String(op.target?.key || "");
      if (!key) return { status: 400, body: { error: UNREADABLE.replace(", so nothing was saved", ""), code: "MALFORMED" } }; // history needs {kind, key}
      return { status: 200, body: { ok: true, history: await listHistory(kind, key) } };
    }
    if (op.kind === "useTemplate") {
      const tpl = await instantiateTemplate(op.id);
      if (!tpl) return { status: 404, body: { error: "That template no longer exists. It may have been deleted.", code: "NOT_FOUND" } };
      return { status: 200, body: { ok: true, template: tpl } }; // sections carry FRESH instance ids
    }
    if (op.kind === "saveTemplate") {
      const saved = await saveTemplate(op.template || {});
      written = true;
      slog("cms_template_saved", { template: saved.id });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `template:${saved.id}` });
      return { status: 200, body: { ok: true, template: saved, templates: await listTemplates() } };
    }
    if (op.kind === "deleteTemplate") {
      await deleteTemplate(op.id);
      written = true;
      slog("cms_template_deleted", { template: op.id });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `template:${op.id}`, diff: { deleted: true } });
      return { status: 200, body: { ok: true, templates: await listTemplates() } };
    }
    if (op.kind === "resetBlock") {
      await deleteBlock(op.block, op.hasRevision ? { expectedRevision: op.revision } : {});
      written = true;
      slog("cms_block_reset", { block: op.block });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `block:${op.block}`, diff: { reset: true } });
    } else if (op.kind === "saveBlock") {
      const { ok, issues, value } = validateBlock(op.block, op.value);
      if (!ok) return { status: 422, body: validationBody(issues) };
      // revision semantics (S35): number = CAS check, null = expect-create;
      // force = deliberate overwrite (no check)
      await setBlock(op.block, value, op.force ? {} : { expectedRevision: op.revision });
      written = true;
      slog("cms_block_saved", { block: op.block, forced: op.force || undefined });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `block:${op.block}`, ...(op.force ? { diff: { forced: true } } : {}) });
      await appendHistory({ kind: "block", key: op.block, value, actor: `${auth.actor.kind}:${auth.actor.id}` }); // S55: draft trail (best-effort)
    } else if (op.kind === "savePage") {
      await upsertContentPage(op.page, op.force ? {} : { expectedRevision: op.revision });
      written = true;
      slog("cms_page_saved", { slug: op.page?.slug, forced: op.force || undefined });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `page:${op.page?.slug}`, ...(op.force ? { diff: { forced: true } } : {}) });
      await appendHistory({ kind: "page", key: String(op.page?.slug || ""), value: op.page, actor: `${auth.actor.kind}:${auth.actor.id}` }); // S55
    } else if (op.kind === "deletePage") {
      await deleteContentPage(op.slug, op.hasRevision ? { expectedRevision: op.revision } : {});
      written = true;
      slog("cms_page_deleted", { slug: op.slug });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `page:${op.slug}`, diff: { deleted: true } });
    }
    return { status: 200, body: { ok: true, ...(await storefrontView()) } };
  } catch (e) {
    if (written) return savedButNotRefreshed(e, op);
    if (e instanceof CmsConflictError) {
      // 409: both versions preserved — the server's current row rides along,
      // the editor's unsaved value stays in their form.
      return { status: 409, body: { error: e.message, code: e.code, current: e.current } };
    }
    // DOC-04: this used to be `422 { error: e.message }` for EVERY error, so a
    // database failure reached the founder as a validation message.
    return failed(e, op);
  }
}
