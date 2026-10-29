"use client";

// Client helpers for the CMS editors (S52): one normalized result shape for
// every save — { ok, view } | { conflict } | { errors } | { error } — so each
// screen renders the same states instead of re-parsing responses its own way.

async function call(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (e) {
    return { ok: false, error: `Network error: ${String(e?.message || e)}` };
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && data.code === "CMS_CONFLICT") return { ok: false, conflict: { current: data.current ?? null } };
  if (res.status === 422 && Array.isArray(data.errors)) return { ok: false, errors: data.errors, warnings: data.warnings || [] };
  if (!res.ok || data.ok === false) return { ok: false, error: data.error || `Request failed (${res.status})` };
  return { ok: true, ...data };
}

const put = (body) =>
  call("/api/admin/storefront", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

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
export const useTemplate = (id) => put({ useTemplate: id });
export const saveTemplateApi = (template) => put({ saveTemplate: template });
export const deleteTemplateApi = (id) => put({ deleteTemplate: id });

export const getPage = (slug) => put({ getPage: slug });

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
