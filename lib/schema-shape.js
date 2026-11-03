// Which database errors mean "this tenant's database is from before a
// migration" (P1-FIX-C). Pure, no imports: the edge storefront, the console
// and lib/cms/issues.js all use it.
//
// Tenant migrations run per tenant, so code can meet a database one migration
// behind, and a few reads and writes treat that as "not there yet" (no pages,
// not customized, write without the new column). Only the EXPECTED shape may:
// the database driver says the table that code names isn't there, or one of
// the columns that code names isn't. Anything else, a view that names
// something gone, a column nobody expected to be missing, a damaged schema, is
// a failure and must be answered as one. "no such column" in general used to
// count, so a broken cms_pages read showed a page that exists as a 404 and let
// a save answer 200 (P1-DRILLS finding 5).
//
// Only errors the driver made are read (as lib/cms/issues.js does), never the
// words of our own errors.
const DRIVER_NAMES = new Set(["LibsqlError", "LibsqlBatchError", "SqliteError"]);
export const isDriverError = (e) => DRIVER_NAMES.has(e?.name) || /^SQLITE_/.test(String(e?.code ?? ""));

const IDENT = /^[a-z_][a-z0-9_]*$/;
// SQLite's words, from a local file database and from sqld over HTTP:
//   no such table: cms_pages                      (sqld: "SQLite error: no such table: cms_pages")
//   no such column: family                        (sqld: "SQL input error: no such column: family (at offset 7)")
//   no such column: cms_pages.family
//   table order_items has no column named sku     (an INSERT)
// The name must end there: "no such table: cms_pages_data" is not cms_pages.
const END = "(?![\\w.])";

// e: a caught error. table: the table this code reads or writes. columns: the
// columns a migration added that this code can live without.
export function notMigratedYet(e, { table, columns = [] } = {}) {
  if (!IDENT.test(table || "") || !columns.every((c) => IDENT.test(c))) throw new Error(`notMigratedYet: not a plain table or column name: ${table}(${columns})`);
  const shapes = [new RegExp(`\\bno such table: (?:main\\.)?${table}${END}`, "i")];
  for (const c of columns) {
    shapes.push(new RegExp(`\\bno such column: (?:(?:main\\.)?${table}\\.)?${c}${END}`, "i"));
    shapes.push(new RegExp(`\\btable (?:main\\.)?${table} has no column named ${c}${END}`, "i"));
  }
  for (let cur = e, depth = 0; cur && typeof cur === "object" && depth < 6; cur = cur.cause, depth++) {
    if (isDriverError(cur) && shapes.some((s) => s.test(String(cur.message ?? "")))) return true;
  }
  return false;
}
