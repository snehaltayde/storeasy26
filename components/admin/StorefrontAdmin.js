"use client";

import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import SectionsEditor from "./SectionsEditor";
import PreviewPane from "./PreviewPane";
import { PAGE_TEMPLATES } from "@/lib/content/templates";
import { isoToLocalInput, localInputToIso } from "@/lib/admin/schedule";
import { Card, CardHeader, CardFooter } from "@/components/console/Card";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { Field, Input, Select, Textarea } from "@/components/console/fields";
import { Switch } from "@/components/console/Switch";
import { ConfirmDialog } from "@/components/console/Dialog";
import { useToast } from "@/components/console/Toast";

// Storefront CMS console (Session 23, redesigned S50): announcement bar, hero,
// home section layout, header/footer nav, content pages. Every save lands as a
// DRAFT — publishing happens in Releases (before the first release, drafts
// serve directly). Nav items are typed one per line as "Label | /path".
//
// S50 redesign: each block is a Card with its own Save (enabled only while
// that section is dirty vs its last-saved snapshot), validation/conflict
// errors stay INSIDE the card as a persistent Banner, success is a toast,
// and page/section removal goes through ConfirmDialog (window.confirm is
// gone). The PUT /api/admin/storefront contract is byte-identical to S35:
//   { block, value, revision }  revision null = expect-create, value = CAS
//                               check, ABSENT = deliberate overwrite (the
//                               post-409 retry)
//   { block, reset: true }      back to defaults
//   { page, revision }          upsert a content page (same tri-state)
//   { deletePage } / { getPage }

// S39 (MC11): one level of nesting — indent a line (spaces or "-") to make it
// a sub-item of the item above; the header renders those as a dropdown.
const navToText = (nav) =>
  Array.isArray(nav)
    ? nav
        .flatMap((i) => [`${i.label} | ${i.href}`, ...(i.children || []).map((c) => `  ${c.label} | ${c.href}`)])
        .join("\n")
    : "";
const textToNav = (text) => {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return null; // empty = back to catalog-derived
  const items = [];
  for (const raw of lines) {
    const isChild = /^(\s+|-\s)/.test(raw);
    const [label, href] = raw.replace(/^[\s-]+/, "").split("|").map((s) => s.trim());
    const item = { label: label || "", href: href || "" };
    if (isChild && items.length) {
      const parent = items[items.length - 1];
      parent.children = [...(parent.children || []), item];
    } else {
      items.push(item);
    }
  }
  return items;
};
const bodyToText = (body) => (body || []).join("\n\n");
const textToBody = (text) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);

// S38: curated collection index is edited as handle-per-line text
const ciToText = (list) => (Array.isArray(list) ? list.join("\n") : "");
const textToCi = (t) => t.split("\n").map((s) => s.trim()).filter(Boolean);

// S38 (SF13): sections are typed — text (heading + paragraphs), rich HTML
// (sanitized at save) and image (library URL). SF14: optional effective date.
const toEditSection = (s) => {
  const kind = s.kind || "text";
  if (kind === "rich") return { kind, heading: s.heading || "", html: s.html || "" };
  if (kind === "image") return { kind, src: s.src || "", alt: s.alt || "", caption: s.caption || "" };
  if (kind === "faq") return { kind, heading: s.heading || "", items: (s.items || []).map((it) => ({ q: it.q || "", a: it.a || "" })) };
  return { kind: "text", heading: s.heading || "", text: bodyToText(s.body) };
};
const fromEditSection = (s) => {
  if (s.kind === "rich") return { kind: "rich", heading: s.heading, html: s.html };
  if (s.kind === "image") return { kind: "image", src: s.src, alt: s.alt, caption: s.caption };
  if (s.kind === "faq") return { kind: "faq", heading: s.heading, items: s.items.filter((it) => it.q.trim()) };
  return { kind: "text", heading: s.heading, body: textToBody(s.text) };
};
const editSectionEmpty = (s) =>
  s.kind === "rich" ? !s.html.trim() : s.kind === "image" ? !s.src.trim() : s.kind === "faq" ? !s.items.some((it) => it.q.trim()) : !s.heading.trim();

