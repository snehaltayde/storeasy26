// The body of scripts/turso-real-check.js, after its gates (Phase 1 line 2,
// docs/plans/phase-1.md §6 item 12). Kept apart so the suite runs it against the
// local fake; only the script hands it the real Turso client.
//
//   runTursoCheck({ api, name, keep, out, err }) -> exit code (0 ok, 1 failed)
// The database is marked as asked for BEFORE the create call, so a create
// that fails or times out after Turso made it is still deleted (a 404 on that
// delete means nothing was made). It prints no token.
export async function runTursoCheck({ api, name, keep = false, out = console.log, err = console.error }) {
  const ms = (t) => `${Date.now() - t} ms`;
  let asked = false;
  let created = false;
  let code = 0;
  try {
    let t = Date.now();
    asked = true;
    const database = await api.createDatabase(name);
    created = true;
    out(`✓ created ${database.Name} (${ms(t)})`);
    t = Date.now();
    const jwt = await api.mintToken(name, { expiration: "1h" });
    out(`✓ minted a 1-hour token (${ms(t)})`);
    const { createClient } = await import("@libsql/client");
    const { applyTenantSchema } = await import("../../lib/platform/provision.js");
    const client = createClient({ url: api.dbUrlFor(database), authToken: jwt });
    try {
      t = Date.now();
      await applyTenantSchema(client);
      out(`✓ applied the store schema (${ms(t)}; a signup's after() budget is 50 s)`);
      const tables = await client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'");
      const mode = await client.execute("SELECT mode FROM cms_state WHERE id = 1");
      out(`✓ read back: ${Number(tables.rows[0].n)} tables, cms_state ${mode.rows[0]?.mode ?? "(none)"}`);
    } finally {
      client.close();
    }
  } catch (e) {
    err(`✗ ${e?.message || e}${e?.status ? ` (HTTP ${e.status}, ${e.kind})` : ""}`);
    code = 1;
  }
  if (keep && code === 0) {
    out(`• kept ${name} (--keep). Delete it yourself when done.`);
    return code;
  }
  // after a failure the database is always deleted, even with --keep
  if (asked) {
    try {
      await api.deleteDatabase(name);
      out(`✓ deleted ${name}`);
    } catch (e) {
      if (e?.kind === "not_found") out(`• ${name} was never made (404 on delete)`);
      else {
        err(`✗ could not delete ${name}: ${e?.message || e}. Delete it in the Turso dashboard.`);
        code = 1;
      }
    }
  }
  return code;
}
