"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/kit/page-header";
import { DataTable } from "@/components/kit/data-table";
import { RoleGate } from "@/components/kit/role-gate";
import { roleAllows } from "@/lib/platform/authz";
import { fmtDate } from "@/components/admin/media/media-words";
import { ConfirmAction, sendJson } from "@/components/admin/offers/ConfirmAction";
import { ExperimentForm, METRICS, TARGETS } from "./ExperimentForm";
import { ExperimentStatus, splitWords } from "./ExperimentsList";

// One experiment's page (Phase 2 line 9): the plan, the actions its status
// allows, and the analysis. Start and Resume put a variant in front of
// shoppers, so they need storefront.publish (D6): staff see them disabled
// with the reason; Edit, Pause, Complete and Keep need storefront.write;
// support sees none of them. The analysis is the only reader of results and
// says in words why a winner can't be named yet (no peeking, too few
// visitors, a broken split). Keeping a variant saves a DRAFT of the hero,
// with a link to the editor; it is never published from here.
//   experiment (lib/experiments.js listExperiments row), analysis (analyzeExperiment) | null, role
const API = "/api/admin/experiments";
const START_REASON = "Starting shows shoppers a variant, so it needs an owner or admin.";
const pct = (r) => `${(r * 100).toFixed(1)}%`;

// Why a winner can't be named yet, in words, from the analysis itself.
export function blockWords(analysis) {
  if (!analysis) return [];
  const out = [];
  if (analysis.status !== "completed") out.push({ kind: "peeking", text: "No peeking: results are read only once the experiment is completed, so an early lead can't fool you." });
  const short = analysis.cells.filter((c) => c.exposed < analysis.min_sample);
  if (short.length) out.push({ kind: "sample", text: `Too few visitors so far: ${short.map((c) => `${c.key} has ${c.exposed} of the ${analysis.min_sample} needed`).join("; ")}.` });
  if (analysis.srm && !analysis.srm.ok) out.push({ kind: "srm", text: "The split looks wrong: visitors didn't land in the variants in the planned shares, so the counting may be broken. Don't trust these numbers until that's fixed." });
  return out;
}

export function verdictWords(analysis) {
  if (!analysis?.verdict) return null;
  return analysis.verdict.winner
    ? `"${analysis.verdict.winner}" did better, and the difference is unlikely to be chance.`
    : "No clear difference between the top two variants. That is a real answer: keeping the control is fine.";
}