// S50: per-section dirty tracking — the EDITED form of every block this page
// saves with its own button. A section shows "Unsaved" (and enables Save)
// when its edited state no longer JSON-matches the snapshot taken at load /
// last save. home_sections is absent on purpose: SectionsEditor autosaves.
const editedFromBlocks = (blocks) => ({
  announcement: blocks.announcement,
  hero: blocks.hero,
  collections_index: {
    featured: ciToText(blocks.collections_index?.featured),
    order: ciToText(blocks.collections_index?.order),
    hide: ciToText(blocks.collections_index?.hide),
  },
  pdp_extras: Array.isArray(blocks.pdp_extras) ? blocks.pdp_extras : [],
  nav_header: navToText(blocks.nav_header),
  nav_footer: navToText(blocks.nav_footer),
});
const snapsFromBlocks = (blocks) =>
  Object.fromEntries(Object.entries(editedFromBlocks(blocks)).map(([k, v]) => [k, JSON.stringify(v)]));

// Persistent per-section failure surface (house rule: toasts carry success
// only). The conflict copy keeps the S35 two-choice wording — pressing Save
// again resends WITHOUT a revision, i.e. a deliberate overwrite.
function SectionError({ error, className = "" }) {
  if (!error) return null;
  if (error.kind === "conflict") {
    return (
      <Banner tone="danger" title="Save blocked: this was edited by someone else since you loaded it." className={className}>
        Your changes are still in the form. Reload the page to see their version first, or press Save again to overwrite it.
      </Banner>
    );
  }
  return (
    <Banner tone="danger" className={className}>
      {error.errors.map((t, i) => (
        <p key={i}>{t}</p>
      ))}
    </Banner>
  );
}

// The card chrome every block section shares: Customized/Default + Unsaved
// badges, its own Save (enabled only while dirty) and Reset, and the error
// Banner inside the card.
function BlockCard({ title, desc, customized, dirty, saving, error, onSave, onReset, children }) {
  return (
    <Card>
      <CardHeader
        title={title}
        description={desc}
        badge={
          <>
            <Badge tone={customized ? "accent" : "neutral"}>{customized ? "Customized" : "Default"}</Badge>
            {dirty && <Badge tone="warning">Unsaved</Badge>}
          </>
        }
        actions={
          <>
            {customized && onReset && (
              <Button size="sm" variant="ghost" onClick={onReset} disabled={saving}>
                Reset to default
              </Button>
            )}
            {onSave && (
              <Button size="sm" variant="primary" busy={saving} disabled={!dirty} onClick={onSave}>
                Save
              </Button>
            )}
          </>
        }
      />
      <SectionError error={error} className="mb-4" />
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </Card>
  );
}

