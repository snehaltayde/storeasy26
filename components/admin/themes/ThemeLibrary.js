"use client";

import Link from "next/link";
import { CircleAlert, Palette } from "lucide-react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { StatusBadge } from "@/components/kit/status-badge";
import { Swatch } from "@/components/admin/themes/Swatch";
import { LIVE_ARCHIVED, lookName, sameLook, shortDate } from "@/components/admin/themes/theme-words";
import { ApplyThemeDialog } from "@/components/admin/themes/ApplyThemeDialog";
import { ThemeDraftBar } from "@/components/admin/themes/ThemeDraftBar";

// /admin/themes (Phase 5 line 1): the built-in looks (Pulse, Glow) and the
// store's uploaded themes, with an Installed / Archived filter (a link, so it
// is a read). Rows open the theme's page.
//   builtins, packages, archived, state: GET /api/admin/themes
// Line 3: "Use this theme" on every look (storefront.write), the badges "Live"
// and "In your draft", and the draft bar (Preview, Publish).
export function ThemeLibrary({ builtins, packages, archived, state = null, role = null }) {
  const names = { live: lookName(state?.live, builtins, packages), draft: lookName(state?.draft, builtins, packages) };
  const builtinUse = (id) => {
    const look = { kit: id, package: null };
    if (sameLook(state?.live, look)) return "live";
    return sameLook(state?.draft, look) ? "draft" : null;
  };
  const columns = [
    {
      key: "name",
      header: "Theme",
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <Swatch colors={r.swatch} label={`${r.name} colours`} />
          <span className="truncate">{r.name}</span>
          {r.inUse ? <StatusBadge kind="theme" status={r.inUse} className="shrink-0" data-theme-use={r.inUse} /> : null}
        </span>
      ),
    },
    { key: "version", header: "Version", cell: (r) => <span className="font-mono text-xs tabular-nums">{r.version}</span> },
    { key: "author", header: "Author", cell: (r) => r.author || "—" },
    { key: "uploadedByName", header: "Uploaded by" },
    { key: "uploadedAt", header: archived ? "Archived" : "Uploaded", cell: (r) => shortDate(archived ? r.archivedAt : r.uploadedAt) },
  ];
  return (
    <div className="space-y-8">
      {state?.liveArchived ? (
        <Alert variant="destructive" data-themes="live-archived">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{LIVE_ARCHIVED}</AlertTitle>
        </Alert>
      ) : null}
      <ThemeDraftBar state={state} names={names} role={role} />
      <section className="space-y-3" aria-labelledby="builtin-looks">
        <h2 id="builtin-looks" className="text-lg font-semibold">
          Built-in looks
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {builtins.map((k) => (
            <Card key={k.id} data-theme-builtin={k.id} className="gap-3">
              <CardContent>
                <Swatch band colors={k.swatch} label={`${k.label} colours`} />
              </CardContent>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {k.label}
                  {builtinUse(k.id) ? <StatusBadge kind="theme" status={builtinUse(k.id)} data-theme-use={builtinUse(k.id)} /> : null}
                </CardTitle>
                <CardDescription>{k.description}</CardDescription>
                {sameLook(state?.draft, { kit: k.id, package: null }) ? null : (
                  <div className="pt-2">
                    <ApplyThemeDialog look={{ kind: "builtin", id: k.id, label: k.label, sections: 0 }} role={role} revision={state?.design?.revision ?? null} />
                  </div>
                )}
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>
      <section className="space-y-3" aria-labelledby="uploaded-themes">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="uploaded-themes" className="text-lg font-semibold">
            Uploaded themes
          </h2>
          <nav aria-label="Show" className="flex gap-1" data-read-control>
            {[
              ["installed", "Installed", "/admin/themes"],
              ["archived", "Archived", "/admin/themes?status=archived"],
            ].map(([key, label, href]) => (
              <Button key={key} asChild size="sm" variant={(archived ? "archived" : "installed") === key ? "secondary" : "ghost"} data-read-control>
                <Link href={href} aria-current={(archived ? "archived" : "installed") === key ? "page" : undefined} data-themes-filter={key}>
                  {label}
                </Link>
              </Button>
            ))}
          </nav>
        </div>
        <DataTable
          label={archived ? "Archived themes" : "Uploaded themes"}
          columns={columns}
          rows={packages}
          rowHref={(r) => `/admin/themes/${encodeURIComponent(r.id)}`}
          rowActions={archived ? null : (r) => (r.inUse === "draft" || sameLook(state?.draft, { kit: r.base, package: r.id }) ? null : <ApplyThemeDialog look={{ kind: "package", id: r.id, label: `${r.name} ${r.version}`, sections: r.summary?.sections ?? 0 }} role={role} revision={state?.design?.revision ?? null} />)}
          empty={
            <EmptyState
              icon={Palette}
              title={archived ? "No archived themes" : "No uploaded themes yet"}
              description={archived ? "Themes you archive are kept here." : "Your store uses a built-in look. An owner or admin can upload a theme file; it changes nothing until you choose it and publish."}
            />
          }
        />
      </section>
    </div>
  );
}
