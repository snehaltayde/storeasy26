"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { sendJson } from "@/components/admin/offers/ConfirmAction";

// Create or edit a DRAFT experiment in a sheet (Phase 2 line 9). The plan:
// name, hypothesis, target (the home page hero), variants with weights that
// add up to 100, the metric (orders per visitor) and the minimum sample per
// variant. lib/experiments.js validates it again; once started the plan is
// frozen, so the sheet only ever opens on a draft. Only writers
// (storefront.write) are given this sheet.
//   open, onOpenChange, experiment (a draft to edit, or null to create), onSaved(saved)
export const TARGETS = { hero: "Home page hero" };
export const METRICS = { conversion: "Orders per visitor" };
const blankVariant = (key) => ({ key, weight: 0, payload: { title: "", highlight: "", subtitle: "" } });
const NEW = { slug: "", name: "", hypothesis: "", target_kind: "hero", min_sample: 200, variants: [{ key: "control", weight: 50 }, { ...blankVariant("b"), weight: 50 }] };

export const slugFrom = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
// Native selects (the phone's own picker, no portal) drawn like Input.
const SELECT = "h-8 w-full rounded-md border border-input bg-muted px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";
export const weightTotal = (variants) => variants.reduce((s, v) => s + (Number(v.weight) || 0), 0);

// What still stops a save, in words (the server says the rest).
export function formProblems(f) {
  const out = [];
  if (!f.name.trim()) out.push("Give it a name.");
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(f.slug)) out.push("The short name may use only lowercase letters, digits and hyphens.");
  const total = weightTotal(f.variants);
  if (total !== 100) out.push(`The weights add up to ${total}%. Make them add up to 100%.`);
  if (f.variants.some((v) => !(Number(v.weight) > 0))) out.push("Every variant needs a weight above 0.");
  const keys = f.variants.map((v) => v.key.trim());
  if (keys.some((k) => !/^[a-z0-9-]{1,20}$/.test(k))) out.push("Each variant needs a short name: lowercase letters, digits or hyphens.");
  if (new Set(keys).size !== keys.length) out.push("Two variants have the same name.");
  if (f.variants.slice(1).some((v) => !v.payload?.title?.trim())) out.push("Every variant except the control needs a hero title.");
  if (!(Number.isInteger(Number(f.min_sample)) && Number(f.min_sample) >= 50)) out.push("The minimum sample is a whole number of at least 50.");
  return out;
}

