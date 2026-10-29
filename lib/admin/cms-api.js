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
import { storefrontView } from "../cms/view.js";
import { validateBlock } from "../cms/validate.js";
import { slog } from "../log.js";

// body → { op } | { error, code }. Exactly one of the four operation keys
// must be present; `reset` and `revision` are modifiers, not operations.
export function parseStorefrontOperation(body) {
  if (!body || typeof body !== "object") return { error: "Nothing to do", code: "NO_OPERATION" };
  const ops = [];
  if (body.block !== undefined) {
    ops.push(
      body.reset
        ? { kind: "resetBlock", block: body.block }
        : { kind: "saveBlock", block: body.block, value: body.value, hasRevision: "revision" in body, revision: body.revision ?? null },
    );
  }
  if (body.page !== undefined) ops.push({ kind: "savePage", page: body.page, hasRevision: "revision" in body, revision: body.revision ?? null });
  if (body.deletePage !== undefined) ops.push({ kind: "deletePage", slug: body.deletePage });
  if (body.getPage !== undefined) ops.push({ kind: "getPage", slug: body.getPage });
  if (ops.length === 0) return { error: "Nothing to do", code: "NO_OPERATION" };
  if (ops.length > 1) return { error: "Ambiguous payload — send exactly one operation", code: "AMBIGUOUS_OPERATION" };
  return { op: ops[0] };
}

export async function handleStorefrontGet(request) {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
  return { status: 200, body: { ok: true, ...(await storefrontView()) } };
}

export async function handleStorefrontPut(request) {
  const body = await request.json().catch(() => ({}));
  const parsed = parseStorefrontOperation(body);
  if (parsed.error) return { status: 400, body: { error: parsed.error, code: parsed.code } };
  const op = parsed.op;

  // Authorization derives from the PARSED operation — getPage is the one
  // read; everything else is a write (which also gets requireAdmin's
  // same-origin check).
  const auth = await requireAdmin(request, op.kind === "getPage" ? "storefront.read" : "storefront.write");
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

  try {
    if (op.kind === "getPage") {
      return { status: 200, body: { ok: true, page: await getContentPage(op.slug) } };
    }
    if (op.kind === "resetBlock") {
      await deleteBlock(op.block);
      slog("cms_block_reset", { block: op.block });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `block:${op.block}`, diff: { reset: true } });
    } else if (op.kind === "saveBlock") {
      const { ok, errors, value } = validateBlock(op.block, op.value);
      if (!ok) return { status: 422, body: { error: "Validation failed", errors } };
      // revision semantics (S35): present = CAS check (null = expect-create);
      // omitted entirely = no check (pre-S35 clients, scripts)
      await setBlock(op.block, value, op.hasRevision ? { expectedRevision: op.revision } : {});
      slog("cms_block_saved", { block: op.block });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `block:${op.block}` });
    } else if (op.kind === "savePage") {
      await upsertContentPage(op.page, op.hasRevision ? { expectedRevision: op.revision } : {});
      slog("cms_page_saved", { slug: op.page?.slug });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `page:${op.page?.slug}` });
    } else if (op.kind === "deletePage") {
      await deleteContentPage(op.slug);
      slog("cms_page_deleted", { slug: op.slug });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `page:${op.slug}`, diff: { deleted: true } });
    }
    return { status: 200, body: { ok: true, ...(await storefrontView()) } };
  } catch (e) {
    if (e instanceof CmsConflictError) {
      // 409: both versions preserved — the server's current row rides along,
      // the editor's unsaved value stays in their form.
      return { status: 409, body: { error: e.message, code: e.code, current: e.current } };
    }
    return { status: 422, body: { error: String(e?.message || e) } };
  }
}
