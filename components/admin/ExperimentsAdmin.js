"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/console/PageHeader";
import { Card, CardFooter, CardHeader } from "@/components/console/Card";
import { Button } from "@/components/console/Button";
import { Badge, StatusBadge } from "@/components/console/Badge";
import { Banner } from "@/components/console/Banner";
import { Table } from "@/components/console/Table";
import { Field, Input, Textarea } from "@/components/console/fields";
import { ConfirmDialog } from "@/components/console/Dialog";
import { EmptyState } from "@/components/console/bits";
import { useToast } from "@/components/console/Toast";

// Experiments console (S47 / MC18, redesigned S50). The UI repeats what the
// engine enforces: the plan freezes at start (now confirmed in a dialog),
// no winner talk while running or under-sampled or SRM-flagged, adoption =
// a DRAFT the Releases tab ships. S50 FIX: a successful adopt used to pipe
// its success note into the ERROR slot (setErr(r.note)) — it's a toast now.

const EMPTY = {
  slug: "",
  name: "",
  hypothesis: "",
  target_kind: "hero",
  min_sample: 200,
  variants: [
    { key: "control", weight: 50 },
    { key: "b", weight: 50, payload: { title: "", highlight: "", subtitle: "" } },
  ],
};

const RESULT_COLUMNS = [
  { key: "key", header: "Variant" },
  { key: "exposed", header: "Exposed", align: "right" },
  { key: "conversions", header: "Orders", align: "right" },
  { key: "rate", header: "Rate", align: "right" },
  { key: "sample", header: "Sample", align: "right" },
];