function Field({ id, label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-[0.8125rem] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ExperimentForm({ open, onOpenChange, experiment = null, onSaved }) {
  const editing = !!experiment;
  const [f, setF] = useState(NEW);
  const [slugTouched, setSlugTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setF(editing ? { slug: experiment.slug, name: experiment.name, hypothesis: experiment.hypothesis || "", target_kind: experiment.target_kind, min_sample: experiment.min_sample, variants: experiment.variants } : NEW);
    setSlugTouched(editing);
    setError(null);
  }, [open, editing, experiment]);

  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const setVariant = (i, patch) => setF((x) => ({ ...x, variants: x.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) }));
  const setPayload = (i, patch) => setF((x) => ({ ...x, variants: x.variants.map((v, j) => (j === i ? { ...v, payload: { ...v.payload, ...patch } } : v)) }));
  const problems = formProblems(f);
  const total = weightTotal(f.variants);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = { ...f, min_sample: Number(f.min_sample), variants: f.variants.map((v, i) => ({ key: v.key.trim(), weight: Number(v.weight), ...(i ? { payload: v.payload } : {}) })) };
      const r = await sendJson("/api/admin/experiments", "POST", { experiment: body });
      onSaved?.(r.experiment);
      onOpenChange(false);
    } catch (e) {
      setError(e.body?.errors?.length ? e.body.errors.join(". ") : e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <SheetContent side="right" showCloseButton={false} className="overflow-y-auto p-4 data-[side=right]:w-full data-[side=right]:max-sm:rounded-none sm:p-6 data-[side=right]:sm:max-w-lg" data-experiment="form">
        <SheetHeader className="flex-row items-start justify-between gap-2 p-0">
          <div>
            <SheetTitle>{editing ? "Edit the plan" : "New experiment"}</SheetTitle>
            <SheetDescription>It stays a draft until someone with publishing rights starts it. Once started, the plan can&rsquo;t change.</SheetDescription>
          </div>
          <SheetClose asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close">
              <X aria-hidden />
            </Button>
          </SheetClose>
        </SheetHeader>

        <div className="space-y-4">
          <Field id="exp-name" label="Name">
            <Input id="exp-name" value={f.name} onChange={(e) => set({ name: e.target.value, ...(slugTouched ? {} : { slug: slugFrom(e.target.value) }) })} />
          </Field>
          <Field id="exp-slug" label="Short name" hint={editing ? "Fixed once saved." : "Used in the address of its page."}>
            <Input
              id="exp-slug"
              value={f.slug}
              disabled={editing}
              onChange={(e) => {
                setSlugTouched(true);
                set({ slug: e.target.value });
              }}
            />
          </Field>
          <Field id="exp-hypothesis" label="Hypothesis" hint="What you expect and why. Needed before it can start.">
            <Textarea id="exp-hypothesis" value={f.hypothesis} onChange={(e) => set({ hypothesis: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="exp-target" label="What it changes">
              <select id="exp-target" value={f.target_kind} onChange={(e) => set({ target_kind: e.target.value })} className={SELECT}>
                {Object.entries(TARGETS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="exp-metric" label="Measured by">
              <select id="exp-metric" value="conversion" onChange={() => {}} className={SELECT}>
                {Object.entries(METRICS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field id="exp-min" label="Minimum visitors per variant" hint="No winner is named until every variant reaches this.">
            <Input id="exp-min" type="number" min="50" step="1" className="max-w-40 font-mono tabular-nums" value={f.min_sample} onChange={(e) => set({ min_sample: e.target.value })} />
          </Field>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Variants</legend>
            <div className="space-y-1.5">
              <div aria-hidden className="flex h-2 overflow-hidden rounded-full bg-muted">
                {f.variants.map((v, i) => (
                  <span key={i} className={i % 2 ? "bg-primary/60" : "bg-primary"} style={{ width: `${Math.min(100, Math.max(0, Number(v.weight) || 0))}%` }} />
                ))}
              </div>
              <p role="status" className={`text-[0.8125rem] ${total === 100 ? "text-muted-foreground" : "font-medium text-destructive"}`} data-experiment="weight-total">
                Weights add up to <span className="font-mono tabular-nums">{total}%</span>
                {total === 100 ? "." : " (they must add up to 100%)."}
              </p>
            </div>
            {f.variants.map((v, i) => (
              <div key={i} className={`space-y-3 rounded-md border p-3 ${i === 0 ? "border-border bg-muted/40" : "border-border"}`} data-experiment-variant={i}>
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Field id={`exp-v${i}-key`} label={i === 0 ? "Control (your live hero, unchanged)" : "Variant name"}>
                      <Input id={`exp-v${i}-key`} value={v.key} disabled={i === 0} onChange={(e) => setVariant(i, { key: e.target.value })} />
                    </Field>
                  </div>
                  <div className="w-24">
                    <Field id={`exp-v${i}-weight`} label="Weight %">
                      <Input id={`exp-v${i}-weight`} type="number" min="1" max="100" className="text-right font-mono tabular-nums" value={v.weight} onChange={(e) => setVariant(i, { weight: e.target.value })} />
                    </Field>
                  </div>
                  {i > 1 && (
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove variant ${v.key}`} onClick={() => setF((x) => ({ ...x, variants: x.variants.filter((_, j) => j !== i) }))}>
                      <Trash2 aria-hidden />
                    </Button>
                  )}
                </div>
                {i > 0 && (
                  <>
                    <Field id={`exp-v${i}-title`} label="Hero title">
                      <Input id={`exp-v${i}-title`} value={v.payload?.title || ""} onChange={(e) => setPayload(i, { title: e.target.value })} />
                    </Field>
                    <Field id={`exp-v${i}-highlight`} label="Highlighted words" hint="Part of the title to colour in.">
                      <Input id={`exp-v${i}-highlight`} value={v.payload?.highlight || ""} onChange={(e) => setPayload(i, { highlight: e.target.value })} />
                    </Field>
                    <Field id={`exp-v${i}-subtitle`} label="Subtitle">
                      <Input id={`exp-v${i}-subtitle`} value={v.payload?.subtitle || ""} onChange={(e) => setPayload(i, { subtitle: e.target.value })} />
                    </Field>
                  </>
                )}
              </div>
            ))}
            {f.variants.length < 6 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setF((x) => ({ ...x, variants: [...x.variants, blankVariant(String.fromCharCode(97 + x.variants.length))] }))}>
                <Plus aria-hidden />
                Add a variant
              </Button>
            )}
          </fieldset>
        </div>

        <SheetFooter className="sticky bottom-0 -mx-4 mt-auto -mb-4 gap-2 border-t border-border bg-popover px-4 py-3 sm:-mx-6 sm:-mb-6 sm:px-6 sm:py-4">
          {problems.length > 0 && (
            <div className="text-[0.8125rem]" data-experiment="problems">
              <p className="font-medium text-foreground">Before you can save</p>
              <ul className="mt-1 max-h-20 list-disc space-y-0.5 overflow-y-auto pl-4 text-muted-foreground sm:max-h-32">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="button" disabled={problems.length > 0 || saving} onClick={save}>
            {saving ? "Saving…" : editing ? "Save the plan" : "Save draft"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
