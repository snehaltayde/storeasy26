// Phase 5 line 1: a store's uploaded theme packages (tenant table
// theme_packages, migration 0034). SERVER-ONLY, tenant-scoped: every call runs
// inside withTenant() against the store's own database.
//
// Upload parses, scans and checks the file (package-validate.js) and stores
// the normalised JSON; rows are immutable (slug + version unique) and archived,
// never deleted. At most LIMITS.installed installed packages per store. Archive
// is refused while the package is live or in the design draft. Writes record
// an audit row (themes.upload / themes.archive); a refusal is logged as
// theme_upload_refused with its codes and size only, never the content.
import { db, libsql } from "../db.js";
import { currentTenant, tenantId } from "../tenant-context.js";
import { audit } from "../platform/audit.js";
import { newId } from "../platform/sessions.js";
import { slog } from "../log.js";
import { infraResponse } from "../infra-response.js";
import { namesFor, plainName } from "../documents/versions.js";
import { sha256Hex } from "../releases.js";
import { DESIGN_ID, KITS, themePinOf, publishBlockers, unpublishableNote, writeSurfaceTemplates, SURFACE_TEMPLATE_DOCS } from "./kits.js";
import { THEMES_KILL_FLAG, THEMES_OFF_WORDS, themePackagesOff } from "./live-package.js";
import { LIMITS, MESSAGES, PACKAGE_ID_RE } from "./package-format.js";
import { parseThemePackage, utf8Bytes } from "./package-validate.js";
import { issueText } from "./package-guard.js";

export const KILL_FLAG = THEMES_KILL_FLAG;

export class ThemeError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// A failure as the routes answer it (as lib/plugins/installs.js appErrorAnswer).
export function themeErrorAnswer(e, route) {
  if (e instanceof ThemeError) return { status: e.status, body: { error: e.message, code: e.code, ...(e.issues ? { issues: e.issues } : {}) } };
  const infra = infraResponse(e, { route });
  if (infra) return infra;
  slog("themes_failed", { route, error: String(e?.name || "Error") });
  return { status: 500, body: { error: "Something went wrong. Nothing was changed. Try again." } };
}

const NOT_FOUND = () => new ThemeError(404, "NOT_FOUND", "This theme isn't on your store. Reload the page to see your themes.");
const resourceOf = (id) => `theme:${id}`;
const actorString = (actor) => `${actor?.kind ?? "system"}:${actor?.id ?? ""}`;
const parse = (s) => {
  try {
    return JSON.parse(String(s));
  } catch {
    return null;
  }
};

/**
 * The request body as text, at most `limit` bytes: refused on a Content-Length
 * over the cap, and again while reading, so a missing or lying header still
 * stops at limit + 1 bytes.
 */
export async function bodyTextCapped(request, limit = LIMITS.bytes) {
  const declared = Number(request.headers.get("content-length"));
  const tooBig = () => new ThemeError(413, "TOO_BIG", MESSAGES.tooBig);
  if (Number.isFinite(declared) && declared > limit) throw tooBig();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

// What uses a package now: "live" (the published look), "draft" (the design
// draft) or null. Archive is refused for both.
async function usage() {
  const live = new Set();
  const draft = new Set();
  const pin = themePinOf(currentTenant()?.config);
  if (pin?.package) live.add(String(pin.package));
  try {
    const r = await libsql.execute({ sql: "SELECT d.draft, v.body FROM documents d LEFT JOIN document_versions v ON v.id = d.published_version_id WHERE d.id = ?", args: [DESIGN_ID] });
    const row = r.rows[0];
    if (row) {
      const d = parse(row.draft)?.settings?.theme?.package;
      const l = row.body == null ? null : parse(row.body)?.settings?.theme?.package;
      if (d) draft.add(String(d));
      if (l) live.add(String(l));
    }
  } catch (e) {
    if (!/no such table/i.test(String(e?.message || e))) throw e;
  }
  return (id) => (live.has(id) ? "live" : draft.has(id) ? "draft" : null);
}

function summaryOf(pkg) {
  const t = pkg?.templates || {};
  return {
    base: pkg?.base ?? null,
    templates: Object.fromEntries(["pdp", "collection", "header", "footer"].filter((k) => t[k]).map((k) => [k, t[k]])),
    sections: Array.isArray(t.home?.sections) ? t.home.sections.length : 0,
    rules: Array.isArray(pkg?.styles) ? pkg.styles.length : 0,
  };
}

function view(row, { names, inUse }) {
  const pkg = parse(row.package) || {};
  const kit = KITS[row.base_kit] || KITS.pulse;
  const tk = { ...kit.brand, ...(pkg.tokens || {}) };
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    version: String(row.version),
    author: row.author == null ? null : String(row.author),
    description: row.description == null ? null : String(row.description),
    base: String(row.base_kit),
    baseLabel: kit.label,
    swatch: [tk.accent, tk.background, tk.foreground],
    summary: summaryOf(pkg),
    sizeBytes: Number(row.size_bytes),
    status: String(row.status),
    inUse: inUse(String(row.id)),
    uploadedByName: plainName(row.uploaded_by, names),
    uploadedAt: String(row.uploaded_at),
    archivedByName: row.archived_by == null ? null : plainName(row.archived_by, names),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
  };
}

