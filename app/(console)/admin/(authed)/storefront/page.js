import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowRight, FileText, Home, Image as ImageIcon, ListTree, PackageOpen, Paintbrush, Palette, Rocket } from "lucide-react";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { storefrontView } from "@/lib/cms/view";
import { releaseDiff, getLiveRelease, snapshotContent, validateRelease } from "@/lib/releases";
import { PageHeader } from "@/components/console/PageHeader";
import { Card, CardHeader } from "@/components/console/Card";
import { Badge, StatusBadge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { EmptyState } from "@/components/console/bits";
import { diffItemInfo, BLOCK_INFO, pageUrl, FAMILY_LABELS } from "@/components/admin/cms/labels";
import { tfetch } from "@/lib/tenant-request";
import { issueText } from "@/lib/cms/issues";

// S52: the Storefront OVERVIEW — published state, what's changed since live,
// recent edits, and the doors into each management area. The old everything-
// on-one-screen editor is now dedicated pages (home, pages, navigation,
// product-pages) + theme/brand/media/publishing.
export const dynamic = "force-dynamic";
export const metadata = { title: "Storefront · Admin", robots: { index: false } };

const AREAS = [
  { href: "/admin/storefront/home", icon: Home, label: "Home page", blurb: "Hero, homepage sections, collections order" },
  { href: "/admin/storefront/pages", icon: FileText, label: "Pages", blurb: "Policies, campaigns, journal posts" },
  { href: "/admin/storefront/navigation", icon: ListTree, label: "Navigation", blurb: "Announcement bar, header & footer menus" },
  { href: "/admin/storefront/product-pages", icon: PackageOpen, label: "Product pages", blurb: "Accordions under every product" },
  { href: "/admin/theme", icon: Palette, label: "Theme", blurb: "Layout kit & display font" },
  { href: "/admin/brand", icon: Paintbrush, label: "Brand", blurb: "Colors, radius, type scale" },
  { href: "/admin/media", icon: ImageIcon, label: "Media", blurb: "Images for sections and pages" },
  { href: "/admin/releases", icon: Rocket, label: "Publishing", blurb: "Review changes, publish, history" },
];

const when = (s) => (s ? new Date(s).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null);

export default async function StorefrontOverviewPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");

  const [view, diff, live, validation] = await tfetch(async () => {
    const [view, diff, live, snap] = await Promise.all([storefrontView(), releaseDiff(), getLiveRelease(), snapshotContent()]);
    return [view, diff, live, await validateRelease(snap.content)];
  });

  // Recent edits: customized blocks + pages, newest first.
  const recent = [
    ...Object.entries(view.blockMeta || {}).map(([key, m]) => ({
      label: BLOCK_INFO[key]?.label || key,
      href: BLOCK_INFO[key]?.href || "/admin/storefront",
      at: m.updated_at,
    })),
    ...view.pages
      .filter((p) => p.source === "custom")
      .map((p) => ({ label: `Page: ${p.title || p.slug}`, href: `/admin/storefront/pages/${p.slug}`, at: p.updated_at })),
  ]
    .filter((r) => r.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 6);

  return (
    <>
      <PageHeader
        title="Storefront"
        description="Everything here saves as a draft — including product modules, collection pins, upsell placements and redirects (since S53) — and goes live when you publish. Only site identity (Settings) applies immediately."
        actions={
          <Link
            href="/admin/releases"
            className="inline-flex items-center gap-1.5 rounded-ctl bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg focus-ring hover:bg-primary-hover"
          >
            Review & publish <ArrowRight size={13} aria-hidden />
          </Link>
        }
      />

      <div className="space-y-4">
        {/* Published state */}
        <Card>
          <CardHeader
            title="Published state"
            badge={
              diff.firstPublish ? (
                <Badge tone="warning">Never published — drafts serve directly</Badge>
              ) : diff.dirty ? (
                <Badge tone="info">{diff.items.length} unpublished change{diff.items.length === 1 ? "" : "s"}</Badge>
              ) : (
                <StatusBadge status="live" label="In sync with live" />
              )
            }
            description={
              live
                ? `Live release ${live.content_hash.slice(0, 12)}${live.note ? ` — “${live.note}”` : ""}`
                : "Until the first publish, every saved draft is immediately visible to shoppers."
            }
          />
          {validation.errors.length > 0 && (
            <Banner tone="danger" title="Fix before publishing" className="mb-3">
              <ul className="list-inside list-disc space-y-0.5">
                {/* DOC-04: worded from each issue's ids against the sections being published */}
                {validation.issues
                  .filter((it) => it.severity === "error")
                  .map((it, i) => (
                    <li key={i}>{issueText(it, { sections: validation.sections })}</li>
                  ))}
              </ul>
            </Banner>
          )}
          {diff.items.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {diff.items.map((item, i) => {
                const info = diffItemInfo(item);
                return (
                  <li key={i}>
                    <Link
                      href={info.href}
                      className="inline-flex items-center gap-1.5 rounded-ctl border border-edge bg-surface px-2 py-1 text-xs text-fg focus-ring hover:bg-surface-sunken"
                    >
                      {info.label}
                      <Badge tone={info.tone}>{info.changeLabel}</Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            !diff.firstPublish && <p className="text-sm text-fg-muted">No draft changes — the live release matches your drafts exactly.</p>
          )}
        </Card>

        {/* Management areas */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {AREAS.map((a) => (
            <Link key={a.href} href={a.href} className="group rounded-card border border-edge bg-surface p-4 shadow-card focus-ring hover:border-edge-strong">
              <a.icon size={18} aria-hidden className="text-fg-subtle group-hover:text-fg" />
              <p className="mt-2 text-sm font-semibold text-fg">{a.label}</p>
              <p className="mt-0.5 text-xs text-fg-muted">{a.blurb}</p>
            </Link>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Recent edits */}
          <Card>
            <CardHeader title="Recent edits" description="Latest saved drafts, newest first." />
            {recent.length === 0 ? (
              <EmptyState title="Nothing customized yet" body="Start with the home page hero, or create your first page." />
            ) : (
              <ul className="divide-y divide-edge text-sm">
                {recent.map((r, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 py-2">
                    <Link href={r.href} className="truncate text-fg focus-ring hover:underline">
                      {r.label}
                    </Link>
                    <span className="shrink-0 text-xs text-fg-subtle">{when(r.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Pages at a glance */}
          <Card>
            <CardHeader
              title="Pages"
              description={`${view.pages.length} page${view.pages.length === 1 ? "" : "s"} across policies, campaigns and journal.`}
              actions={
                <Link href="/admin/storefront/pages" className="inline-flex items-center gap-1 rounded-ctl px-2 py-1 text-xs font-medium text-fg focus-ring hover:bg-surface-sunken">
                  Manage <ArrowRight size={12} aria-hidden />
                </Link>
              }
            />
            {view.pages.length === 0 ? (
              <EmptyState title="No pages yet" body="Policies, FAQs and campaign pages start here." />
            ) : (
              <ul className="divide-y divide-edge text-sm">
                {view.pages.slice(0, 6).map((p) => (
                  <li key={p.slug} className="flex items-center justify-between gap-3 py-2">
                    <Link href={`/admin/storefront/pages/${p.slug}`} className="min-w-0 truncate text-fg focus-ring hover:underline">
                      {p.title || p.slug}
                    </Link>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <Badge tone="neutral">{FAMILY_LABELS[p.family] || p.family}</Badge>
                      <span className="font-mono text-[11px] text-fg-subtle">{pageUrl(p)}</span>
                      {!p.enabled && <Badge tone="warning">Hidden</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
