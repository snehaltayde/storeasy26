"use client";

// Phase 3 line 6: the Case studies tab (was CaseStudiesPanel), for the
// marketing site's /customers. Create and edit save a draft (an edit takes a
// published study off the site until it is published again); Publish runs the
// server's gate (documented consent and a measurement record); Archive takes a
// published study off /customers and keeps it as a draft; Delete removes it.
import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { ConfirmDialog, LoadError, Notice, opsGet, opsPost, when } from "./opsShared";

const FIELDS = [
  ["title", "Title"],
  ["tenant_id", "Store (its id)"],
  ["consent_ref", "Consent (who approved, when, how)"],
  ["period", "Measurement period"],
  ["baseline", "Baseline"],
  ["method", "Method"],
  ["limitations", "Limitations"],
  ["confounders", "Other changes in the period (or 'none known')"],
  ["quote", "Quote (with usage rights)"],
  ["quote_by", "Quote by"],
];
const EMPTY_RESULT = { metric: "", before: "", after: "" };
const EMPTY = { slug: "", title: "", tenant_id: "", consent_ref: "", period: "", baseline: "", method: "", limitations: "", confounders: "", results: [EMPTY_RESULT], quote: "", quote_by: "", body: "" };

function Editor({ initial, isNew, onSaved, onCancel }) {
  const [cs, setCs] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setCs((c) => ({ ...c, [k]: v }));
  const setResult = (i, k, v) => setCs((c) => ({ ...c, results: c.results.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const results = cs.results.filter((r) => r.metric || r.before || r.after);
      const j = await opsPost("case-studies", { case_study: { ...cs, results } });
      onSaved(j.caseStudy, initial.published);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-ops-case-editor>
      <CardHeader>
        <CardTitle>{isNew ? "New case study" : `Edit “${initial.title}”`}</CardTitle>
        <CardDescription>Saving keeps it as a draft.{initial.published ? " It comes off /customers until you publish it again." : ""}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cs-slug">Address (/customers/…)</Label>
            <Input id="cs-slug" value={cs.slug} disabled={!isNew} onChange={(e) => set("slug", e.target.value)} placeholder="lowercase-with-hyphens" required />
          </div>
          {FIELDS.map(([k, label]) => (
            <div key={k} className="space-y-1.5">
              <Label htmlFor={`cs-${k}`}>{label}</Label>
              <Input id={`cs-${k}`} value={cs[k] || ""} onChange={(e) => set(k, e.target.value)} required={k === "title"} />
            </div>
          ))}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="cs-body">Story</Label>
            <Textarea id="cs-body" rows={5} value={cs.body || ""} onChange={(e) => set("body", e.target.value)} />
          </div>
          <fieldset className="space-y-1.5 sm:col-span-2">
            <legend className="text-sm font-medium">Measured results (before and after)</legend>
            {cs.results.map((r, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <Input aria-label={`Result ${i + 1}: what was measured`} placeholder="What was measured" className="min-w-40 flex-1" value={r.metric} onChange={(e) => setResult(i, "metric", e.target.value)} />
                <Input aria-label={`Result ${i + 1}: before`} placeholder="Before" className="w-28" value={r.before} onChange={(e) => setResult(i, "before", e.target.value)} />
                <Input aria-label={`Result ${i + 1}: after`} placeholder="After" className="w-28" value={r.after} onChange={(e) => setResult(i, "after", e.target.value)} />
              </div>
            ))}
            <Button type="button" size="sm" variant="outline" disabled={cs.results.length >= 10} onClick={() => setCs((c) => ({ ...c, results: [...c.results, EMPTY_RESULT] }))}>
              <Plus aria-hidden /> Add a result
            </Button>
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              {error}
            </p>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save draft"}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function CaseStudies() {
  const [state, setState] = useState({ loading: true, error: null, list: null });
  const [editing, setEditing] = useState(null); // { cs, isNew }
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ loading: false, error: null, list: (await opsGet("case-studies")).caseStudies });
    } catch (e) {
      setState((s) => ({ loading: false, error: String(e?.message || e), list: s.list }));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function setPublished(c, published) {
    setBusy(c.slug);
    setNotice(null);
    try {
      await opsPost("case-studies", { publish_case: { slug: c.slug, published } });
      setNotice({ tone: "success", text: published ? `“${c.title}” is live on /customers.` : `“${c.title}” is archived: off /customers, kept as a draft.` });
    } catch (e) {
      const blocks = e.body?.blocks;
      setNotice({ tone: "error", text: blocks?.length ? `“${c.title}” can't be published yet: ${blocks.join("; ")}.` : String(e?.message || e) });
    } finally {
      setBusy(null);
      load();
    }
  }

  const columns = [
    { key: "title", header: "Case study" },
    { key: "slug", header: "Address", cell: (c) => <span className="font-mono text-xs">/customers/{c.slug}</span> },
    {
      key: "published",
      header: "State",
      cell: (c) =>
        c.published ? (
          <Badge variant="success">Published</Badge>
        ) : c.publishBlocks?.length ? (
          <Badge variant="warning" title={c.publishBlocks.join("; ")}>
            Draft, not ready
          </Badge>
        ) : (
          <Badge variant="muted">Draft</Badge>
        ),
    },
    { key: "updated_at", header: "Updated", cell: (c) => when(c.updated_at) },
  ];

  return (
    <section aria-labelledby="ops-cases-title" className="space-y-4" data-ops-tab="case-studies">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="ops-cases-title" className="text-base font-semibold">
            Case studies
          </h2>
          <p className="text-sm text-muted-foreground">For /customers. A study publishes only with the merchant&apos;s documented consent and a measurement record.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={state.loading} onClick={load}>
            <RefreshCw aria-hidden /> Refresh
          </Button>
          <Button size="sm" disabled={!!editing} onClick={() => setEditing({ cs: EMPTY, isNew: true })}>
            <Plus aria-hidden /> New case study
          </Button>
        </div>
      </div>

      <Notice notice={notice} onClose={() => setNotice(null)} />
      {state.error && <LoadError what="case studies" error={state.error} onRetry={load} />}

      {editing && (
        <Editor
          key={editing.cs.slug || "new"}
          initial={editing.cs}
          isNew={editing.isNew}
          onCancel={() => setEditing(null)}
          onSaved={(saved, wasPublished) => {
            setEditing(null);
            setNotice({ tone: "success", text: wasPublished ? `Draft saved. “${saved.title}” is off /customers until you publish it again.` : `Draft saved: “${saved.title}”.` });
            load();
          }}
        />
      )}

      {(state.list || state.loading) && (
        <DataTable
          label="Case studies"
          columns={columns}
          rows={state.list || []}
          rowKey={(c) => c.slug}
          loading={!state.list && state.loading}
          rowActions={(c) => (
            <div className="flex justify-end gap-1">
              <Button size="xs" variant="outline" disabled={busy != null || !!editing} onClick={() => setEditing({ cs: { ...EMPTY, ...c, results: c.results?.length ? c.results : [EMPTY_RESULT] }, isNew: false })} aria-label={`Edit ${c.title}`}>
                Edit
              </Button>
              {c.published ? (
                <Button size="xs" variant="outline" disabled={busy != null} onClick={() => setPublished(c, false)} aria-label={`Archive ${c.title}`}>
                  Archive
                </Button>
              ) : (
                <Button size="xs" disabled={busy != null} onClick={() => setPublished(c, true)} aria-label={`Publish ${c.title}`}>
                  Publish
                </Button>
              )}
              <Button size="xs" variant="ghost" disabled={busy != null} onClick={() => setDeleting(c)} aria-label={`Delete ${c.title}`}>
                Delete
              </Button>
            </div>
          )}
          empty={<EmptyState title="No case studies yet." description="Write the first one as a draft; it publishes once consent and the measurements are in." />}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.title}”?`}
        description="This removes the study and its measurement record, and takes a published page down. It can't be undone. To only take it off the site, archive it instead."
        confirmLabel="Delete case study"
        onConfirm={async () => {
          const c = deleting;
          await opsPost("case-studies", { delete_case: { slug: c.slug } });
          setNotice({ tone: "success", text: `Deleted “${c.title}”.` });
          load();
        }}
      />
    </section>
  );
}
