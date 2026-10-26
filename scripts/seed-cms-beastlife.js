// One-time CMS seed for BeastLife's tenants (Session 23): the pre-CMS hero
// copy becomes real CMS content in beastlife + beastlife-staging databases, so
// code defaults can stay brand-neutral. INSERT OR IGNORE — console edits win.
//   pnpm tenant:seed-cms
import { getTenant } from "../lib/platform/control.js";
import { withTenant } from "../lib/tenant-context.js";
import { libsql } from "../lib/db.js";

const HERO = {
  title: "Fuel the beast in you.",
  highlight: "beast",
  subtitle: "Science-backed protein, creatine and pre-workout — browse the full catalog at ludicrous speed.",
  primary: { label: "Shop all collections", href: "/collections" },
  secondary: { label: "See what’s new", href: "#new" },
};

for (const slug of ["beastlife", "beastlife-staging"]) {
  const tenant = await getTenant(slug);
  if (!tenant) {
    console.warn(`• ${slug}: not in the control plane, skipped`);
    continue;
  }
  await withTenant(tenant, async () => {
    const res = await libsql.execute({
      sql: "INSERT OR IGNORE INTO cms_blocks (key, value, updated_at) VALUES ('hero', ?, ?)",
      args: [JSON.stringify(HERO), new Date().toISOString()],
    });
    console.log(`✓ ${slug}: hero ${res.rowsAffected ? "seeded" : "already present (kept)"}`);
  });
}
process.exit(0);
