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
// and deletes the database unless --keep (and always after a failure, even one
// where the create itself failed or timed out). --dry-run checks the same gates and
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

const { runTursoCheck } = await import("./support/turso-real-check-run.js");
process.exitCode = await runTursoCheck({ api: tursoApi(env), name, keep });