/** The built-in looks every store has (Pulse, Glow). */
export const builtinLooks = () => Object.values(KITS).map((k) => ({ id: k.id, label: k.label, vertical: k.vertical, description: k.description, swatch: [...k.swatch] }));

/** Installed packages, or archived ones with { archived: true }; newest first. */
export async function listPackages({ archived = false } = {}) {
  const rows = await db
    .selectFrom("theme_packages")
    .select(["id", "slug", "version", "name", "author", "description", "base_kit", "package", "size_bytes", "status", "uploaded_by", "uploaded_at", "archived_by", "archived_at"])
    .where("status", "=", archived ? "archived" : "installed")
    .orderBy("uploaded_at", "desc")
    .execute();
  const [names, inUse] = await Promise.all([namesFor(tenantId()), usage()]);
  return rows.map((r) => view(r, { names, inUse }));
}

async function rowOf(id) {
  if (typeof id !== "string" || !PACKAGE_ID_RE.test(id)) return null;
  return (await db.selectFrom("theme_packages").selectAll().where("id", "=", id).executeTakeFirst()) || null;
}

/** One package (installed or archived) and its stored content; null when not on this store. */
export async function getPackage(id) {
  const row = await rowOf(id);
  if (!row) return null;
  const [names, inUse] = await Promise.all([namesFor(tenantId()), usage()]);
  return { package: view(row, { names, inUse }), content: parse(row.package) };
}

/** The stored normalised JSON, as Download package returns it. */
export async function packageFile(id) {
  const row = await rowOf(id);
  if (!row) return null;
  return { filename: `${row.slug}-${row.version}.theme.json`, text: String(row.package) };
}

const refused = (issues, size, status = 422) => {
  slog("theme_upload_refused", { codes: [...new Set(issues.map((i) => i.code))], size });
  const first = issues.length === 1 ? issueText(issues[0]) : `This theme can't be uploaded: ${issues.length} things need fixing.`;
  return new ThemeError(status, status === 413 ? "TOO_BIG" : "REFUSED", first, { issues: issues.map((i) => ({ code: i.code, path: i.path, message: i.message, text: issueText(i) })) });
};

/** Store an uploaded package's text; refused in plain words when it isn't safe or valid. */
export async function uploadPackage(text, { actor }) {
  if (await themePackagesOff()) throw new ThemeError(409, "TURNED_OFF_BY_STOREASY", `${THEMES_OFF_WORDS} A theme can't be uploaded. Try again later.`);
  const size = utf8Bytes(text);
  const parsed = parseThemePackage(text);
  if (parsed.issues) throw refused(parsed.issues, size, parsed.status);
  const pkg = parsed.pkg;
  const label = `${pkg.name} ${pkg.version}`;
  // the same slug + version, installed or archived: each says which
  const duplicate = async () => {
    const dup = await db.selectFrom("theme_packages").select("status").where("slug", "=", pkg.id).where("version", "=", pkg.version).executeTakeFirst();
    if (!dup) return null;
    return dup.status === "archived"
      ? new ThemeError(409, "ALREADY_ARCHIVED", `${label} was archived. Raise the version to upload it again.`)
      : new ThemeError(409, "ALREADY_INSTALLED", `${label} is already installed. Raise the version to upload a change.`);
  };
  const dupFirst = await duplicate();
  if (dupFirst) throw dupFirst;
  const stored = JSON.stringify(pkg);
  const sha256 = await sha256Hex(stored);
  const id = newId("thm");
  const by = actorString(actor);
  // one guarded statement: two uploads at once can't both pass the cap
  let r;
  try {
    r = await libsql.execute({
      sql:
        "INSERT INTO theme_packages (id, slug, version, name, author, description, base_kit, package, sha256, size_bytes, status, uploaded_by, uploaded_at) " +
        "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installed', ?, ? WHERE (SELECT count(*) FROM theme_packages WHERE status = 'installed') < ?",
      args: [id, pkg.id, pkg.version, pkg.name, pkg.author?.name ?? null, pkg.description ?? null, pkg.base, stored, sha256, utf8Bytes(stored), by, new Date().toISOString(), LIMITS.installed],
    });
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e?.message || e))) throw (await duplicate()) || e;
    throw e;
  }
  if (!Number(r?.rowsAffected ?? 0)) {
    throw new ThemeError(409, "TOO_MANY", `Your store can have up to ${LIMITS.installed} uploaded themes. Archive one you don't use, then upload again.`);
  }
  await audit({ actor, action: "themes.upload", resource: resourceOf(id), diff: { slug: pkg.id, version: pkg.version, sha256 } });
  return (await getPackage(id)).package;
}

