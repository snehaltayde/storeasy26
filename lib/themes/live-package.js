// Phase 5 line 2: the uploaded theme package a store renders
// (docs/plans/phase-5.md "Line 2"). The published doc_design names a package
// (settings.theme.package, thm_ + 16 hex); this reads that row of the store's
// own theme_packages table (migration 0034) and hands the storefront its
// surfaces, templates and constrained styles. Edge-safe: no node:* imports
// (app/(storefront)/layout.js reaches this file; test:theme-render scans it).
//
// One read a request: React cache() over the tagged data cache
// (cachedTenantRead("theme", ["pkg", id])). A package row is immutable once
// written, so a cached copy never goes stale; the tag still clears on publish.
// Anything that can't be rendered (no table yet, no such row, a row that isn't
// a package, an id that isn't one) renders the base kit and logs
// theme_package_missing. The operator kill switch ff_theme-packages (Phase 4's
// flag read, as lib/plugins/installs.js isKilled) turns every uploaded package off (a Storeasy flagship keeps rendering):
// the store renders its base kit, logged as theme_packages_killed. When the
// flags can't be read the package stays on: it was checked at upload and at
// publish, and a store's look should not flip with a control-plane outage.
import { cache } from "react";
import { libsql } from "../db.js";
import { tenantId } from "../tenant-context.js";
import { cachedTenantRead } from "../cache.js";
import { flagEnabled } from "../platform/flags.js";
import { notMigratedYet } from "../schema-shape.js";
import { hasColumns } from "../schema-compat.js";
import { slog } from "../log.js";
import { KITS } from "./kits.js";
import { BASES, PACKAGE_ID_RE, THEME_ID_RE } from "./package-format.js";

export const THEMES_KILL_FLAG = "ff_theme-packages";
export const THEMES_OFF_WORDS = "Uploaded themes are turned off by Storeasy right now.";

/** True when Storeasy turned uploaded themes off for this store (fails open). */
export async function themePackagesOff() {
  return !(await flagEnabled(THEMES_KILL_FLAG, tenantId(), { fallback: true }));
}

// Phase 7 line 1: source (0035) says whether the row is an upload or a
// Storeasy flagship; a store one migration behind has only uploads.
async function loadRow(id) {
  try {
    const withSource = await hasColumns("theme_packages", ["source"]).catch(() => false);
    const r = await libsql.execute({ sql: `SELECT id, slug, base_kit, package${withSource ? ", source" : ""} FROM theme_packages WHERE id = ?`, args: [id] });
    const row = r.rows[0];
    return row ? { id: String(row.id), slug: String(row.slug), base_kit: String(row.base_kit), package: String(row.package), source: row.source === "storeasy" ? "storeasy" : "upload" } : null;
  } catch (e) {
    if (notMigratedYet(e, { table: "theme_packages" })) return null;
    throw e;
  }
}

// per store and package (the data cache); livePackage below is the per-request cache
const readRow = (tid, id) => cachedTenantRead("theme", ["pkg", id], () => loadRow(id), { tid });

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The parts of a stored package the storefront uses, or null when the row is
 * not a renderable package. Pure.
 * @returns {{ id: string, slug: string, base: string, kit: string, surfaces: object|null, templates: object|null, styles: unknown[] } | null}
 */
export function renderablePackage(row) {
  if (!row || !PACKAGE_ID_RE.test(row.id) || !THEME_ID_RE.test(row.slug) || !BASES.includes(row.base_kit)) return null;
  let pkg;
  try {
    pkg = JSON.parse(row.package);
  } catch {
    return null;
  }
  if (!isObj(pkg)) return null;
  return {
    id: row.id,
    slug: row.slug,
    base: row.base_kit,
    kit: `${row.base_kit}-${KITS[row.base_kit].version}`,
    surfaces: isObj(pkg.surfaces) ? pkg.surfaces : null,
    templates: isObj(pkg.templates) ? pkg.templates : null,
    styles: Array.isArray(pkg.styles) ? pkg.styles : [],
  };
}

/**
 * The live package for a resolved design theme ({ kit, version, package }),
 * or null: no package named, turned off by Storeasy, or missing / corrupt
 * (the base kit then renders). Runs inside withTenant. The layout and the
 * template read both ask; React cache() makes it one answer, and one log
 * line, a request.
 */
export async function packageFor(theme) {
  const id = isObj(theme) ? theme.package : null;
  if (id == null) return null;
  return livePackage(tenantId(), typeof id === "string" ? id : String(id));
}

const livePackage = cache(async (tid, id) => {
  if (!PACKAGE_ID_RE.test(id)) {
    slog("theme_package_missing", { package: id.slice(0, 40), reason: "invalid_id" });
    return null;
  }
  let row = null;
  try {
    row = await readRow(tid, id);
  } catch (e) {
    slog("theme_package_missing", { package: id, reason: "lookup_error", error: String(e?.message || e).slice(0, 200) });
    return null;
  }
  // Phase 7 decision 1: the kill switch turns uploads off; a Storeasy
  // flagship is first-party and keeps rendering
  if (row?.source !== "storeasy" && (await themePackagesOff())) {
    slog("theme_packages_killed", { package: id });
    return null;
  }
  const pkg = renderablePackage(row);
  if (!pkg) slog("theme_package_missing", { package: id, reason: row ? "corrupt" : "not_found" });
  return pkg;
});
