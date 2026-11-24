// The one path to real Turso (Phase 1 line 2, docs/plans/phase-1.md §6 item 12).
// The owner runs it by hand to prove the Platform API client against the real
// service; nothing else (no suite, no drill, no harness) ever reaches Turso.
//
//   TURSO_REAL_CHECK=yes-i-accept-a-real-database TURSO_API_TOKEN=… TURSO_ORG=… \
//     pnpm check:turso-real --create-one-database [--keep] [--dry-run]
//
// It refuses unless all of these hold: TURSO_REAL_CHECK is exactly
// yes-i-accept-a-real-database, --create-one-database is given, TURSO_API_TOKEN
// and TURSO_ORG are set, and TURSO_API_URL is unset (the default Turso address).
// Then it creates one database storeasy-check-<6hex> (in TURSO_GROUP, default
// "default"), mints a 1-hour token, applies the store schema, reads it back,
// and deletes the database unless --keep. --dry-run checks the same gates and
// says what it would do without calling anything. It prints no token.
import { randomBytes } from "node:crypto";

const CONSENT = "yes-i-accept-a-real-database";
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const keep = args.has("--keep");
const env = process.env;

function refuse(why) {
  console.error(`Refused: ${why}\nNothing was created. See the comment at the top of scripts/turso-real-check.js.`);
  process.exit(2);
}

if (env.TURSO_REAL_CHECK !== CONSENT) refuse(`set TURSO_REAL_CHECK=${CONSENT} to accept that this creates a real Turso database.`);
if (!args.has("--create-one-database")) refuse("pass --create-one-database to say you mean it.");
if (!String(env.TURSO_API_TOKEN || "").trim()) refuse("TURSO_API_TOKEN is not set.");
if (!String(env.TURSO_ORG || "").trim()) refuse("TURSO_ORG is not set.");
if (String(env.TURSO_API_URL || "").trim()) refuse("TURSO_API_URL is set; the real check only talks to the default Turso address. Unset it.");

const { tursoApi, DEFAULT_TURSO_API_URL } = await import("../lib/platform/turso-api.js");
const name = `storeasy-check-${randomBytes(3).toString("hex")}`;
const group = String(env.TURSO_GROUP || "").trim() || "default";

if (dryRun) {
  console.log(`Dry run: nothing is called.
Would, at ${DEFAULT_TURSO_API_URL} for organization ${env.TURSO_ORG} (group ${group}):
  1. create one database: ${name}
  2. mint a 1-hour full-access token for it (never printed)
  3. apply the store schema (migrations/tenant) and read it back
  4. ${keep ? "keep the database (--keep): delete it yourself afterwards" : "delete the database"}`);
  process.exit(0);
}

const api = tursoApi(env);
const ms = (t) => `${Date.now() - t} ms`;
let created = false;
try {
  let t = Date.now();
  const database = await api.createDatabase(name);
  created = true;
  console.log(`✓ created ${database.Name} (${ms(t)})`);
  t = Date.now();
  const jwt = await api.mintToken(name, { expiration: "1h" });
  console.log(`✓ minted a 1-hour token (${ms(t)})`);
  const { createClient } = await import("@libsql/client");
  const { applyTenantSchema } = await import("../lib/platform/provision.js");
  const client = createClient({ url: api.dbUrlFor(database), authToken: jwt });
  t = Date.now();
  await applyTenantSchema(client);
  console.log(`✓ applied the store schema (${ms(t)}; a signup's after() budget is 50 s)`);
  const tables = await client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'");
  const mode = await client.execute("SELECT mode FROM cms_state WHERE id = 1");
  console.log(`✓ read back: ${Number(tables.rows[0].n)} tables, cms_state ${mode.rows[0]?.mode ?? "(none)"}`);
  client.close();
} catch (e) {
  console.error(`✗ ${e?.message || e}${e?.status ? ` (HTTP ${e.status}, ${e.kind})` : ""}`);
  process.exitCode = 1;
} finally {
  if (created && !keep) {
    try {
      await api.deleteDatabase(name);
      console.log(`✓ deleted ${name}`);
    } catch (e) {
      console.error(`✗ could not delete ${name}: ${e?.message || e}. Delete it in the Turso dashboard.`);
      process.exitCode = 1;
    }
  } else if (created) console.log(`• kept ${name} (--keep). Delete it yourself when done.`);
}
