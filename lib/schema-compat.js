// Optional schema, detected once per database (MIG-05). Edge-safe: no node: APIs,
// so storefront code on the edge runtime can use it.
//
// Tenant migrations run per tenant, and one tenant can fail while the rest
// succeed (scripts/tenant-migrate.js is failure-isolated). So code can meet a
// tenant database one migration behind. Code that writes or reads a column a
// recent migration added asks hasColumns() first, and leaves the column out
// when that database does not have it yet. Nothing else changes for that tenant.
//
// The probe is one `SELECT <columns> FROM <table> LIMIT 0`. It is never a PRAGMA,
// and it never runs per request: the answer is remembered on the database's own
// cached client (lib/db.js keeps one per database), so each tenant answers for
// itself.
//   · present → remembered for the life of the instance. Expand, then contract
//     (migrations/README.md) never drops a column that code still names.
//   · absent  → asked again after ABSENT_RECHECK_MS, so a tenant migrated while
//     this instance is warm gets the columns within about a minute. Absent
//     means the driver said that table or one of those columns isn't there
//     (lib/schema-shape.js, P1-FIX-C); any other "no such column" is not it.
//   · the probe failed for another reason (database unreachable, a broken
//     schema) → absent for this call only, and not remembered. The caller's own
//     query goes to the same database and reports the real error, or succeeds
//     without the new columns.
// Concurrent callers on a cold instance share the one probe.
import { currentDatabase } from "./db.js";
import { notMigratedYet } from "./schema-shape.js";

const ABSENT_RECHECK_MS = 60_000;
const IDENT = /^[a-z_][a-z0-9_]*$/;

let recheckMs = ABSENT_RECHECK_MS;
let facts = new WeakMap(); // database instance → Map(key → { value, until })

export async function hasColumns(table, columns) {
  if (!IDENT.test(table) || !columns?.length || !columns.every((c) => IDENT.test(c))) {
    throw new Error(`hasColumns: not a plain table or column name: ${table}(${columns})`);
  }
  const inst = currentDatabase();
  let memo = facts.get(inst);
  if (!memo) facts.set(inst, (memo = new Map()));
  const key = `${table}(${columns.join(",")})`;
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value;

  const probe = inst.libsql.execute(`SELECT ${columns.join(", ")} FROM ${table} LIMIT 0`).then(
    () => {
      memo.set(key, { value: true, until: Infinity });
      return true;
    },
    (e) => {
      if (notMigratedYet(e, { table, columns })) memo.set(key, { value: false, until: Date.now() + recheckMs });
      else memo.delete(key);
      return false;
    },
  );
  memo.set(key, { value: probe, until: Infinity });
  return probe;
}

// Test hooks only.
export const __schemaCompat = {
  setRecheckMs(ms) {
    recheckMs = ms;
  },
  forget() {
    facts = new WeakMap();
    recheckMs = ABSENT_RECHECK_MS;
  },
};
