// P4-MEDIA (MED-03): rebuild one store's reference index (document_refs) from
// what it holds. The `pnpm media:reindex` command.
//
//   pnpm media:reindex -- --tenant <id> [--dry-run] [--releases]
//   pnpm media:reindex -- --tenant <id> --hosted --confirm <id>   (owner only)
//
// What it does (lib/documents/refs.js reindexTenant):
//   - re-reads every document_versions row and writes the refs its body holds
//     (the registry with the images and links inside text, plus the
//     /api/media/<id> belt), ON CONFLICT DO NOTHING;
//   - rewrites media rows stored by their src ("/api/media/med_x") to the id
//     form ("med_x");
//   - with --releases, writes the release:<id> media rows of every releases
//     row, so a file an old release shows is never deleted.
// It never deletes a ref it can still find, and it never touches documents,
// versions, releases or media. Running it twice gives the same rows.
// --dry-run reads and counts, and writes nothing.
//
// Which database: the tenant's own, from the control plane (PLATFORM_DB_URL).
// A local file database (file:) or a database on this machine (localhost,
// 127.0.0.1, [::1], such as the harness's sqld) is allowed. Anything else is
// refused unless --hosted --confirm <the same tenant id> is given: that is
// the owner's step, never a builder's. The database token is never printed.
import { createClient } from "@libsql/client";
import { getTenant } from "../lib/platform/control.js";
import { reindexTenant } from "../lib/documents/refs.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const has = (name) => args.includes(`--${name}`);

// file: (not file://host), or a database on this machine
function isLocalDbUrl(url) {
  const s = typeof url === "string" ? url.trim() : "";
  if (/^file:/i.test(s)) return !/^file:\/\/[^/]/i.test(s);
  const m = /^(?:libsql|https?|wss?):\/\/([^/?#]+)/i.exec(s);
  if (!m) return false;
  const host = m[1].replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const tenantArg = flag("tenant");
if (!tenantArg) fail("Usage: pnpm media:reindex -- --tenant <id> [--dry-run] [--releases]");
const dryRun = has("dry-run");
const releases = has("releases");
const hosted = has("hosted");
const confirm = flag("confirm");

let tenant;
try {
  tenant = await getTenant(tenantArg, { fresh: true });
} catch (e) {
  fail(`couldn't read the control plane: ${String(e?.message || e).slice(0, 200)}`);
}
if (!tenant) fail(`no store "${tenantArg}" in the control plane`);

if (!isLocalDbUrl(tenant.dbUrl)) {
  if (!hosted || confirm !== tenant.id) {
    fail(`refusing: "${tenant.id}" is not a local database. Only the owner runs this on a hosted store, with --hosted --confirm ${tenant.id}.`);
  }
} else if (hosted) {
  fail("--hosted is only for a hosted database; this store's database is local. Run it without --hosted.");
}

const client = createClient({ url: tenant.dbUrl, authToken: tenant.dbToken || undefined });
try {
  const r = await reindexTenant(client, { releases, dryRun });
  const verb = dryRun ? "would add" : "added";
  console.log(
    `${dryRun ? "(dry run, nothing written) " : ""}✓ ${tenant.id}: ${r.versions} versions read${releases ? `, ${r.releases} releases read` : ""}; ${verb} ${r.added} refs, ${dryRun ? "would rewrite" : "rewrote"} ${r.rewritten} image refs stored by address`,
  );
  console.log(JSON.stringify({ tenant: tenant.id, ...r }));
} catch (e) {
  fail(`${tenant.id}: ${String(e?.message || e).slice(0, 300)}`);
} finally {
  client.close();
}