/** Archive an installed package; refused while it is live or in the design draft. */
export async function archivePackage(id, { actor }) {
  const row = await rowOf(id);
  if (!row) throw NOT_FOUND();
  if (row.status === "archived") throw new ThemeError(409, "ALREADY_ARCHIVED", `${row.name} ${row.version} is already archived.`);
  const use = (await usage())(String(row.id));
  if (use === "live") throw new ThemeError(409, "IN_USE", `${row.name} ${row.version} is live on your store. Publish another look first, then archive it.`);
  if (use === "draft") throw new ThemeError(409, "IN_USE", `${row.name} ${row.version} is in your design draft. Choose another look in the draft first, then archive it.`);
  const at = new Date().toISOString();
  const r = await db.updateTable("theme_packages").set({ status: "archived", archived_by: actorString(actor), archived_at: at }).where("id", "=", row.id).where("status", "=", "installed").executeTakeFirst();
  if (!Number(r?.numUpdatedRows ?? 0)) throw new ThemeError(409, "ALREADY_ARCHIVED", `${row.name} ${row.version} is already archived.`);
  await audit({ actor, action: "themes.archive", resource: resourceOf(row.id), diff: { slug: String(row.slug), version: String(row.version) } });
  return (await getPackage(row.id)).package;
}

// ---- Phase 5 line 3: switching themes ------------------------------------------------

const DESIGN_CHANGED = () => new ThemeError(409, "DESIGN_CHANGED", "Someone else changed your design just now. Reload the page to see it, then choose the theme again.");
export const HOME_CONFIRM_WORDS = "Using this theme's home layout replaces your home page draft. Confirm to replace it.";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// a concurrent edit, or a layout document made or archived by someone else meanwhile
const changed = (e) => ["DOCUMENT_CHANGED", "DRAFT_CHANGED", "DOCUMENT_EXISTS", "DOCUMENT_ARCHIVED"].includes(e?.code);

async function docOrNull(documents, id) {
  try {
    return await documents.getDocument(id);
  } catch (e) {
    if (e?.status === 404 || e?.name === "NotFoundError") return null;
    throw e;
  }
}

/** The package's home sections as a doc_home sections list (fresh section ids). */
async function homeSectionsOf(pkg) {
  const R = await import("../registry/index.js");
  return (pkg.templates?.home?.sections || []).map((sec) => {
    const s = R.newSection(sec.kind);
    return { ...s, settings: { ...s.settings, ...(isObj(sec.settings) ? sec.settings : {}) } };
  });
}

/**
 * "Use this theme" (storefront.write): a DRAFT of doc_design naming the
 * package, settings.theme = { kit: base, version, package, applied_at }, at
 * the revision the founder saw (409 DESIGN_CHANGED otherwise). withBrand
 * (default on) writes settings.brand from the package tokens over its base
 * kit's brand; the package's layouts are written into the header, footer,
 * product and collection layout drafts; withHome (default off) replaces the
 * doc_home draft with the package's home sections, only with confirmHome when
 * a home page exists (409 HOME_CONFIRM_NEEDED). Nothing goes live: Publish
 * does that. Audit themes.apply.
 */