export default function ExperimentsAdmin({ initial }) {
  const toast = useToast();
  const [experiments, setExperiments] = useState(initial || []);
  const [form, setForm] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [pending, setPending] = useState(null); // one action key at a time
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(null); // {kind: start|complete|adopt, slug, variant?}

  async function refresh() {
    const data = await fetch("/api/admin/experiments").then((r) => r.json()).catch(() => null);
    if (data?.ok) setExperiments(data.experiments);
  }

  async function post(body) {
    const res = await fetch("/api/admin/experiments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Request failed");
    return json;
  }

  // non-dialog actions: busy on the button, failures land in the banner
  async function act(key, body) {
    setPending(key);
    setErr(null);
    try {
      await post(body);
      await refresh();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setPending(null);
    }
  }

  async function analyze(slug) {
    setPending(`results:${slug}`);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/experiments?analyze=${encodeURIComponent(slug)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "Couldn't load results");
      setAnalysis(data.analysis);
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setPending(null);
    }
  }

  async function saveDraft() {
    setPending("save");
    setErr(null);
    try {
      await post({ experiment: form });
      setForm(null);
      toast.success("Draft saved");
      await refresh();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setPending(null);
    }
  }

  const setVariant = (i, patch) => setForm({ ...form, variants: form.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) });

  const openForm = (f) => {
    setForm(f);
    setErr(null);
  };

  return (
    <>
      <PageHeader
        title="Experiments"
        description={
          <>
            A/B tests on the home hero. The plan (hypothesis, allocation, minimum sample) freezes when you start; winner talk is blocked while
            running, under-sampled, or when exposure ratios look broken. Adopting a variant saves a <strong>draft</strong> — it goes live through
            Releases, like any edit.
          </>
        }
        actions={
          <Button icon={<Plus size={14} aria-hidden />} onClick={() => openForm(EMPTY)}>
            New experiment
          </Button>
        }
      />

      {err && (
        <Banner tone="danger" className="mb-4">
          {err}
        </Banner>
      )}

      {experiments.length === 0 && !form && (
        <Card>
          <EmptyState
            title="No experiments yet"
            body="Draft one, start it, and the storefront splits hero exposure by the frozen allocation."
            action={<Button size="sm" onClick={() => openForm(EMPTY)}>New experiment</Button>}
          />
        </Card>
      )}

      <ul className="space-y-3">
        {experiments.map((e) => (
          <Card as="li" key={e.id} id={`exp-${e.slug}`}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status={e.status} />
              <span className="font-semibold text-fg">{e.name}</span>
              <span className="text-xs text-fg-subtle">
                {e.slug} · {e.target_kind} · {e.variants.map((v) => `${v.key} ${v.weight}%`).join(" / ")}
              </span>
              {e.adopted_variant && <Badge tone="info">adopted: {e.adopted_variant}</Badge>}
              <span className="ml-auto flex flex-wrap items-center gap-1.5">
                {e.status === "draft" && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        openForm({ slug: e.slug, name: e.name, hypothesis: e.hypothesis || "", target_kind: e.target_kind, min_sample: e.min_sample, variants: e.variants })
                      }
                    >
                      Edit
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => setConfirm({ kind: "start", slug: e.slug })}>
                      Start
                    </Button>
                  </>
                )}
                {e.status === "running" && (
                  <Button size="sm" busy={pending === `pause:${e.slug}`} onClick={() => act(`pause:${e.slug}`, { pause: { slug: e.slug } })}>
                    Pause
                  </Button>
                )}
                {e.status === "paused" && (
                  <Button size="sm" busy={pending === `resume:${e.slug}`} onClick={() => act(`resume:${e.slug}`, { start: { slug: e.slug } })}>
                    Resume
                  </Button>
                )}
                {["running", "paused"].includes(e.status) && (
                  <Button size="sm" onClick={() => setConfirm({ kind: "complete", slug: e.slug })}>
                    Complete
                  </Button>
                )}
                <Button size="sm" busy={pending === `results:${e.slug}`} onClick={() => analyze(e.slug)}>
                  Results
                </Button>
              </span>
            </div>
            {e.hypothesis && <p className="mt-1.5 text-xs text-fg-muted">Hypothesis: {e.hypothesis}</p>}

            {analysis?.slug === e.slug && (
              <div className="mt-3 rounded-ctl border border-edge bg-surface-sunken p-3">
                <Table
                  dense
                  columns={RESULT_COLUMNS}
                  rows={analysis.cells}
                  rowKey={(c) => c.key}
                  renderCell={(c, col) => {
                    switch (col.key) {
                      case "key":
                        return <span className="font-mono text-xs font-medium text-fg">{c.key}</span>;
                      case "rate":
                        return `${(c.rate * 100).toFixed(2)}%`;
                      case "sample":
                        return c.exposed >= analysis.min_sample ? (
                          <span className="font-medium text-success">met</span>
                        ) : (
                          <span className="text-warning">
                            {c.exposed}/{analysis.min_sample}
                          </span>
                        );
                      default:
                        return c[col.key];
                    }
                  }}
                />
                <p className="mt-2 text-xs text-fg-muted">
                  Exposure ratio check: {analysis.srm.ok ? `passing (χ²=${analysis.srm.chi2})` : `failing (χ²=${analysis.srm.chi2})`}
                </p>
                {analysis.interpretationBlocked.length > 0 ? (
                  <Banner tone="warning" title="No winner interpretation" className="mt-2">
                    <ul className="list-disc pl-4">
                      {analysis.interpretationBlocked.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </Banner>
                ) : (
                  analysis.verdict && (
                    <Banner tone={analysis.verdict.winner ? "success" : "info"} className="mt-2">
                      {analysis.verdict.note}
                    </Banner>
                  )
                )}
                {e.status === "completed" && !e.adopted_variant && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {analysis.cells.map((c) => (
                      <Button key={c.key} size="sm" onClick={() => setConfirm({ kind: "adopt", slug: e.slug, variant: c.key })}>
                        Adopt {c.key}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        ))}
      </ul>

      {form && (
        <Card className="mt-5">
          <CardHeader title="Experiment draft" description="Everything here is editable until you start — then the plan freezes." />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Slug" htmlFor="exp-slug" hint="e.g. hero-urgency">
              <Input id="exp-slug" mono value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
            </Field>
            <Field label="Name" htmlFor="exp-name">
              <Input id="exp-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Hypothesis" htmlFor="exp-hypothesis" hint="Required before start — the plan freezes with it" className="sm:col-span-2">
              <Textarea id="exp-hypothesis" value={form.hypothesis} onChange={(e) => setForm({ ...form, hypothesis: e.target.value })} />
            </Field>
            <Field label="Min sample per variant" htmlFor="exp-min-sample">
              <Input id="exp-min-sample" type="number" min="50" value={form.min_sample} onChange={(e) => setForm({ ...form, min_sample: Number(e.target.value) || 200 })} />
            </Field>
          </div>

          {form.variants.map((v, i) => (
            <div key={i} className="mt-3 rounded-ctl border border-edge bg-surface-sunken p-3">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Variant key" htmlFor={`exp-v${i}-key`} className="w-32">
                  <Input id={`exp-v${i}-key`} mono disabled={i === 0} value={v.key} onChange={(e) => setVariant(i, { key: e.target.value })} />
                </Field>
                <Field label="Weight %" htmlFor={`exp-v${i}-weight`} className="w-24">
                  <Input id={`exp-v${i}-weight`} type="number" min="1" value={v.weight} onChange={(e) => setVariant(i, { weight: Number(e.target.value) || 1 })} />
                </Field>
                {i === 0 ? (
                  <p className="pb-2.5 text-xs text-fg-subtle">serves the live hero unchanged</p>
                ) : (
                  form.variants.length > 2 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={13} aria-hidden />}
                      className="mb-0.5 text-danger"
                      onClick={() => setForm({ ...form, variants: form.variants.filter((_, j) => j !== i) })}
                    >
                      Remove
                    </Button>
                  )
                )}
              </div>
              {i > 0 && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <Field label="Hero title" htmlFor={`exp-v${i}-title`}>
                    <Input id={`exp-v${i}-title`} value={v.payload?.title || ""} onChange={(e) => setVariant(i, { payload: { ...v.payload, title: e.target.value } })} />
                  </Field>
                  <Field label="Highlight" htmlFor={`exp-v${i}-highlight`} hint="substring of the title">
                    <Input id={`exp-v${i}-highlight`} value={v.payload?.highlight || ""} onChange={(e) => setVariant(i, { payload: { ...v.payload, highlight: e.target.value } })} />
                  </Field>
                  <Field label="Subtitle" htmlFor={`exp-v${i}-subtitle`} className="sm:col-span-2">
                    <Input id={`exp-v${i}-subtitle`} value={v.payload?.subtitle || ""} onChange={(e) => setVariant(i, { payload: { ...v.payload, subtitle: e.target.value } })} />
                  </Field>
                </div>
              )}
            </div>
          ))}
          {form.variants.length < 6 && (
            <Button
              size="sm"
              icon={<Plus size={13} aria-hidden />}
              className="mt-3"
              onClick={() => setForm({ ...form, variants: [...form.variants, { key: `v${form.variants.length}`, weight: 10, payload: { title: "", highlight: "", subtitle: "" } }] })}
            >
              Add variant
            </Button>
          )}
          <CardFooter>
            <Button variant="primary" busy={pending === "save"} onClick={saveDraft}>
              Save draft
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setForm(null);
                setErr(null);
              }}
            >
              Cancel
            </Button>
          </CardFooter>
        </Card>
      )}

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        tone="primary"
        title={confirm?.kind === "start" ? "Start the experiment?" : confirm?.kind === "complete" ? "Complete the experiment?" : `Adopt "${confirm?.variant}"?`}
        confirmLabel={confirm?.kind === "start" ? "Start" : confirm?.kind === "complete" ? "Complete" : `Adopt ${confirm?.variant}`}
        body={
          confirm?.kind === "start"
            ? "The plan — hypothesis, allocation, minimum sample — freezes now."
            : confirm?.kind === "complete"
              ? "Completing stops serving the variant and finalizes the stats."
              : "Adopting a variant saves a draft — it goes live through Releases, like any edit."
        }
        onConfirm={async () => {
          if (confirm.kind === "adopt") {
            const r = await post({ adopt: { slug: confirm.slug, variant: confirm.variant } });
            toast.success(r.note); // S50 fix: this success note used to land in the error slot
          } else if (confirm.kind === "start") {
            await post({ start: { slug: confirm.slug } });
          } else {
            await post({ complete: { slug: confirm.slug } });
          }
          await refresh();
        }}
      />
    </>
  );
}