function PageEditor({ page, onSave, onCancel, busy, error }) {
  const [p, setP] = useState({
    slug: page.slug || "",
    title: page.title || "",
    description: page.description || "",
    enabled: page.enabled !== false,
    effective_at: page.effective_at || "",
    // S39 (SF17): campaign family + visibility window (edited in LOCAL wall
    // time; converted to UTC instants on save — merchant TZ decides)
    family: page.family || "page",
    windowStart: isoToLocalInput(page.window_start),
    windowEnd: isoToLocalInput(page.window_end),
    redirectFrom: "", // S46 (SF20): old slug to 301 from after a rename
    sections: (page.sections || []).map(toEditSection),
  });
  const [removeIdx, setRemoveIdx] = useState(null); // section index pending ConfirmDialog
  const isNew = !page.slug;
  const sec = (i, patch) => setP((prev) => ({ ...prev, sections: prev.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const addSection = (kind) =>
    setP((prev) => ({
      ...prev,
      sections: [
        ...prev.sections,
        kind === "rich"
          ? { kind, heading: "", html: "" }
          : kind === "image"
            ? { kind, src: "", alt: "", caption: "" }
            : kind === "faq"
              ? { kind, heading: "", items: [{ q: "", a: "" }] }
              : { kind: "text", heading: "", text: "" },
      ],
    }));

  return (
    <Card>
      <CardHeader
        title={isNew ? "New page" : `Edit page: ${p.slug}`}
        description="Saved as a draft — publish from Releases."
        badge={isNew ? <Badge tone="accent">New</Badge> : null}
      />
      <SectionError error={error} className="mb-4" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Slug" htmlFor="pg-slug" hint={isNew ? "lowercase-with-hyphens; served at /policies/<slug>" : "fixed"}>
          <Input id="pg-slug" value={p.slug} disabled={!isNew} onChange={(e) => setP({ ...p, slug: e.target.value })} />
        </Field>
        <Field label="Title" htmlFor="pg-title">
          <Input id="pg-title" value={p.title} onChange={(e) => setP({ ...p, title: e.target.value })} />
        </Field>
        <Field label="Meta description" htmlFor="pg-desc">
          <Input id="pg-desc" value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} />
        </Field>
        <Field label="Effective date" htmlFor="pg-effective" hint="optional — shown under the title (policy pages)">
          <Input id="pg-effective" type="date" value={p.effective_at} onChange={(e) => setP({ ...p, effective_at: e.target.value })} />
        </Field>
        <Field
          label="Family"
          htmlFor="pg-family"
          hint={
            p.family === "campaign"
              ? "served at /campaigns/<slug>, noindex, keeps utm params"
              : p.family === "journal"
                ? "served at /journal/<slug>; 'Visible from' is the publish time"
                : "served at /policies/<slug> (or /about, /contact)"
          }
        >
          <Select id="pg-family" value={p.family} onChange={(e) => setP({ ...p, family: e.target.value })}>
            <option value="page">Content / policy page</option>
            <option value="campaign">Campaign landing</option>
            <option value="journal">Journal post</option>
          </Select>
        </Field>
        {(p.family === "campaign" || p.family === "journal") && (
          <>
            <Field label={p.family === "journal" ? "Publish at" : "Visible from"} htmlFor="pg-window-start" hint="your local time — blank = immediately">
              <Input id="pg-window-start" type="datetime-local" value={p.windowStart} onChange={(e) => setP({ ...p, windowStart: e.target.value })} />
            </Field>
            <Field label="Visible until" htmlFor="pg-window-end" hint="your local time — blank = no end">
              <Input id="pg-window-end" type="datetime-local" value={p.windowEnd} onChange={(e) => setP({ ...p, windowEnd: e.target.value })} />
            </Field>
          </>
        )}
        {p.family === "journal" && !isNew && (
          <Field label="Redirect from old slug" htmlFor="pg-redirect" hint="renamed this post? the old slug 301s here (optional)">
            <Input id="pg-redirect" placeholder="old-slug" value={p.redirectFrom} onChange={(e) => setP({ ...p, redirectFrom: e.target.value })} />
          </Field>
        )}
        {p.sections.map((s, i) => (
          <Card as="div" key={i} padded={false} className="p-3 sm:col-span-2">
            <div className="flex items-center gap-2">
              <Badge tone="neutral">{s.kind}</Badge>
              {s.kind !== "image" && (
                <Input
                  aria-label="Section heading"
                  placeholder={s.kind === "rich" ? "Heading (optional)" : "Section heading"}
                  value={s.heading}
                  onChange={(e) => sec(i, { heading: e.target.value })}
                />
              )}
              <IconButton label="Remove section" icon={<Trash2 size={14} aria-hidden />} className="ml-auto" onClick={() => setRemoveIdx(i)} />
            </div>
            {s.kind === "text" && (
              <Textarea
                aria-label="Section paragraphs"
                className="mt-2 min-h-24"
                placeholder="Paragraphs — separate with a blank line"
                value={s.text}
                onChange={(e) => sec(i, { text: e.target.value })}
              />
            )}
            {s.kind === "rich" && (
              <Textarea
                mono
                aria-label="Section HTML"
                className="mt-2 min-h-24"
                placeholder="<p>HTML — scripts and event handlers are stripped on save</p>"
                value={s.html}
                onChange={(e) => sec(i, { html: e.target.value })}
              />
            )}
            {s.kind === "image" && (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Input aria-label="Image URL" placeholder="/api/media/… or https://…" value={s.src} onChange={(e) => sec(i, { src: e.target.value })} />
                <Input aria-label="Alt text" placeholder="Alt text (required)" value={s.alt} onChange={(e) => sec(i, { alt: e.target.value })} />
                <Input aria-label="Caption" className="sm:col-span-2" placeholder="Caption (optional)" value={s.caption} onChange={(e) => sec(i, { caption: e.target.value })} />
              </div>
            )}
            {s.kind === "faq" && (
              <div className="mt-2 space-y-2">
                {s.items.map((it, j) => (
                  <div key={j} className="rounded-ctl border border-edge p-2">
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label="Question"
                        placeholder="Question"
                        value={it.q}
                        onChange={(e) => sec(i, { items: s.items.map((y, k) => (k === j ? { ...y, q: e.target.value } : y)) })}
                      />
                      <IconButton label="Remove question" icon={<X size={14} aria-hidden />} onClick={() => sec(i, { items: s.items.filter((_, k) => k !== j) })} />
                    </div>
                    <Textarea
                      mono
                      aria-label="Answer HTML"
                      className="mt-2 min-h-16"
                      placeholder="<p>Answer — HTML, sanitized on save</p>"
                      value={it.a}
                      onChange={(e) => sec(i, { items: s.items.map((y, k) => (k === j ? { ...y, a: e.target.value } : y)) })}
                    />
                  </div>
                ))}
                <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} onClick={() => sec(i, { items: [...s.items, { q: "", a: "" }] })}>
                  Add question
                </Button>
              </div>
            )}
          </Card>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
          <span className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} onClick={() => addSection("text")}>Text</Button>
            <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} onClick={() => addSection("rich")}>Rich HTML</Button>
            <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} onClick={() => addSection("image")}>Image</Button>
            <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} onClick={() => addSection("faq")}>FAQ</Button>
          </span>
          <span className="flex items-center gap-2 text-sm text-fg">
            <Switch checked={p.enabled} onChange={(v) => setP({ ...p, enabled: v })} label="Visible" />
            Visible
          </span>
        </div>
      </div>
      <CardFooter>
        <Button
          variant="primary"
          busy={busy}
          onClick={() =>
            onSave({
              slug: p.slug.trim(),
              title: p.title,
              description: p.description,
              enabled: p.enabled,
              effective_at: p.effective_at || null,
              family: p.family,
              window_start: p.family === "campaign" || p.family === "journal" ? localInputToIso(p.windowStart) : null,
              window_end: p.family === "campaign" || p.family === "journal" ? localInputToIso(p.windowEnd) : null,
              redirect_from: p.family === "journal" && p.redirectFrom.trim() ? p.redirectFrom.trim() : undefined,
              sections: p.sections.filter((s) => !editSectionEmpty(s)).map(fromEditSection),
            })
          }
        >
          Save page
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </CardFooter>
      <ConfirmDialog
        open={removeIdx != null}
        onClose={() => setRemoveIdx(null)}
        title="Remove section"
        tone="danger"
        confirmLabel="Remove section"
        body="Removes this section from the page. Nothing persists until you save the page."
        onConfirm={() => setP((prev) => ({ ...prev, sections: prev.sections.filter((_, j) => j !== removeIdx) }))}
      />
    </Card>
  );
}