export async function applyPackage(id, { actor, withBrand = true, withHome = false, confirmHome = false, revision, documents }) {
  if (await themePackagesOff()) throw new ThemeError(409, "TURNED_OFF_BY_STOREASY", `${THEMES_OFF_WORDS} Choose a built-in look instead.`);
  const row = await rowOf(id);
  if (!row) throw NOT_FOUND();
  const label = `${row.name} ${row.version}`;
  if (row.status !== "installed") throw new ThemeError(409, "ARCHIVED", `${label} was archived, so it can't be used. Choose another theme.`);
  const pkg = parse(row.package);
  const kit = KITS[row.base_kit];
  if (!isObj(pkg) || !kit) throw new ThemeError(409, "UNREADABLE", `${label} couldn't be read. Upload it again.`);
  const home = withHome ? await docOrNull(documents, "doc_home") : null;
  if (withHome && home && confirmHome !== true) throw new ThemeError(409, "HOME_CONFIRM_NEEDED", HOME_CONFIRM_WORDS);

  const R = await import("../registry/index.js");
  const cur = await docOrNull(documents, DESIGN_ID);
  if (cur && !Number.isInteger(revision)) throw new ThemeError(400, "REVISION_REQUIRED", "Reload the page and choose the theme again, so we know which design you saw.");
  if (cur && revision !== cur.revision) throw DESIGN_CHANGED();
  const theme = { kit: kit.id, version: kit.version, package: String(row.id), applied_at: new Date().toISOString() };
  const base = cur ? cur.body : R.emptyBody("design");
  const settings = { ...(isObj(base.settings) ? base.settings : {}), theme, ...(withBrand ? { brand: { ...kit.brand, ...(isObj(pkg.tokens) ? pkg.tokens : {}) } } : {}) };
  let design;
  try {
    design = (cur ? await documents.saveDraft({ id: DESIGN_ID, revision: cur.revision, body: { ...base, settings }, actor }) : await documents.createDocument({ type: "design", body: { ...base, settings }, actor })).document;
  } catch (e) {
    if (changed(e)) throw DESIGN_CHANGED();
    throw e;
  }
  const t = isObj(pkg.templates) ? pkg.templates : {};
  const layouts = Object.fromEntries(Object.keys(SURFACE_TEMPLATE_DOCS).filter((k) => typeof t[k] === "string").map((k) => [k, t[k]]));
  const written = [];
  let skipped = [];
  let homeDraftHash = null;
  let finished = false;
  let problems = [];
  try {
    const w = await writeSurfaceTemplates(documents, layouts, { actor });
    written.push(...w.written);
    skipped = w.skipped;
    if (withHome) {
      const sections = await homeSectionsOf(pkg);
      const now = await docOrNull(documents, "doc_home");
      const saved = now
        ? await documents.saveDraft({ id: "doc_home", revision: home ? home.revision : now.revision, body: { ...now.body, sections }, actor })
        : await documents.createDocument({ type: "home", body: { ...R.emptyBody("home"), sections }, actor });
      homeDraftHash = saved?.document?.draftHash ?? null;
      written.push("doc_home");
    }
    problems = await publishBlockers(design.body, DESIGN_ID);
    finished = true;
  } catch (e) {
    if (changed(e)) throw new ThemeError(409, "LAYOUT_CHANGED", `Someone else changed your design just now, so ${label} is only partly in your draft. Reload the page and choose the theme again to finish.`);
    throw e;
  } finally {
    // a half-finished apply is audited too: the design draft did change. A
    // failing audit never hides the apply's own error.
    try {
      await audit({ actor, action: "themes.apply", resource: resourceOf(row.id), diff: { package: String(row.id), withBrand, withHome, document: DESIGN_ID, revision: design.revision, layouts: written, ...(homeDraftHash ? { homeDraftHash } : {}), ...(skipped.length ? { skipped: skipped.map((x) => x.id) } : {}), ...(finished ? {} : { partial: true }) } });
    } catch (ae) {
      if (finished) throw ae;
      slog("themes_apply_audit_failed", { package: String(row.id), error: String(ae?.message || ae).slice(0, 200) });
    }
  }
  const note = [unpublishableNote(problems.length ? [{ label: "Your design", problems }] : []), ...skipped.map((x) => x.note)].filter(Boolean).join(" ");
  slog("theme_applied", { package: String(row.id), slug: String(row.slug), version: String(row.version), with_brand: withBrand, with_home: withHome, layouts: written.join(","), unpublishable: problems.length });
  return { theme, document: { id: design.id, revision: design.revision, draftHash: design.draftHash }, layouts: written, ...(skipped.length ? { skipped: skipped.map(({ id, note: words }) => ({ id, note: words })) } : {}), ...(note ? { note } : {}) };
}

