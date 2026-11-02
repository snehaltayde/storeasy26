"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronDown, ChevronUp, Copy, ExternalLink, History, ImagePlus, Plus, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/console/PageHeader";
import { Card, CardHeader } from "@/components/console/Card";
import { Badge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Button, IconButton } from "@/components/console/Button";
import { Switch } from "@/components/console/Switch";
import { Field, Input, Textarea, Select } from "@/components/console/fields";
import { ConfirmDialog, Dialog } from "@/components/console/Dialog";
import { EmptyState, ErrorState, SkeletonText } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";
import { isoToLocalInput, localInputToIso } from "@/lib/admin/schedule";
import { PAGE_TEMPLATES } from "@/lib/content/templates";
import { savePage, getPage, getHistory, startPreview, useTemplate, saveTemplateApi } from "./api";
import { ConflictBanner } from "./ConflictBanner";
import { useDirtyGuard } from "./useDirtyGuard";
import { MediaPicker } from "./MediaPicker";
import { pageUrl, FAMILY_LABELS } from "./labels";
import { pageStatus } from "./PagesList";
import { toEdit, editEmpty, sectionsPayload, blankSection } from "./pageSections";

// The page editor (S52): one screen for creating and editing content pages.
// Sections keep the S38 data shapes exactly (text body = paragraphs split on
// blank lines); saves ride the S35 CAS revision (number = check, null =
// expect-create, omitted = deliberate overwrite after a conflict). Create
// mode fixes the old locked-slug bug: template/duplicate slugs are only ever
// PREFILLS — the field stays editable, auto-suggested from the title until
// the merchant types a slug themselves.

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const suggestSlug = (title) =>
  String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 61);

const SECTION_LABELS = { text: "Text", rich: "Rich HTML", image: "Image", faq: "FAQ" };

// Server page → editable form state. Section ids are deterministic (`s<i>`)
// so SSR and hydration agree; sections added later get client-only ids.
const formFrom = (page) => ({
  slug: page.slug || "",
  title: page.title || "",
  description: page.description || "",
  enabled: page.enabled !== false,
  effective_at: page.effective_at || "",
  family: page.family || "page",
  windowStart: isoToLocalInput(page.window_start),
  windowEnd: isoToLocalInput(page.window_end),
  redirectFrom: "",
  sections: (page.sections || []).map((s, i) => toEdit(s, `s${i}`)),
});

// Dirty = the form (minus the client-only keys AND the durable pids — ids
// are identity, not content) no longer matches the load/save snapshot.
const fingerprint = (f) => JSON.stringify({ ...f, sections: f.sections.map(({ id, pid, ...rest }) => rest) });

const FAMILY_HINTS = {
  page: "Served at /policies/<slug> (about and contact get their own URLs).",
  campaign: "Served at /campaigns/<slug> inside the visibility window; noindex, keeps UTM params.",
  journal: "Served at /journal/<slug>; “Publish at” is the scheduled publish time.",
};

