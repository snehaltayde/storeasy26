"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/kit/status-badge";
import { Swatch } from "@/components/admin/themes/Swatch";
import { ApplyThemeDialog } from "@/components/admin/themes/ApplyThemeDialog";
import { FLAGSHIP_WORDS, headingFamily, openDesignPreview } from "@/components/admin/themes/theme-words";

// "Storeasy themes" (Phase 7 line 1): the five flagship cards at the top of
// /admin/themes. Each: its colours, what it is for, its description and a
// heading sample in its own heading face; "Live" / "In your draft";
// "Use this theme" (storefront.write, hidden for read-only roles; the route
// installs it on first use), "Update to Volt 1.1.0" when the look in use is
// an older version, "Preview" while it is in the draft (the draft bar's
// preview), and "Details" (/admin/themes/<slug>). No Archive: flagships stay.
//   flagships: GET /api/admin/themes flagships (lib/themes/packages.js listFlagships)
export function FlagshipCards({ flagships, role, revision = null }) {
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function preview() {
    setBusy(true);
    setError(null);
    const r = await openDesignPreview(session);
    setBusy(false);
    setSession(r.session);
    if (!r.ok) setError(r.error);
  }
  if (!flagships?.length) return null;
  return (
    <section className={`space-y-3`} aria-labelledby="storeasy-themes" data-themes="flagships">
      <div className="space-y-1">
        <h2 id="storeasy-themes" className="text-lg font-semibold">
          {FLAGSHIP_WORDS.title}
        </h2>
        <p className="text-sm text-muted-foreground">{FLAGSHIP_WORDS.lead}</p>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {flagships.map((f) => {
          const inDraft = f.inUse === "draft";
          const look = { kind: "flagship", id: f.slug, label: `${f.name} ${f.version}`, sections: f.summary?.sections ?? 0 };
          return (
            <Card key={f.slug} data-theme-flagship={f.slug} className="gap-3">
              <CardContent>
                <Swatch band colors={f.swatch} label={`${f.name} colours`} />
              </CardContent>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {f.name}
                  <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">{f.version}</span>
                  {f.inUse ? <StatusBadge kind="theme" status={f.inUse} data-theme-use={f.inUse} /> : null}
                </CardTitle>
                <p className="text-xs font-medium text-muted-foreground">{f.vertical}</p>
                <p className="truncate text-2xl leading-tight" style={{ fontFamily: headingFamily(f.headingFont) }} data-theme-heading={f.headingFont}>
                  {f.sample}
                </p>
                <p className="text-xs text-muted-foreground">{f.headingFont === "serif" ? FLAGSHIP_WORDS.serif : FLAGSHIP_WORDS.sans}</p>
                <CardDescription>{f.description}</CardDescription>
                <div className="flex flex-wrap gap-2 pt-2">
                  {f.update ? <ApplyThemeDialog look={{ ...look, label: `${f.name} ${f.update.to}` }} trigger={f.update.words} role={role} revision={revision} /> : null}
                  {!inDraft && !f.update ? <ApplyThemeDialog look={look} role={role} revision={revision} /> : null}
                  {inDraft ? (
                    <Button type="button" size="sm" variant="outline" disabled={busy} aria-busy={busy} onClick={preview} data-themes-action="flagship-preview" data-read-control>
                      <ExternalLink aria-hidden /> {FLAGSHIP_WORDS.preview}
                    </Button>
                  ) : null}
                  <Button asChild size="sm" variant="ghost" data-read-control>
                    <Link href={`/admin/themes/${encodeURIComponent(f.slug)}`} data-themes-action="details">
                      {FLAGSHIP_WORDS.details}
                    </Link>
                  </Button>
                </div>
              </CardHeader>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
