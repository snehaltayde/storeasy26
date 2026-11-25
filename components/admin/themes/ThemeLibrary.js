"use client";

import Link from "next/link";
import { Palette } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { Swatch } from "@/components/admin/themes/Swatch";
import { USE_WORDS, shortDate } from "@/components/admin/themes/theme-words";

// /admin/themes (Phase 5 line 1): the built-in looks (Pulse, Glow) and the
// store's uploaded themes, with an Installed / Archived filter (a link, so it
// is a read). Rows open the theme's page.
//   builtins, packages, archived: GET /api/admin/themes
export function ThemeLibrary({ builtins, packages, archived }) {
  const columns = [
    {
      key: "name",
      header: "Theme",
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <Swatch colors={r.swatch} label={`${r.name} colours`} />
          <span className="truncate">{r.name}</span>
          {r.inUse ? (
            <Badge variant="secondary" className="shrink-0" data-theme-use={r.inUse}>
              {USE_WORDS[r.inUse]}
            </Badge>
          ) : null}
        </span>
      ),
    },
    { key: "version", header: "Version" },
    { key: "author", header: "Author", cell: (r) => r.author || "—" },
    { key: "uploadedByName", header: "Uploaded by" },
    { key: "uploadedAt", header: archived ? "Archived" : "Uploaded", cell: (r) => shortDate(archived ? r.archivedAt : r.uploadedAt) },
  ];
  return (
    <div className="space-y-8">
      <section className="space-y-3" aria-labelledby="builtin-looks">
        <h2 id="builtin-looks" className="text-sm font-medium">
          Built-in looks
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {builtins.map((k) => (
            <Card key={k.id} data-theme-builtin={k.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Swatch colors={k.swatch} label={`${k.label} colours`} /> {k.label}
                </CardTitle>
                <CardDescription>{k.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>
      <section className="space-y-3" aria-labelledby="uploaded-themes">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="uploaded-themes" className="text-sm font-medium">
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