export function PageEditor({ mode, page, revision: initialRevision, fromMissing = false, tenantTemplates = [] }) {
  const router = useRouter();
  const toast = useToast();
  const isNew = mode === "create";

  const [form, setForm] = useState(() => formFrom(page));
  const [snap, setSnap] = useState(() => fingerprint(formFrom(page)));
  const [revision, setRevision] = useState(initialRevision);
  const [slugTouched, setSlugTouched] = useState(false); // create mode auto-suggests the slug from the title until the merchant edits it
  const [savedFamily, setSavedFamily] = useState(page.family || "page"); // the LAST SAVED family — preview and "served at" use this, not unsaved edits
  const [templateId, setTemplateId] = useState("blank");
  const [pendingTemplate, setPendingTemplate] = useState(null); // template pick awaiting the "replace content?" confirm
  const [saving, setSaving] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [problems, setProblems] = useState(null); // string[] — persistent 422 / validation Banner
  const [conflict, setConflict] = useState(null); // {current} from a 409
  const [conflictBusy, setConflictBusy] = useState(false);
  const [removeId, setRemoveId] = useState(null); // section id pending the remove confirm
  const [confirmBack, setConfirmBack] = useState(false);
  const [pickerFor, setPickerFor] = useState(null); // section id the MediaPicker fills
  const [saveTplOpen, setSaveTplOpen] = useState(false); // S54: "Save as template" dialog
  const [templateName, setTemplateName] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false); // S55: draft revision history dialog
  const [hist, setHist] = useState({ status: "idle", entries: [], error: null }); // idle|loading|error|ready
  const idRef = useRef((page.sections || []).length); // next client-side section id
  const nextId = () => `n${idRef.current++}`;

  const dirty = useMemo(() => fingerprint(form) !== snap, [form, snap]);
  useDirtyGuard(dirty);

  const slugError =
    isNew && form.slug && !SLUG_RE.test(form.slug) ? "Lowercase letters, digits and hyphens only; must start with a letter or digit (max 61 chars)." : null;

  const status = pageStatus({
    enabled: form.enabled,
    family: form.family,
    window_start: form.family !== "page" ? localInputToIso(form.windowStart) : null,
    window_end: form.family !== "page" ? localInputToIso(form.windowEnd) : null,
  });

  const patch = (p) => setForm((f) => ({ ...f, ...p }));
  const patchSection = (id, p) => setForm((f) => ({ ...f, sections: f.sections.map((s) => (s.id === id ? { ...s, ...p } : s)) }));

  // ---- field handlers -------------------------------------------------------
  const changeTitle = (v) => setForm((f) => ({ ...f, title: v, slug: isNew && !slugTouched ? suggestSlug(v) : f.slug }));
  const changeSlug = (v) => {
    setSlugTouched(true);
    setForm((f) => ({ ...f, slug: v }));
  };
  const changeFamily = (fam) => {
    if (fam === "page" && (form.windowStart || form.windowEnd)) toast.info("Visibility window cleared — standard pages don’t use windows.");
    setForm((f) => ({ ...f, family: fam, ...(fam === "page" ? { windowStart: "", windowEnd: "" } : {}) }));
  };

  // ---- templates (create mode): prefill ONCE on explicit pick ---------------
  // S54: "tpl:<id>" values are TENANT-SAVED templates (cms_templates) — the
  // server instantiates an independent copy with fresh durable section ids.
  async function applyTemplate(id) {
    if (id.startsWith("tpl:")) {
      const r = await useTemplate(id.slice(4));
      if (!r.ok || !r.template) {
        toast.error(r.error || "Couldn’t load that template");
        return;
      }
      setForm((f) => ({
        ...f,
        family: r.template.family || "page",
        windowStart: "",
        windowEnd: "",
        sections: (r.template.sections || []).map((s) => toEdit(s, nextId())),
      }));
      setTemplateId(id);
      return;
    }
    const t = PAGE_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    const tp = t.page || {};
    setForm((f) => ({
      ...f,
      title: tp.title || "",
      description: tp.description || "",
      family: tp.family || "page",
      windowStart: "",
      windowEnd: "",
      // a template slug is a PREFILL, never a lock — type-over stays allowed
      slug: slugTouched && f.slug ? f.slug : tp.slug || "",
      sections: (tp.sections || []).map((s) => toEdit(s, nextId())),
    }));
    setTemplateId(id);
  }
  const requestTemplate = (id) => {
    if (id === templateId) return;
    // confirm when the form already holds content (typed OR duplicated) — a
    // pristine duplicate isn't "dirty", but wiping it silently would still hurt
    if (dirty || form.title.trim() || form.sections.length > 0) setPendingTemplate(id);
    else applyTemplate(id);
  };

  // ---- sections -------------------------------------------------------------
  const addSection = (kind) => setForm((f) => ({ ...f, sections: [...f.sections, blankSection(kind, nextId())] }));
  const moveSection = (id, delta) =>
    setForm((f) => {
      const i = f.sections.findIndex((s) => s.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= f.sections.length) return f;
      const sections = [...f.sections];
      [sections[i], sections[j]] = [sections[j], sections[i]];
      return { ...f, sections };
    });
  const duplicateSection = (id) =>
    setForm((f) => {
      const i = f.sections.findIndex((s) => s.id === id);
      if (i < 0) return f;
      const copy = JSON.parse(JSON.stringify(f.sections[i]));
      copy.id = nextId();
      delete copy.pid; // a duplicate is a NEW instance — the server mints its id
      const sections = [...f.sections];
      sections.splice(i + 1, 0, copy);
      return { ...f, sections };
    });

  // ---- save -----------------------------------------------------------------
  const buildPayload = () => ({
    slug: isNew ? form.slug.trim() : page.slug,
    title: form.title,
    description: form.description,
    enabled: form.enabled,
    effective_at: form.family === "page" && form.effective_at ? form.effective_at : null,
    family: form.family,
    window_start: form.family !== "page" ? localInputToIso(form.windowStart) : null,
    window_end: form.family !== "page" ? localInputToIso(form.windowEnd) : null,
    redirect_from: !isNew && form.family === "journal" && form.redirectFrom.trim() ? form.redirectFrom.trim().toLowerCase() : undefined,
    sections: sectionsPayload(form.sections),
  });

  async function save({ overwrite = false } = {}) {
    const payload = buildPayload();
    const pre = [];
    if (!payload.title.trim()) pre.push("Title is required.");
    if (!SLUG_RE.test(payload.slug)) pre.push("Slug must be lowercase letters, digits and hyphens, starting with a letter or digit (max 61 chars).");
    if (pre.length) {
      setProblems(pre);
      return;
    }
    setProblems(null);
    setSaving(true);
    // revision semantics (S35/S53): number = CAS, null = expect-create, force = deliberate overwrite
    const res = overwrite ? await savePage(payload, undefined, { force: true }) : await savePage(payload, revision);
    setSaving(false);
    if (res.ok) {
      setConflict(null);
      setRevision(res.pageRevisions?.[payload.slug] ?? null);
      setSavedFamily(payload.family);
      setSnap(fingerprint(form));
      toast.success("Saved as a draft — publish from Publishing");
      if (isNew) {
        router.replace(`/admin/storefront/pages/${payload.slug}`);
        return;
      }
      // S54: adopt the server-minted durable ids for sections saved without
      // one, so identity holds from THIS save on (not only after a reload).
      const fresh = await getPage(payload.slug);
      if (fresh.ok && Array.isArray(fresh.page?.sections)) {
        setForm((f) => ({
          ...f,
          sections: f.sections.map((s, i) => (s.pid ? s : { ...s, pid: fresh.page.sections[i]?.id })),
        }));
      }
      return;
    }
    if (res.conflict) {
      setConflict(res.conflict);
      return;
    }
    setProblems(res.errors?.length ? res.errors : [res.error || "Save failed — try again."]);
  }

  async function takeTheirs() {
    setConflictBusy(true);
    const r = await getPage(page.slug || form.slug.trim());
    setConflictBusy(false);
    if (!r.ok || !r.page) {
      setProblems([r.error || "Their version is hidden or was deleted — go back to Pages and reopen this page."]);
      return;
    }
    const f = formFrom({ ...r.page, enabled: true });
    setForm(f);
    setSnap(fingerprint(f));
    setRevision(conflict?.current?.revision ?? null);
    setConflict(null);
    toast.info("Loaded their version — your unsaved edits were discarded.");
  }

  // ---- history (S55 / audit slice 5) -----------------------------------------
  // Restore is deliberately NOT a write: "Load this version" replaces the FORM
  // (through the same formFrom machinery a fresh load uses) as an UNSAVED
  // change — the ordinary save path (validation + CAS) takes it from there.
  async function loadHistory() {
    setHist({ status: "loading", entries: [], error: null });
    const r = await getHistory("page", page.slug);
    if (r.ok) setHist({ status: "ready", entries: r.history || [], error: null });
    else setHist({ status: "error", entries: [], error: r.error || "Couldn't load the version history." });
  }
  function openHistory() {
    setHistoryOpen(true);
    loadHistory();
  }
  function loadVersion(entry) {
    if (!entry?.value) return;
    // keep the CURRENT slug (slugs are permanent) and the CURRENT revision —
    // the eventual save stays CAS-checked against today's head, not history's.
    setForm(formFrom({ ...entry.value, slug: page.slug }));
    setHistoryOpen(false);
    toast.info("Version loaded into the editor — nothing changes until you save.");
  }

  // ---- preview --------------------------------------------------------------
  async function preview() {
    setPreviewBusy(true);
    const url = pageUrl({ slug: page.slug, family: savedFamily });
    const r = await startPreview(url);
    setPreviewBusy(false);
    if (!r.ok) {
      setProblems([r.error || "Couldn't start a preview session."]);
      return;
    }
    window.open(url, "_blank", "noopener");
  }

  const headerTitle = form.title.trim() || (isNew ? "New page" : page.title || page.slug);

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: "Pages", href: "/admin/storefront/pages" }, { label: headerTitle }]}
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            <span className="min-w-0 truncate">{headerTitle}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
            {dirty && <Badge tone="warning">Unsaved</Badge>}
          </span>
        }
        description={
          isNew
            ? "Saves as a draft — publish from Publishing. Navigation menus are managed separately in Navigation."
            : `Served at ${pageUrl({ slug: page.slug, family: savedFamily })} · saves as a draft — publish from Publishing.`
        }
        actions={
          <>
            <Button
              variant="ghost"
              icon={<ArrowLeft size={14} aria-hidden />}
              onClick={() => (dirty ? setConfirmBack(true) : router.push("/admin/storefront/pages"))}
            >
              Back to pages
            </Button>
            <Button
              icon={<ExternalLink size={14} aria-hidden />}
              busy={previewBusy}
              disabled={isNew}
              title={isNew ? "Save the page first — preview opens the saved draft" : "Open a draft preview in a new tab"}
              onClick={preview}
            >
              Preview
            </Button>
            <Button
              icon={<History size={14} aria-hidden />}
              disabled={isNew}
              title={isNew ? "Save the page first — history starts with your first save" : "Load an earlier saved version into the editor"}
              onClick={openHistory}
            >
              History
            </Button>
            <Button
              icon={<Copy size={14} aria-hidden />}
              disabled={!form.sections.some((s) => !editEmpty(s))}
              title="Save these sections as a reusable template for new pages"
              onClick={() => {
                setTemplateName(form.title ? `${form.title} layout` : "");
                setSaveTplOpen(true);
              }}
            >
              Save as template
            </Button>
            <Button variant="primary" busy={saving} disabled={!dirty} onClick={() => save()}>
              Save
            </Button>
          </>
        }
      />

      <div className="space-y-3">
        {fromMissing && (
          <Banner tone="warning" title="Nothing to duplicate">
            The page you tried to duplicate wasn&rsquo;t found — starting from a blank page instead.
          </Banner>
        )}
        {conflict && <ConflictBanner what="this page" busy={saving || conflictBusy} onTakeTheirs={takeTheirs} onOverwrite={() => save({ overwrite: true })} />}
        {problems && (
          <Banner tone="danger" title="Couldn't save">
            <ul className="list-inside list-disc space-y-0.5">
              {problems.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </Banner>
        )}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* ---- main column: title + sections ---- */}
          <div className="space-y-4">
            <Card>
              <Field label="Title" htmlFor="pe-title" required>
                <Input id="pe-title" value={form.title} onChange={(e) => changeTitle(e.target.value)} placeholder="Page title" />
              </Field>
            </Card>

            <Card>
              <CardHeader title="Sections" description="The page body, top to bottom. A section can't be saved empty, so remove any you don't need." />
              {form.sections.length === 0 ? (
                <EmptyState title="No sections yet" body="Add a text, rich HTML, image or FAQ section below." />
              ) : (
                <div className="space-y-3">
                  {form.sections.map((s, i) => (
                    <Card as="div" key={s.id} padded={false} className="p-3">
                      <div className="flex items-center gap-2">
                        <Badge tone="neutral">
                          {i + 1}. {SECTION_LABELS[s.kind] || s.kind}
                        </Badge>
                        {s.kind !== "image" && (
                          <Input
                            aria-label="Section heading"
                            placeholder="Heading (optional)"
                            value={s.heading}
                            onChange={(e) => patchSection(s.id, { heading: e.target.value })}
                          />
                        )}
                        <span className="ml-auto flex shrink-0 items-center gap-0.5">
                          <IconButton label="Move section up" icon={<ChevronUp size={14} aria-hidden />} disabled={i === 0} onClick={() => moveSection(s.id, -1)} />
                          <IconButton
                            label="Move section down"
                            icon={<ChevronDown size={14} aria-hidden />}
                            disabled={i === form.sections.length - 1}
                            onClick={() => moveSection(s.id, 1)}
                          />
                          <IconButton label="Duplicate section" icon={<Copy size={14} aria-hidden />} onClick={() => duplicateSection(s.id)} />
                          <IconButton
                            label="Remove section"
                            icon={<Trash2 size={14} aria-hidden />}
                            className="text-danger hover:bg-danger-bg hover:text-danger"
                            onClick={() => setRemoveId(s.id)}
                          />
                        </span>
                      </div>

                      {s.kind === "text" && (
                        <Textarea
                          aria-label="Section paragraphs"
                          className="mt-2 min-h-24"
                          placeholder="Paragraphs — separate with a blank line"
                          value={s.text}
                          onChange={(e) => patchSection(s.id, { text: e.target.value })}
                        />
                      )}
                      {s.kind === "rich" && (
                        <Textarea
                          mono
                          aria-label="Section HTML"
                          className="mt-2 min-h-24"
                          placeholder="<p>HTML — scripts and event handlers are stripped on save</p>"
                          value={s.html}
                          onChange={(e) => patchSection(s.id, { html: e.target.value })}
                        />
                      )}
                      {s.kind === "image" && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <div className="flex gap-2 sm:col-span-2">
                            <Input
                              aria-label="Image URL"
                              placeholder="/api/media/… or https://…"
                              value={s.src}
                              onChange={(e) => patchSection(s.id, { src: e.target.value })}
                            />
                            <Button size="sm" icon={<ImagePlus size={13} aria-hidden />} className="shrink-0" onClick={() => setPickerFor(s.id)}>
                              Choose from library
                            </Button>
                          </div>
                          <Input
                            aria-label="Alt text (required)"
                            placeholder="Alt text (required)"
                            invalid={Boolean(s.src.trim()) && !s.alt.trim()}
                            value={s.alt}
                            onChange={(e) => patchSection(s.id, { alt: e.target.value })}
                          />
                          <Input
                            aria-label="Caption (optional)"
                            placeholder="Caption (optional)"
                            value={s.caption}
                            onChange={(e) => patchSection(s.id, { caption: e.target.value })}
                          />
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
                                  onChange={(e) => patchSection(s.id, { items: s.items.map((y, k) => (k === j ? { ...y, q: e.target.value } : y)) })}
                                />
                                <IconButton
                                  label="Remove question"
                                  icon={<X size={14} aria-hidden />}
                                  disabled={s.items.length === 1}
                                  onClick={() => patchSection(s.id, { items: s.items.filter((_, k) => k !== j) })}
                                />
                              </div>
                              <Textarea
                                mono
                                aria-label="Answer HTML"
                                className="mt-2 min-h-16"
                                placeholder="<p>Answer — HTML, sanitized on save</p>"
                                value={it.a}
                                onChange={(e) => patchSection(s.id, { items: s.items.map((y, k) => (k === j ? { ...y, a: e.target.value } : y)) })}
                              />
                            </div>
                          ))}
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Plus size={13} aria-hidden />}
                            disabled={s.items.length >= 30}
                            onClick={() => patchSection(s.id, { items: [...s.items, { q: "", a: "" }] })}
                          >
                            Add question
                          </Button>
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-edge pt-3">
                <span className="mr-1 text-xs font-medium text-fg-muted">Add section:</span>
                {Object.entries(SECTION_LABELS).map(([kind, label]) => (
                  <Button key={kind} size="sm" variant="ghost" icon={<Plus size={13} aria-hidden />} onClick={() => addSection(kind)}>
                    {label}
                  </Button>
                ))}
              </div>
            </Card>
          </div>

          {/* ---- side column: settings ---- */}
          <Card className="lg:sticky lg:top-4">
            <CardHeader title="Settings" />
            <div className="space-y-4">
              {isNew && (
                <Field label="Start from a template" htmlFor="pe-template" hint="Prefills the title, sections and family — everything stays editable.">
                  <Select id="pe-template" value={templateId} onChange={(e) => requestTemplate(e.target.value)}>
                    {PAGE_TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                    {tenantTemplates.length > 0 && (
                      <optgroup label="Your templates">
                        {tenantTemplates.map((t) => (
                          <option key={t.id} value={`tpl:${t.id}`}>
                            {t.name} ({FAMILY_LABELS[t.family] || t.family})
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </Select>
                </Field>
              )}

              <Field
                label="Slug"
                htmlFor="pe-slug"
                required={isNew}
                error={slugError}
                hint={
                  isNew
                    ? `Auto-suggested from the title until you edit it. Serves at ${pageUrl({ slug: form.slug || "<slug>", family: form.family })}`
                    : "Slugs are permanent. Changing a journal URL? Save a new page and set “Redirect from old slug”."
                }
              >
                <Input id="pe-slug" mono value={form.slug} disabled={!isNew} invalid={Boolean(slugError)} placeholder="my-page" onChange={(e) => changeSlug(e.target.value)} />
              </Field>

              <Field label="Family" htmlFor="pe-family" hint={FAMILY_HINTS[form.family]}>
                <Select id="pe-family" value={form.family} onChange={(e) => changeFamily(e.target.value)}>
                  <option value="page">{FAMILY_LABELS.page} — content / policy</option>
                  <option value="campaign">{FAMILY_LABELS.campaign} landing</option>
                  <option value="journal">{FAMILY_LABELS.journal} post</option>
                </Select>
              </Field>

              <Field label="Meta description" htmlFor="pe-desc" hint="Used as the search/social description.">
                <Textarea id="pe-desc" className="min-h-16" value={form.description} onChange={(e) => patch({ description: e.target.value })} />
              </Field>

              {form.family === "page" && (
                <Field label="Effective date" htmlFor="pe-effective" hint="Optional — shown under the title on policy pages.">
                  <Input id="pe-effective" type="date" value={form.effective_at} onChange={(e) => patch({ effective_at: e.target.value })} />
                </Field>
              )}

              {form.family !== "page" && (
                <>
                  <Field
                    label={form.family === "journal" ? "Publish at" : "Visible from"}
                    htmlFor="pe-window-start"
                    hint="Your local time, stored as UTC — blank = immediately."
                  >
                    <Input id="pe-window-start" type="datetime-local" value={form.windowStart} onChange={(e) => patch({ windowStart: e.target.value })} />
                  </Field>
                  <Field label="Visible until" htmlFor="pe-window-end" hint="Your local time, stored as UTC — blank = no end.">
                    <Input id="pe-window-end" type="datetime-local" value={form.windowEnd} onChange={(e) => patch({ windowEnd: e.target.value })} />
                  </Field>
                </>
              )}

              {!isNew && form.family === "journal" && (
                <Field label="Redirect from old slug" htmlFor="pe-redirect" hint="Renamed this post? The old slug 301s here (optional).">
                  <Input id="pe-redirect" mono placeholder="old-slug" value={form.redirectFrom} onChange={(e) => patch({ redirectFrom: e.target.value })} />
                </Field>
              )}

              <div className="flex items-start justify-between gap-3 border-t border-edge pt-4">
                <div>
                  <p className="text-xs font-medium text-fg-muted">Visible</p>
                  <p className="mt-0.5 text-xs text-fg-subtle">Hidden pages 404 — navigation menus are managed separately in Navigation.</p>
                </div>
                <Switch checked={form.enabled} onChange={(v) => patch({ enabled: v })} label="Visible" />
              </div>
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={removeId != null}
        onClose={() => setRemoveId(null)}
        title="Remove section"
        tone="danger"
        confirmLabel="Remove section"
        body="Removes this section from the page. Nothing persists until you save."
        onConfirm={() => setForm((f) => ({ ...f, sections: f.sections.filter((s) => s.id !== removeId) }))}
      />

      <ConfirmDialog
        open={pendingTemplate != null}
        onClose={() => setPendingTemplate(null)}
        title="Replace current content?"
        confirmLabel="Apply template"
        body="Applying a template replaces the title, sections and settings you've entered so far."
        onConfirm={() => applyTemplate(pendingTemplate)}
      />

      {/* S54: save the current sections as a reusable tenant template */}
      <ConfirmDialog
        open={saveTplOpen}
        onClose={() => setSaveTplOpen(false)}
        title="Save as template"
        confirmLabel="Save template"
        body={
          <div className="space-y-2">
            <p>
              Saves the current sections as a reusable starting point for new {FAMILY_LABELS[form.family]?.toLowerCase() || "page"}s.
              New pages get an independent copy — editing the template later never changes existing pages.
            </p>
            <Field label="Template name" htmlFor="pe-tpl-name">
              <Input id="pe-tpl-name" value={templateName} onChange={(e) => setTemplateName(e.target.value)} autoFocus />
            </Field>
          </div>
        }
        onConfirm={async () => {
          const sections = sectionsPayload(form.sections);
          const r = await saveTemplateApi({ name: templateName, family: form.family, sections });
          if (!r.ok) throw new Error(r.error || (r.errors || []).join("; ") || "Couldn’t save the template");
          toast.success(`Template “${r.template.name}” saved — it’s in “Start from a template” on new pages`);
        }}
      />

      {/* S55: draft version history — read-only list; "Load this version" is an unsaved form replace */}
      <Dialog open={historyOpen} onClose={() => setHistoryOpen(false)} title="Version history" size="lg">
        <p>Every save keeps a version here (latest first). Loads into the editor — nothing changes until you save.</p>
        <div className="mt-3">
          {hist.status === "loading" ? (
            <SkeletonText lines={4} />
          ) : hist.status === "error" ? (
            <ErrorState title="Couldn't load the history" detail={hist.error} onRetry={loadHistory} />
          ) : hist.entries.length === 0 ? (
            <EmptyState
              icon={<History size={20} aria-hidden />}
              title="No saved versions yet"
              body="History starts with your next save."
            />
          ) : (
            <ul className="divide-y divide-edge rounded-ctl border border-edge">
              {hist.entries.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <span className="whitespace-nowrap text-sm text-fg">{new Date(e.created_at).toLocaleString()}</span>
                  <span className="font-mono text-[11px] text-fg-muted">{e.actor || "unknown"}</span>
                  <span className="text-xs text-fg-subtle">
                    {(e.value?.sections || []).length} {(e.value?.sections || []).length === 1 ? "section" : "sections"}
                  </span>
                  <Button
                    size="sm"
                    className="ml-auto"
                    disabled={!e.value}
                    title={e.value ? "Replace the editor contents with this version — unsaved until you save" : "This version couldn't be read"}
                    onClick={() => loadVersion(e)}
                  >
                    Load this version
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmBack}
        onClose={() => setConfirmBack(false)}
        title="Discard unsaved changes?"
        tone="danger"
        confirmLabel="Discard changes"
        body="Your edits since the last save will be lost."
        onConfirm={() => router.push("/admin/storefront/pages")}
      />

      <MediaPicker
        open={pickerFor != null}
        onClose={() => setPickerFor(null)}
        onSelect={({ url, alt }) => {
          // fills src + the library's alt; an alt already typed for this spot survives an alt-less pick
          patchSection(pickerFor, { src: url, ...(alt ? { alt } : {}) });
          setPickerFor(null);
        }}
      />
    </>
  );
}
