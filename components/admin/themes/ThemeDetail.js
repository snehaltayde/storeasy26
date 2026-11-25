import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/kit/status-badge";
import { Swatch } from "@/components/admin/themes/Swatch";
import { ArchiveThemeDialog } from "@/components/admin/themes/ArchiveThemeDialog";
import { TEMPLATE_WORDS, shortDate } from "@/components/admin/themes/theme-words";
import { ApplyThemeDialog } from "@/components/admin/themes/ApplyThemeDialog";
import { ThemeDraftBar } from "@/components/admin/themes/ThemeDraftBar";

const TOKEN_WORDS = { accent: "Accent", background: "Background", foreground: "Text", radius: "Corners", type_scale: "Type size", button_shape: "Buttons", section_spacing: "Section spacing" };
const SURFACE_WORDS = { bg: "background", fg: "text", muted: "soft text" };
const words = (v) => String(v).replace(/[-_]/g, " ");

function Row({ label, children }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
const Colour = ({ hex }) => (
  <span className="inline-flex items-center gap-1.5">
    <span aria-hidden="true" className="size-4 rounded-full border border-border" style={{ backgroundColor: hex }} />
    <code className="font-mono text-xs">{hex}</code>
  </span>
);

// One uploaded theme in words (Phase 5 line 1): tokens, surfaces, templates,
// home sections and style rules; Download package (storefront.read) and
// Archive (themes.manage, hidden for other roles).
//   pkg, content: GET /api/admin/themes/[id]; role: the actor's role
//   state, names (line 3): the switch state and the live/draft look names
export function ThemeDetail({ pkg, content, role, state = null, names = null }) {
  const tokens = content?.tokens || {};
  const surfaces = content?.surfaces || {};
  const templates = content?.templates || {};
  const sections = templates.home?.sections || [];
  const styles = content?.styles || [];
  return (
    <div className="space-y-4" data-themes="detail">
      {names ? <ThemeDraftBar state={state} names={names} role={role} /> : null}
      <Swatch band colors={pkg.swatch} label={`${pkg.name} colours`} className="h-10" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">
            Version <span className="font-mono text-xs tabular-nums">{pkg.version}</span>, based on {pkg.baseLabel}
            {pkg.author ? `, by ${pkg.author}` : ""}. Uploaded by {pkg.uploadedByName} on {shortDate(pkg.uploadedAt)}.
          </span>
          {pkg.inUse ? <StatusBadge kind="theme" status={pkg.inUse} data-theme-use={pkg.inUse} /> : null}
          {pkg.status === "archived" ? <Badge variant="muted">Archived{pkg.archivedAt ? ` ${shortDate(pkg.archivedAt)}` : ""}</Badge> : null}
        </div>
        <span className="flex flex-wrap gap-2 sm:ml-auto">
          <Button asChild variant="outline" data-read-control>
            <a href={`/api/admin/themes/${encodeURIComponent(pkg.id)}?download=1`} download data-themes-action="download">
              <Download aria-hidden /> Download package
            </a>
          </Button>
          {pkg.status === "installed" && pkg.inUse !== "draft" && state?.draft?.package !== pkg.id ? <ApplyThemeDialog look={{ kind: "package", id: pkg.id, label: `${pkg.name} ${pkg.version}`, sections: pkg.summary?.sections ?? 0 }} role={role} revision={state?.design?.revision ?? null} size="default" /> : null}
          <ArchiveThemeDialog pkg={pkg} role={role} />
        </span>
      </div>
      {pkg.description ? <p className="text-sm">{pkg.description}</p> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Brand</CardTitle>
            <CardDescription>What the theme sets; the rest comes from {pkg.baseLabel}.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              {Object.keys(tokens).length ? Object.entries(tokens).map(([k, v]) => <Row key={k} label={TOKEN_WORDS[k] || k}>{/^#/.test(v) ? <Colour hex={v} /> : words(v)}</Row>) : <p className="text-sm text-muted-foreground">No brand settings: {pkg.baseLabel}'s own.</p>}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Header and hero colours</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              {Object.keys(surfaces).length ? Object.entries(surfaces).flatMap(([s, c]) => Object.entries(c).map(([k, v]) => <Row key={`${s}.${k}`} label={`${s === "hero" ? "Hero" : "Header"} ${SURFACE_WORDS[k]}`}><Colour hex={v} /></Row>)) : <p className="text-sm text-muted-foreground">{pkg.baseLabel}'s own.</p>}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Layouts</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              {Object.keys(TEMPLATE_WORDS).filter((k) => templates[k]).length ? Object.keys(TEMPLATE_WORDS).filter((k) => templates[k]).map((k) => <Row key={k} label={TEMPLATE_WORDS[k]}>{words(templates[k])}</Row>) : <p className="text-sm text-muted-foreground">Your store's own layouts.</p>}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Home page</CardTitle>
            <CardDescription>{sections.length ? `${sections.length} sections, added to your draft only if you choose to when applying the theme.` : "The theme doesn't change your home page."}</CardDescription>
          </CardHeader>
          {sections.length ? (
            <CardContent>
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {sections.map((s, i) => (
                  <li key={i}>
                    {words(s.kind)}
                    {typeof s.settings?.title === "string" && s.settings.title ? <span className="text-muted-foreground">: {s.settings.title}</span> : null}
                  </li>
                ))}
              </ol>
            </CardContent>
          ) : null}
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Style rules</CardTitle>
          <CardDescription>{styles.length ? `${styles.length} rules. Each changes one part of your storefront; the buy box, cart and checkout always stay Storeasy's own.` : "No style rules."}</CardDescription>
        </CardHeader>
        {styles.length ? (
          <CardContent>
            <ul className="space-y-1.5 text-sm">
              {styles.map((r, i) => (
                <li key={i}>
                  <span className="font-medium">{words(r.part)}</span>
                  <span className="text-muted-foreground">: {Object.entries(r.set).map(([p, v]) => `${words(p)} ${String(v).replace(/^role:/, "the ").replace(/-/g, " ")}`).join(", ")}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
