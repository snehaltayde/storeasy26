import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { settingsView } from "@/lib/admin/settings";
import { currentTenant } from "@/lib/tenant-context.js";
import { siteName } from "@/lib/site";
import { db } from "@/lib/db";
import { catalogSyncStatus } from "@/lib/sync";
import { getCmsMode } from "@/lib/cms-mode";
import { roleAllows } from "@/lib/platform/authz";
import SettingsAdmin from "@/components/admin/SettingsAdmin";
import OpsPanels from "@/components/admin/OpsPanels";
import { PageHeader } from "@/components/console/PageHeader";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings · Admin", robots: { index: false } };

// Anchor targets: ids on the Cards below (Card adds scroll-mt-20 for the
// sticky chrome). Order matches the on-page order of the sections.
const SECTIONS = [
  { id: "store-profile", label: "Store profile" },
  { id: "commerce", label: "Commerce" },
  { id: "payments", label: "Payments" },
  { id: "tracking", label: "Tracking" },
  { id: "shipping", label: "Shipping" },
  { id: "catalog-sync", label: "Products from Shopify" },
  { id: "password", label: "Password" },
  { id: "team", label: "Team" },
  { id: "agency-access", label: "Agency access" },
  { id: "domains-seo", label: "Domains & SEO" },
  { id: "privacy", label: "Privacy" },
  { id: "audit-log", label: "Audit log" },
  { id: "help", label: "Help" },
];

function SectionNav() {
  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-[45px] z-10 -mx-4 mb-5 border-b border-edge bg-surface-muted/95 px-4 backdrop-blur sm:-mx-6 sm:px-6 md:top-0"
    >
      <div className="flex gap-1.5 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="whitespace-nowrap rounded-ctl border border-edge bg-surface px-2.5 py-1 text-xs font-medium text-fg-muted focus-ring motion-safe:transition-colors hover:border-edge-strong hover:text-fg"
          >
            {s.label}
          </a>
        ))}
      </div>
    </nav>
  );
}

export default async function AdminSettingsPage() {
  const jar = await cookies();
  // S34 (OP10): merchants sign in normally; an OPERATOR passes only under an
  // active support grant (support role — read-only, PII-redacted).
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const [view, name, syncProgress, documents] = await tfetch(async () => {
    let counts = null;
    try {
      const [p, c] = await Promise.all([
        db.selectFrom("products").select([(eb) => eb.fn.countAll().as("n"), (eb) => eb.fn.max("synced_at").as("last")]).executeTakeFirst(),
        db.selectFrom("collections").select((eb) => eb.fn.countAll().as("n")).executeTakeFirst(),
      ]);
      counts = { products: Number(p?.n || 0), collections: Number(c?.n || 0), lastSyncedAt: p?.last || null };
    } catch {
      counts = null;
    }
    // GEN-02: the sync card reads the sync's own record
    const sync = await catalogSyncStatus().catch(() => null);
    // P6-NAV: the logo hint follows the store's editor. A mode that can't be
    // read gets today's (legacy) words, never an error page.
    const mode = await getCmsMode().catch(() => null);
    return [settingsView(currentTenant(), { counts }), siteName(), sync?.view ?? null, mode === "documents"];
  });

  return (
    <>
      <PageHeader title="Settings" description="Store configuration — changes go live without a deploy." />
      <SectionNav />
      <SettingsAdmin initial={view} syncProgress={syncProgress} canRunSync={roleAllows(actor.role, "sync.run")} documents={documents} />
      {/* S43: Team (MC23) · Agency (AG02) · Domains & SEO (MC21) · Privacy
          (MC25) · Audit (MC26) · Help (MC27) */}
      <OpsPanels role={actor.role} />
    </>
  );
}