export function AnalysisPanel({ experiment, analysis, role, onChanged }) {
  const blocks = blockWords(analysis);
  const verdict = verdictWords(analysis);
  const completed = experiment.status === "completed";
  const [pick, setPick] = useState(analysis?.adopted_variant || analysis?.verdict?.winner || "control");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { tone, text, editor }

  async function adopt() {
    setBusy(true);
    setResult(null);
    try {
      const r = await sendJson(API, "POST", { adopt: { slug: experiment.slug, variant: pick } });
      setResult({ tone: "ok", text: r.draft ? `"${pick}" is saved in the home page draft. Publish it from the editor to take it live.` : "The control is kept: your live hero already is the control, so there is nothing to draft.", editor: r.draft ? "/admin/editor?doc=doc_home" : null });
      onChanged?.();
    } catch (e) {
      setResult({ tone: "error", text: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-experiment="analysis">
      <CardHeader>
        <CardTitle>Results</CardTitle>
        <CardDescription>{METRICS[experiment.primary_metric] || "Orders per visitor"}, by variant.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!analysis ? (
          <p className="text-sm text-muted-foreground">Couldn&rsquo;t read the results just now. Reload the page to try again.</p>
        ) : (
          <>
            <DataTable
              label="Results by variant"
              rows={analysis.cells}
              rowKey={(c) => c.key}
              columns={[
                { key: "key", header: "Variant" },
                { key: "weight", header: "Share", align: "right", cell: (c) => <span className="font-mono tabular-nums">{c.weight}%</span> },
                { key: "exposed", header: "Visitors", align: "right", cell: (c) => <span className="font-mono tabular-nums">{c.exposed}</span> },
                { key: "conversions", header: "Orders", align: "right", cell: (c) => <span className="font-mono tabular-nums">{c.conversions}</span> },
                { key: "rate", header: "Rate", align: "right", cell: (c) => <span className="font-mono tabular-nums">{completed ? pct(c.rate) : "Hidden"}</span> },
              ]}
            />
            {blocks.length > 0 && (
              <ul className="space-y-1.5 text-sm" data-experiment="blocks">
                {blocks.map((b) => (
                  <li key={b.kind} data-block={b.kind} className="rounded-md border border-border bg-muted/50 px-3 py-2 text-muted-foreground">
                    {b.text}
                  </li>
                ))}
              </ul>
            )}
            {verdict && (
              <p className="text-sm font-medium text-foreground" data-experiment="verdict">
                {verdict}
              </p>
            )}
            {completed && analysis.adopted_variant && (
              <p className="text-sm text-muted-foreground">
                Kept: <span className="font-medium text-foreground">{analysis.adopted_variant}</span>
              </p>
            )}
            {completed && roleAllows(role, "storefront.write") && (
              <div className="flex flex-wrap items-end gap-2" data-experiment="adopt">
                <div className="space-y-1.5">
                  <label htmlFor="exp-adopt" className="text-sm font-medium">
                    Variant to keep
                  </label>
                  <select id="exp-adopt" value={pick} onChange={(e) => setPick(e.target.value)} className="h-8 rounded-md border border-input bg-background px-2 text-sm">
                    {analysis.cells.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.key}
                      </option>
                    ))}
                  </select>
                </div>
                <RoleGate role={role} action="storefront.write" mode="hide">
                  <Button type="button" disabled={busy} onClick={adopt}>
                    {busy ? "Saving…" : "Keep it as a draft"}
                  </Button>
                </RoleGate>
              </div>
            )}
            {result && (
              <div role={result.tone === "error" ? "alert" : "status"} className={`flex flex-wrap items-center gap-2 text-sm ${result.tone === "error" ? "text-destructive" : "text-foreground"}`}>
                <span>{result.text}</span>
                {result.editor && (
                  <Link href={result.editor} data-read-control className="font-medium text-primary underline-offset-4 hover:underline">
                    Open in editor
                  </Link>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function ExperimentDetail({ experiment, analysis, role }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(null); // "start" | "resume" | "complete"
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const canWrite = roleAllows(role, "storefront.write");
  const { status } = experiment;

  async function post(body) {
    setError(null);
    await sendJson(API, "POST", body);
    router.refresh();
  }
  async function pause() {
    setBusy(true);
    try {
      await post({ pause: { slug: experiment.slug } });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const startButton = (label, kind) => (
    <RoleGate role={role} action="storefront.publish" reason={START_REASON}>
      <Button type="button" onClick={() => setConfirm(kind)} data-experiment-action={kind}>
        {label}
      </Button>
    </RoleGate>
  );

  const actions = canWrite ? (
    <>
      {status === "draft" && (
        <RoleGate role={role} action="storefront.write" mode="hide">
          <Button type="button" variant="outline" onClick={() => setEditing(true)}>
            Edit the plan
          </Button>
        </RoleGate>
      )}
      {status === "draft" && startButton("Start", "start")}
      {status === "paused" && startButton("Resume", "resume")}
      {status === "running" && (
        <RoleGate role={role} action="storefront.write" mode="hide">
          <Button type="button" variant="outline" disabled={busy} onClick={pause}>
            Pause
          </Button>
        </RoleGate>
      )}
      {(status === "running" || status === "paused") && (
        <RoleGate role={role} action="storefront.write" mode="hide">
          <Button type="button" variant="outline" onClick={() => setConfirm("complete")}>
            Complete
          </Button>
        </RoleGate>
      )}
    </>
  ) : null;

  const CONFIRM = {
    start: { title: `Start "${experiment.name}"?`, body: "Visitors start seeing the variants in the planned shares. The plan freezes now and can't be edited.", label: "Start experiment", body2: { start: { slug: experiment.slug } } },
    resume: { title: `Resume "${experiment.name}"?`, body: "Visitors see the variants again, in the same shares.", label: "Resume", body2: { start: { slug: experiment.slug } } },
    complete: { title: `Complete "${experiment.name}"?`, body: "Visitors stop seeing the variants and the results are read. A completed experiment can't restart.", label: "Complete experiment", body2: { complete: { slug: experiment.slug } } },
  };
  const c = confirm ? CONFIRM[confirm] : null;

  return (
    <>
      <PageHeader breadcrumb={[{ label: "Experiments", href: "/admin/experiments" }, { label: experiment.name }]} title={experiment.name} description={experiment.hypothesis || "No hypothesis yet: it is needed before the experiment can start."} actions={actions} />
      {!canWrite && <p className="mb-4 text-[0.8125rem] text-muted-foreground">You have read-only access to experiments.</p>}
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
        <Card data-experiment="plan">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              The plan <ExperimentStatus status={status} />
            </CardTitle>
            {status !== "draft" && <CardDescription>Frozen when it started.</CardDescription>}
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Changes</dt>
              <dd>{TARGETS[experiment.target_kind] || experiment.target_kind}</dd>
              <dt className="text-muted-foreground">Measured by</dt>
              <dd>{METRICS[experiment.primary_metric] || "Orders per visitor"}</dd>
              <dt className="text-muted-foreground">Split</dt>
              <dd className="font-mono text-[0.8125rem] tabular-nums">{splitWords(experiment.variants)}</dd>
              <dt className="text-muted-foreground">Minimum</dt>
              <dd>{experiment.min_sample} visitors per variant</dd>
              <dt className="text-muted-foreground">Started</dt>
              <dd>{experiment.started_at ? fmtDate(experiment.started_at) : "Not yet"}</dd>
              {experiment.ended_at && (
                <>
                  <dt className="text-muted-foreground">Completed</dt>
                  <dd>{fmtDate(experiment.ended_at)}</dd>
                </>
              )}
            </dl>
            <ul className="mt-3 space-y-1.5 text-[0.8125rem]">
              {experiment.variants.slice(1).map((v) => (
                <li key={v.key} className="rounded-md border border-border px-2.5 py-1.5">
                  <span className="font-medium">{v.key}:</span> <span className="text-muted-foreground">{v.payload?.title || "(no title)"}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <AnalysisPanel experiment={experiment} analysis={analysis} role={role} onChanged={() => router.refresh()} />
      </div>
      {canWrite && status === "draft" && <ExperimentForm open={editing} onOpenChange={setEditing} experiment={experiment} onSaved={() => router.refresh()} />}
      {canWrite && (
        <ConfirmAction open={!!c} onOpenChange={(v) => !v && setConfirm(null)} title={c?.title} body={c?.body} confirmLabel={c?.label || ""} destructive={confirm === "complete"} onConfirm={() => post(c.body2)} />
      )}
    </>
  );
}