const STATE_DOCS = [DESIGN_ID, ...Object.values(SURFACE_TEMPLATE_DOCS).map(([id]) => id), "doc_home"];
const LAYOUT_IDS = new Set(Object.values(SURFACE_TEMPLATE_DOCS).map(([id]) => id));
const themeOfBody = (b) => (isObj(b?.settings?.theme) ? b.settings.theme : null);
const lookOf = (theme) => (theme ? { kit: KITS[theme.kit] ? theme.kit : "pulse", package: typeof theme.package === "string" ? theme.package : null } : { kit: "pulse", package: null });
const versionBody = async (id) => (id ? parse((await libsql.execute({ sql: "SELECT body FROM document_versions WHERE id = ?", args: [id] })).rows[0]?.body) : null);

// A layout draft whose only change from live (or, never published, from the
// body it was created with) is settings.template: what an apply wrote.
async function onlyTemplateChanged(doc) {
  const { stableStringify } = await import("../registry/index.js");
  const first = async () => parse((await libsql.execute({ sql: "SELECT body FROM document_versions WHERE document_id = ? ORDER BY created_at, rowid LIMIT 1", args: [doc.id] })).rows[0]?.body);
  const live = doc.publishedVersionId ? await versionBody(doc.publishedVersionId) : await first();
  const sans = (b) => stableStringify({ ...(isObj(b) ? b : {}), settings: { ...(isObj(b?.settings) ? b.settings : {}), template: null } });
  return Boolean(live) && sans(doc.body) === sans(live);
}

// The home draft hash the store's most recent look change (a theme or a
// built-in look) wrote when it asked for the theme's home layout, or null.
// Home is pre-ticked only while the home draft still has that hash.
async function lastApplyHomeHash() {
  const { listAudit } = await import("../platform/audit.js");
  const [pkgRows, kitRows] = await Promise.all([listAudit({ tenantId: tenantId(), limit: 1, action: "themes.apply" }), listAudit({ tenantId: tenantId(), limit: 20, action: "storefront.write" })]);
  const kit = kitRows.find((r) => String(r.resource || "").startsWith("theme:") && !String(r.resource).startsWith("theme:thm_"));
  const last = [pkgRows[0], kit].filter(Boolean).sort((x, y) => String(y.created_at ?? y.at ?? "").localeCompare(String(x.created_at ?? x.at ?? "")))[0];
  if (!last || last.action !== "themes.apply") return null;
  const diff = typeof last.diff === "string" ? parse(last.diff) : last.diff;
  return diff?.withHome === true && typeof diff.homeDraftHash === "string" ? diff.homeDraftHash : null;
}

/**
 * The Themes page's switch state (storefront.read): the live and draft look
 * ({ kit, package }), whether the live package was archived, the design's
 * revision and draft hash, and the publish set: doc_design (always) and each
 * layout or home draft with unpublished changes ({ id, label, revision,
 * draftHash, suggested }). suggested: a layout whose only change is its
 * template, or the home page when the most recent apply asked for the theme's
 * home layout. Empty while the design draft matches live.
 */
export async function themeState() {
  const Docs = await import("../documents/service.js");
  let docs = [];
  try {
    docs = (await Promise.all(STATE_DOCS.map((id) => docOrNull(Docs, id)))).filter(Boolean);
  } catch (e) {
    if (!/no such table/i.test(String(e?.message || e))) throw e;
  }
  const design = docs.find((d) => d.id === DESIGN_ID) || null;
  const liveTheme = design?.publishedVersionId ? themeOfBody(await versionBody(design.publishedVersionId)) : null;
  const live = lookOf(liveTheme);
  let liveArchived = false;
  if (live.package) {
    const row = await rowOf(live.package).catch(() => null);
    liveArchived = !row || row.status !== "installed";
  }
  const pending = docs.filter((d) => !d.archivedAt && d.draftHash !== d.publishedHash);
  const designPending = pending.some((d) => d.id === DESIGN_ID);
  const publishSet = [];
  if (designPending) {
    const homeHash = pending.some((d) => d.id === "doc_home") ? await lastApplyHomeHash() : null;
    for (const d of pending) {
      const suggested = d.id === DESIGN_ID ? true : LAYOUT_IDS.has(d.id) ? await onlyTemplateChanged(d) : homeHash != null && d.draftHash === homeHash;
      publishSet.push({ id: d.id, label: d.label ?? d.id, revision: d.revision, draftHash: d.draftHash, suggested });
    }
  }
  return { live, liveArchived, draft: lookOf(themeOfBody(design?.body)), design: design ? { revision: design.revision, draftHash: design.draftHash } : null, publishSet };
}
