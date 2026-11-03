"use client";

// Client helpers for the CMS editors (S52): one normalized result shape for
// every save — { ok, view } | { conflict } | { issues, errors } | { error } —
// so each screen renders the same states instead of re-parsing responses its
// own way.
//
// DOC-04: a 422 carries `issues` (lib/cms/issues.js). `errors` here is those
// issues in words with no section context ("Header menu, item 2: …"); an
// editor that shows sections formats `issues` itself, so the section number
// comes from the id against what is on screen. Anything else that failed (a
// 5xx with a code, no connection, a page that isn't JSON) is `error`, in
// plain words, and never looks like a validation problem.
import { issueText } from "../../../lib/cms/issues.js"; // relative, so plain node (test:page-editor) loads it too

export const NETWORK_ERROR = "We couldn't reach Storeasy, so nothing was saved. Check your internet connection, then try again. Your changes are still here.";
const unreadable = (status) =>
  `Something went wrong on our side (error ${status}), so nothing was saved. Your changes are still here. Try again in a minute.`;

async function call(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    return { ok: false, error: NETWORK_ERROR, code: "NETWORK" };
  }
  const data = await res.json().catch(() => null);
  if (data == null) return { ok: false, error: unreadable(res.status), code: "UNREADABLE_RESPONSE", status: res.status };
  if (res.status === 409 && data.code === "CMS_CONFLICT") return { ok: false, conflict: { current: data.current ?? null } };
  if (res.status === 422 && Array.isArray(data.issues)) {
    return { ok: false, issues: data.issues, errors: data.issues.filter((i) => i.severity === "error").map((i) => issueText(i)), warnings: data.warnings || [] };
  }
  if (res.status === 422 && Array.isArray(data.errors)) return { ok: false, errors: data.errors, warnings: data.warnings || [] };
  if (!res.ok || data.ok === false) return { ok: false, error: data.error || unreadable(res.status), code: data.code || null, status: res.status };
  return { ok: true, ...data };
}

// DOC-04 fix round 1: SAVED_RELOAD_FAILED means the save went through but the
// server couldn't read the editor's view back. Ask for the view once more; if
// that works, the editor carries on as after any save, with the new revision
// (without it, the next Save would conflict with the founder's own save). If
// it fails too, the answer stands: it says the changes were saved, and to
// reload. Only for the operations whose success IS the view.
const VIEW_OPS = ["block", "page", "deletePage"];
const put = async (body) => {
  const r = await call("/api/admin/storefront", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.code === "SAVED_RELOAD_FAILED" && VIEW_OPS.some((k) => body[k] !== undefined)) {
    const view = await call("/api/admin/storefront");
    if (view.ok) return view;
  }
  return r;
};

export const getStorefrontView = () => call("/api/admin/storefront");

// revision semantics (S35, hardened S53): number = CAS check · null =
// "expect to create" · a deliberate overwrite after a conflict is the
// EXPLICIT {force:true} — the server now rejects saves that simply omit the
// revision (428 REVISION_REQUIRED).
export const saveBlock = (block, value, revision, { force = false } = {}) =>
  put(force ? { block, value, force: true } : { block, value, revision: revision ?? null });

export const resetBlock = (block, revision) => put(revision == null ? { block, reset: true } : { block, reset: true, revision });

export const savePage = (page, revision, { force = false } = {}) =>
  put(force ? { page, force: true } : { page, revision: revision ?? null });

export const deletePage = (slug, revision) => put(revision == null ? { deletePage: slug } : { deletePage: slug, revision });

// S54: tenant-saved templates. useTemplate returns sections with FRESH
// instance ids (an independent copy, never a live link).
export const listTemplates = (family) => put({ listTemplates: family || true });
// S55: draft revision history (read) — restore = load into the editor as an
// unsaved change; the ordinary save path takes it from there.
export const getHistory = (kind, key) => put({ history: { kind, key } });
export const useTemplate = (id) => put({ useTemplate: id });
export const saveTemplateApi = (template) => put({ saveTemplate: template });
export const deleteTemplateApi = (id) => put({ deleteTemplate: id });

export const getPage = (slug) => put({ getPage: slug });

// S59: live unsaved-edit preview — push the editor's dirty blocks to THIS
// preview session's candidate (validated server-side); null clears it.
export const saveCandidate = (blocks) => put({ previewCandidate: blocks });

// Mint a preview session (sets the httpOnly cookie) deep-linked at `to`.
export async function startPreview(to = "/") {
  const r = await call("/api/admin/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "preview", to }),
  });
  if (!r.ok) return r;
  try {
    await fetch(r.url, { redirect: "follow" }); // follows the 302, sets the cookie
  } catch (e) {
    return { ok: false, error: `Preview cookie failed: ${String(e?.message || e)}` };
  }
  return { ok: true, url: r.url, to };
}