export default function StorefrontAdmin({ initial }) {
  const toast = useToast();
  const [data, setData] = useState(initial); // customized/revisions/pageRevisions/pages
  const [ann, setAnn] = useState(initial.blocks.announcement);
  const [hero, setHero] = useState(initial.blocks.hero);
  const [sections, setSections] = useState(initial.blocks.home_sections);
  const [navHeader, setNavHeader] = useState(() => navToText(initial.blocks.nav_header));
  const [navFooter, setNavFooter] = useState(() => navToText(initial.blocks.nav_footer));
  const [ci, setCi] = useState(() => editedFromBlocks(initial.blocks).collections_index);
  const [extras, setExtras] = useState(() => editedFromBlocks(initial.blocks).pdp_extras);
  const [editingPage, setEditingPage] = useState(null); // page object | null
  const [removePage, setRemovePage] = useState(null); // slug pending ConfirmDialog
  const [pageAction, setPageAction] = useState(null); // {slug, kind: "edit"|"clone"} in flight
  const [saving, setSaving] = useState({}); // section key -> PUT in flight
  const [errs, setErrs] = useState({}); // section key -> {kind:"conflict"} | {kind:"error", errors}
  // S50: last-saved snapshot per section — Save enables only while dirty
  const [snaps, setSnaps] = useState(() => snapsFromBlocks(initial.blocks));
  // S35: after a 409, remember WHAT conflicted so a deliberate re-save of that
  // same thing overwrites (sends no revision) instead of looping on 409.
  const [conflict, setConflict] = useState(null);

  const edited = { announcement: ann, hero, collections_index: ci, pdp_extras: extras, nav_header: navHeader, nav_footer: navFooter };
  const dirty = (key) => JSON.stringify(edited[key]) !== snaps[key];

  // Fold a successful PUT's fresh view into state WITHOUT clobbering other
  // sections' unsaved edits (the pre-S50 editor reset every field on any
  // save): only the saved block's edited state, snapshot and CAS revision
  // move — other blocks keep the revision their on-screen edits are based
  // on, so a stale save of those still 409s as it should.
  function applyView(json, block) {
    setData((d) => ({
      ...d,
      customized: json.customized ?? d.customized,
      pages: json.pages ?? d.pages,
      pageRevisions: json.pageRevisions ?? d.pageRevisions,
      revisions: block ? { ...d.revisions, [block]: json.revisions?.[block] ?? null } : d.revisions,
    }));
    if (!block) return;
    if (block === "home_sections") {
      // remounts SectionsEditor (key={revision}) with the server's content
      setSections(json.blocks.home_sections);
      return;
    }
    const fresh = editedFromBlocks(json.blocks);
    if (!(block in fresh)) return;
    const setter = { announcement: setAnn, hero: setHero, collections_index: setCi, pdp_extras: setExtras, nav_header: setNavHeader, nav_footer: setNavFooter }[block];
    setter(fresh[block]);
    setSnaps((s) => ({ ...s, [block]: JSON.stringify(fresh[block]) }));
  }

  // One PUT wire for every mutation; `key` picks which card owns the busy
  // state and the error Banner ("page" = the inline PageEditor), `block` is
  // set for block saves/resets so applyView refreshes exactly that section.
  async function put(key, body, { block = null, toastText = "Saved as a draft — publish from Releases" } = {}) {
    setSaving((s) => ({ ...s, [key]: true }));
    setErrs((e) => ({ ...e, [key]: null }));
    const res = await fetch("/api/admin/storefront", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) {
      if (json.blocks) applyView(json, block);
      toast.success(toastText);
    } else if (res.status === 409) {
      // S35 (code CMS_CONFLICT): someone else saved since this editor loaded.
      // Their version is on the server, yours stays in the form — the Banner
      // offers reload vs press-Save-again (which resends WITHOUT a revision).
      setErrs((e) => ({ ...e, [key]: { kind: "conflict" } }));
      setConflict(body); // next save of the same target skips the stale check
    } else {
      setErrs((e) => ({ ...e, [key]: { kind: "error", errors: json.errors || [json.error || `Save failed (${res.status})`] } }));
    }
    setSaving((s) => ({ ...s, [key]: false }));
    return json;
  }

  // Saves carry the revision loaded with the current view (CAS). After a 409
  // on the same target, the retry omits the revision = deliberate overwrite.
  const saveBlock = (block, value) => {
    const overwrite = conflict?.block === block;
    if (overwrite) setConflict(null);
    return put(block, { block, value, ...(overwrite ? {} : { revision: data.revisions?.[block] ?? null }) }, { block });
  };
  const savePage = (page) => {
    const overwrite = conflict?.page?.slug === page.slug;
    if (overwrite) setConflict(null);
    return put("page", { page, ...(overwrite ? {} : { revision: data.pageRevisions?.[page.slug] ?? null }) });
  };
  const resetBlock = (block) => put(block, { block, reset: true }, { block, toastText: "Reset to default — publish from Releases" });

  // Editor prefill ({getPage} is a read); failures surface in the pages card.
  async function fetchPage(slug) {
    const res = await fetch("/api/admin/storefront", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ getPage: slug }),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.page) throw new Error(json.error || `Couldn't load the "${slug}" page`);
    return json.page;
  }
  const startEditing = (page) => {
    setErrs((e) => ({ ...e, page: null })); // a fresh editor starts clean
    setEditingPage(page);
  };
  async function openPage(slug, kind = "edit") {
    setPageAction({ slug, kind });
    setErrs((e) => ({ ...e, pages: null }));
    try {
      const page = await fetchPage(slug);
      // S37 (MC09): clone = open the editor prefilled with a copy, new slug
      startEditing(kind === "clone" ? { ...page, slug: `${page.slug}-copy`, title: `${page.title} (copy)` } : page);
    } catch (e) {
      setErrs((er) => ({ ...er, pages: { kind: "error", errors: [String(e.message || e)] } }));
    }
    setPageAction(null);
  }
  // ConfirmDialog owns the in-flight state; a thrown error renders in it.
  async function deletePage(slug) {
    const res = await fetch("/api/admin/storefront", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deletePage: slug }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error(json.error || `Remove failed (${res.status})`);
    applyView(json, null);
    toast.success("Page removed — publish from Releases");
  }

  const pagePath = (p) =>
    p.slug === "about" || p.slug === "contact" ? p.slug : p.family === "campaign" ? `campaigns/${p.slug}` : p.family === "journal" ? `journal/${p.slug}` : `policies/${p.slug}`;

  if (editingPage) {
    return (
      <PageEditor
        page={editingPage}
        busy={!!saving.page}
        error={errs.page}
        onCancel={() => setEditingPage(null)}
        onSave={async (page) => {
          const json = await savePage(page);
          if (json.ok) setEditingPage(null);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <BlockCard
        title="Announcement bar"
        desc="Thin strip above the header."
        customized={data.customized.announcement}
        dirty={dirty("announcement")}
        saving={!!saving.announcement}
        error={errs.announcement}
        onSave={() => saveBlock("announcement", ann)}
        onReset={() => resetBlock("announcement")}
      >
        <Field label="Text" htmlFor="ann-text">
          <Input id="ann-text" value={ann.text} onChange={(e) => setAnn({ ...ann, text: e.target.value })} />
        </Field>
        <Field label="Link" htmlFor="ann-href" hint="optional — /collections/sale or a full URL">
          <Input id="ann-href" value={ann.href} onChange={(e) => setAnn({ ...ann, href: e.target.value })} />
        </Field>
        <span className="flex items-center gap-2 text-sm text-fg">
          <Switch checked={!!ann.enabled} onChange={(v) => setAnn({ ...ann, enabled: v })} label="Show the bar" />
          Show the bar
        </span>
      </BlockCard>

      <BlockCard
        title="Hero"
        desc="The big home-page opener."
        customized={data.customized.hero}
        dirty={dirty("hero")}
        saving={!!saving.hero}
        error={errs.hero}
        onSave={() => saveBlock("hero", hero)}
        onReset={() => resetBlock("hero")}
      >
        <Field label="Title" htmlFor="hero-title">
          <Input id="hero-title" value={hero.title} onChange={(e) => setHero({ ...hero, title: e.target.value })} />
        </Field>
        <Field label="Highlight" htmlFor="hero-highlight" hint="substring of the title shown in the accent color">
          <Input id="hero-highlight" value={hero.highlight || ""} onChange={(e) => setHero({ ...hero, highlight: e.target.value })} />
        </Field>
        <Field label="Subtitle" htmlFor="hero-subtitle" className="sm:col-span-2">
          <Input id="hero-subtitle" value={hero.subtitle || ""} onChange={(e) => setHero({ ...hero, subtitle: e.target.value })} />
        </Field>
        <Field label="Badge" htmlFor="hero-badge" hint="blank = live catalog stats">
          <Input id="hero-badge" value={hero.badge || ""} onChange={(e) => setHero({ ...hero, badge: e.target.value })} />
        </Field>
        <div />
        <Field label="Primary CTA label" htmlFor="hero-p-label">
          <Input id="hero-p-label" value={hero.primary?.label || ""} onChange={(e) => setHero({ ...hero, primary: { ...hero.primary, label: e.target.value } })} />
        </Field>
        <Field label="Primary CTA link" htmlFor="hero-p-href">
          <Input id="hero-p-href" value={hero.primary?.href || ""} onChange={(e) => setHero({ ...hero, primary: { ...hero.primary, href: e.target.value } })} />
        </Field>
        <Field label="Secondary CTA label" htmlFor="hero-s-label">
          <Input id="hero-s-label" value={hero.secondary?.label || ""} onChange={(e) => setHero({ ...hero, secondary: { ...hero.secondary, label: e.target.value } })} />
        </Field>
        <Field label="Secondary CTA link" htmlFor="hero-s-href">
          <Input id="hero-s-href" value={hero.secondary?.href || ""} onChange={(e) => setHero({ ...hero, secondary: { ...hero.secondary, href: e.target.value } })} />
        </Field>
      </BlockCard>

      {/* S37 (MC08): section-tree editor — autosaves its own drafts, so this
          card has no Save button or Unsaved badge of its own */}
      <Card>
        <CardHeader
          title="Home sections"
          description="Compose the home page: reorder, hide, duplicate; banner and rich-text sections included. Changes autosave as drafts."
          badge={<Badge tone={data.customized.home_sections ? "accent" : "neutral"}>{data.customized.home_sections ? "Customized" : "Default"}</Badge>}
        />
        <SectionError error={errs.home_sections} className="mb-4" />
        <SectionsEditor
          key={data.revisions?.home_sections ?? "fresh"}
          initial={sections}
          revision={data.revisions?.home_sections ?? null}
          customized={data.customized.home_sections}
          onReset={() => resetBlock("home_sections")}
          busy={!!saving.home_sections}
        />
      </Card>

      <PreviewPane />

      {/* S38 (SF02): curated collection index */}
      <BlockCard
        title="Collections index"
        desc="Curate /collections and the home collections row: featured handles get a badge and lead the list; hidden handles don't render. Empty = automatic."
        customized={data.customized.collections_index}
        dirty={dirty("collections_index")}
        saving={!!saving.collections_index}
        error={errs.collections_index}
        onSave={() =>
          saveBlock(
            "collections_index",
            ci.featured.trim() || ci.order.trim() || ci.hide.trim() ? { featured: textToCi(ci.featured), order: textToCi(ci.order), hide: textToCi(ci.hide) } : null,
          )
        }
        onReset={() => resetBlock("collections_index")}
      >
        <Field label="Featured" htmlFor="ci-featured" hint="collection handles, one per line (max 6) — shown first with a badge; also the home collections row">
          <Textarea id="ci-featured" mono value={ci.featured} onChange={(e) => setCi({ ...ci, featured: e.target.value })} placeholder={"protein\nsale"} />
        </Field>
        <Field label="Then, in this order" htmlFor="ci-order" hint="optional — remaining collections follow alphabetically">
          <Textarea id="ci-order" mono value={ci.order} onChange={(e) => setCi({ ...ci, order: e.target.value })} />
        </Field>
        <Field label="Hidden" htmlFor="ci-hide" hint="handles never shown on the index">
          <Textarea id="ci-hide" mono value={ci.hide} onChange={(e) => setCi({ ...ci, hide: e.target.value })} />
        </Field>
      </BlockCard>

      {/* S38 (SF04): PDP accordions */}
      <BlockCard
        title="Product page extras"
        desc="Accordions under every product description — shipping, returns, lab reports. HTML is sanitized on save."
        customized={data.customized.pdp_extras}
        dirty={dirty("pdp_extras")}
        saving={!!saving.pdp_extras}
        error={errs.pdp_extras}
        onSave={() => saveBlock("pdp_extras", extras.length ? extras : null)}
        onReset={() => resetBlock("pdp_extras")}
      >
        {extras.map((x, i) => (
          <div key={i} className="rounded-ctl border border-edge p-3 sm:col-span-2">
            <div className="flex items-center gap-2">
              <Input
                aria-label="Accordion title"
                placeholder="Accordion title (e.g. Shipping & delivery)"
                value={x.title}
                onChange={(e) => setExtras(extras.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)))}
              />
              <IconButton label="Remove accordion" icon={<Trash2 size={14} aria-hidden />} onClick={() => setExtras(extras.filter((_, j) => j !== i))} />
            </div>
            <Textarea
              mono
              aria-label="Accordion HTML"
              className="mt-2"
              placeholder="<p>Content…</p>"
              value={x.html}
              onChange={(e) => setExtras(extras.map((y, j) => (j === i ? { ...y, html: e.target.value } : y)))}
            />
          </div>
        ))}
        <div className="sm:col-span-2">
          <Button size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} onClick={() => setExtras([...extras, { title: "", html: "", enabled: true }])}>
            Add accordion
          </Button>
        </div>
      </BlockCard>

      <BlockCard
        title="Header navigation"
        desc="The storefront's main menu."
        customized={data.customized.nav_header}
        dirty={dirty("nav_header")}
        saving={!!saving.nav_header}
        error={errs.nav_header}
        onSave={() => saveBlock("nav_header", textToNav(navHeader))}
        onReset={() => resetBlock("nav_header")}
      >
        <Field
          label="Items"
          htmlFor="nav-header"
          className="sm:col-span-2"
          hint={'One per line: "Label | /path". Indent a line to nest it under the item above (renders as a dropdown). Empty = all collections (automatic).'}
        >
          <Textarea
            id="nav-header"
            mono
            className="min-h-24"
            value={navHeader}
            onChange={(e) => setNavHeader(e.target.value)}
            placeholder={"Proteins | /collections/protein\n  Whey | /collections/whey\n  Isolate | /collections/isolate\nSale | /collections/sale"}
          />
        </Field>
      </BlockCard>

      <BlockCard
        title="Footer shop links"
        desc="The Shop column in the storefront footer."
        customized={data.customized.nav_footer}
        dirty={dirty("nav_footer")}
        saving={!!saving.nav_footer}
        error={errs.nav_footer}
        onSave={() => saveBlock("nav_footer", textToNav(navFooter))}
        onReset={() => resetBlock("nav_footer")}
      >
        <Field label="Items" htmlFor="nav-footer" className="sm:col-span-2" hint={'One per line: "Label | /path". Empty = top 5 collections (automatic).'}>
          <Textarea id="nav-footer" mono className="min-h-24" value={navFooter} onChange={(e) => setNavFooter(e.target.value)} />
        </Field>
      </BlockCard>

      <Card>
        <CardHeader
          title="Content pages"
          description="About, contact and policies — defaults until you customize them."
          actions={
            /* S37 (MC09): named templates for the content-page family */
            <Select
              aria-label="New page from template"
              value=""
              className="w-56 text-xs"
              onChange={(e) => {
                const t = PAGE_TEMPLATES.find((x) => x.id === e.target.value);
                if (t) startEditing(JSON.parse(JSON.stringify(t.page)));
              }}
            >
              <option value="" disabled>
                + New page from template…
              </option>
              {PAGE_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          }
        />
        <SectionError error={errs.pages} className="mb-3" />
        <ul className="divide-y divide-edge">
          {data.pages.map((p) => (
            <li key={p.slug} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-fg">{p.title}</span>
                <span className="ml-2 font-mono text-xs text-fg-subtle">/{pagePath(p)}</span>
              </span>
              <Badge tone={p.source === "custom" ? "accent" : "neutral"}>{p.source === "custom" ? "Customized" : "Default"}</Badge>
              {!p.enabled && <Badge tone="warning">Hidden</Badge>}
              <Button size="sm" variant="ghost" busy={pageAction?.slug === p.slug && pageAction.kind === "edit"} onClick={() => openPage(p.slug, "edit")}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" busy={pageAction?.slug === p.slug && pageAction.kind === "clone"} onClick={() => openPage(p.slug, "clone")}>
                Clone
              </Button>
              {p.source === "custom" && (
                <Button size="sm" variant="dangerOutline" onClick={() => setRemovePage(p.slug)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
        <ConfirmDialog
          open={!!removePage}
          onClose={() => setRemovePage(null)}
          title="Remove customized page"
          tone="danger"
          confirmLabel="Remove page"
          body={`Remove the customized "${removePage}" page? Default content (if any) returns.`}
          onConfirm={() => deletePage(removePage)}
        />
      </Card>
    </div>
  );
}
