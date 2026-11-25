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
import { flagEnabled } from "../platform/flags.js";
import { newId } from "../platform/sessions.js";
import { slog } from "../log.js";
import { infraResponse } from "../infra-response.js";
import { namesFor, plainName } from "../documents/versions.js";
import { sha256Hex } from "../releases.js";
import { DESIGN_ID, KITS, themePinOf } from "./kits.js";
import { LIMITS, MESSAGES, PACKAGE_ID_RE } from "./package-format.js";
import { parseThemePackage, utf8Bytes } from "./package-validate.js";
import { issueText } from "./package-guard.js";

export const KILL_FLAG = "ff_theme-packages";

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
  if (!(await flagEnabled(KILL_FLAG, tenantId(), { fallback: true }))) {
    throw new ThemeError(409, "TURNED_OFF_BY_STOREASY", "Storeasy has turned uploaded themes off for now, so a theme can't be uploaded. Try again later.");
  }
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
