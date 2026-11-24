"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, RefreshCw, RotateCcw, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/components/ui/utils";
import { readSync, requestSync } from "@/components/admin/SyncProgress";
import { SYNC_STAGES, SYNC_WORDS, KEPT_WORDS, SKIPPED_WORDS, durationWords } from "@/lib/admin/sync-view";
import { Gated } from "./StepPanels";

// Onboarding step 2, bringing products in from Shopify (Phase 1 line 5).
// The view comes from lib/admin/sync-view.js (server side, the same words
// everywhere); this file only lays it out and keeps it live:
//   ImportStepBody  pure render of one view (the suite renders every state)
//   ImportStep      polls GET /api/admin/sync every 3 s while the import runs
//                   or retries and the tab is visible; reads once on becoming
//                   visible; after 3 failed reads says "Lost touch, still
//                   trying" and backs off to 15 s; calls onChange() when the
//                   import changes state. "Reconnect Shopify" selects step 1.

export const POLL_MS = 3000;
export const SLOW_POLL_MS = 15_000;
export const LOST_AFTER = 3;
const LIVE = new Set(["running", "retrying"]);

export const IMPORT_WORDS = Object.freeze({
  lost: "Lost touch, still trying.",
  start: "Bring in products",
  refresh: "Refresh from Shopify",
  more: (n) => `and ${Number(n).toLocaleString("en-IN")} more`,
  allIn: (n) => (n === 1 ? "1 product, all in" : `${fmt(n)} products, all in`),
  products: (done, total) => (total ? `${fmt(done)} of ${fmt(total)} products` : `${fmt(done)} ${done === 1 ? "product" : "products"} so far`),
  collections: (done, total) => (total ? `${fmt(done)} of ${fmt(total)} collections` : `${fmt(done)} ${done === 1 ? "collection" : "collections"} so far`),
  started: (ms) => (ms < 90_000 ? "Started just now" : `Started ${durationWords(ms)} ago`),
  took: (ms) => `Took ${durationWords(ms)}.`,
  nextTry: (time) => `Next try at about ${time}.`,
});

const fmt = (x) => Number(x || 0).toLocaleString("en-IN");
const timeOf = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : null;
};
const pctOf = (c) => (c && c.total > 0 ? Math.min(100, Math.round((c.done / c.total) * 100)) : null);

function Note({ tone, children, ...props }) {
  const Icon = tone === "success" ? CircleCheck : CircleAlert;
  return (
    <p className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-sm", tone === "danger" ? "bg-danger/10 text-danger" : tone === "warning" ? "bg-warning/10 text-warning-text" : "bg-info/10 text-info")} {...props}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function Stages({ stage }) {
  return (
    <ol className="grid gap-1 text-[0.8125rem] sm:grid-cols-4 sm:gap-2" data-import="stages">
      {SYNC_STAGES.map((s, i) => {
        const at = i + 1;
        const state = at < stage.index ? "done" : at === stage.index ? "current" : "todo";
        return (
          <li key={s.id} data-stage={s.id} data-stage-state={state} aria-current={state === "current" ? "step" : undefined} className={cn("flex items-center gap-1.5", state === "current" ? "font-medium text-foreground" : "text-muted-foreground")}>
            {state === "done" ? <CircleCheck aria-hidden className="size-3.5 shrink-0 text-success" /> : <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", state === "current" ? "bg-primary" : "bg-border")} />}
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}

function Skipped({ skipped }) {
  if (!skipped?.count) return null;
  return (
    <section className="space-y-2" data-import="skipped" aria-label={SKIPPED_WORDS(skipped)}>
      <p className="text-sm font-medium text-foreground">{SKIPPED_WORDS(skipped)}</p>
      {skipped.items.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {skipped.items.map((it, i) => (
            <li key={i} className="space-y-0.5 px-3 py-2 text-[0.8125rem]" data-skip-reason={it.reason}>
              <p className="font-medium text-foreground [overflow-wrap:anywhere]">{it.name}</p>
              <p className="text-muted-foreground">
                {it.why} {it.todo}
                {it.kept ? ` ${KEPT_WORDS}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
      {skipped.more > 0 && <p className="text-xs text-muted-foreground">{IMPORT_WORDS.more(skipped.more)}</p>}
    </section>
  );
}

// One view, laid out. `gate` is the step's sync action ({ id, allowed,
// reason }) or null; `showProblem` false when the step header already shows
// the problem's words.
export function ImportStepBody({ view, gate = null, busy = false, error = null, lost = false, showProblem = true, onAct, onReconnect }) {
  if (!view) {
    return (
      <div className="space-y-3" data-import="loading" aria-busy="true">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-1.5 w-full" />
        <Skeleton className="h-4 w-1/3" />
      </div>
    );
  }
  const { state } = view;
  const live = LIVE.has(state);
  const problem = view.problem;
  const stage = view.stage;
  const collecting = stage && stage.index >= 2;
  const bar = live && stage ? (stage.index === 1 ? view.products : stage.index === 2 ? view.collections : null) : null;
  const pct = bar ? pctOf(bar) : null;
  const retryAction = (label, primary) => (
    <Gated key="retry" action={gate} reasonId="import-reason" variant={primary ? "default" : "outline"} disabled={busy} aria-busy={busy || undefined} onClick={() => onAct?.({ retry: true })}>
      <RotateCcw aria-hidden />
      {label}
    </Gated>
  );

  return (
    <div className="space-y-4" data-import="body" data-import-state={state}>
      <div className="space-y-1">
        <p aria-live="polite" className="text-base font-medium text-foreground" data-import="headline">
          {view.headline}
        </p>
        {(state === "none" || state === "complete") && view.detail && (
          <p className="text-sm text-muted-foreground" data-import="detail">
            {view.detail}
            {state === "complete" && view.durationMs != null ? ` ${IMPORT_WORDS.took(view.durationMs)}` : ""}
          </p>
        )}
      </div>

      {stage && state !== "none" && state !== "complete" && (
        <div className="space-y-3" data-import="progress">
          <Stages stage={stage} />
          {live && (
            <Progress
              value={pct}
              aria-label={stage.index === 2 ? "Collections brought in" : stage.index === 1 ? "Products brought in" : stage.label}
              aria-valuetext={pct != null ? `${pct}%` : undefined}
            />
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.8125rem]">
            <dt className="text-muted-foreground">Products</dt>
            <dd className="tabular-nums text-foreground" data-import="products">
              {collecting ? IMPORT_WORDS.allIn(view.products.done) : IMPORT_WORDS.products(view.products.done, view.products.total)}
              {pct != null && stage.index === 1 ? ` (${pct}%)` : ""}
            </dd>
            {collecting && (
              <>
                <dt className="text-muted-foreground">Collections</dt>
                <dd className="tabular-nums text-foreground" data-import="collections">
                  {IMPORT_WORDS.collections(view.collections.done, stage.index === 2 ? view.collections.total : null)}
                  {pct != null && stage.index === 2 ? ` (${pct}%)` : ""}
                </dd>
              </>
            )}
          </dl>
          {(view.elapsedMs != null || view.eta) && (
            <p className="text-xs text-muted-foreground" data-import="time">
              {view.elapsedMs != null ? `${IMPORT_WORDS.started(view.elapsedMs)}.` : ""}
              {view.eta ? ` ${view.eta.words}.` : ""}
            </p>
          )}
          {view.big && <p className="text-xs text-muted-foreground" data-import="big">{SYNC_WORDS.big}</p>}
        </div>
      )}

      {problem && (
        <div className="space-y-3" data-import="problem" data-kind={problem.kind}>
          {showProblem && (
            <Note tone={state === "retrying" || view.firstSync === false ? "warning" : "danger"} role={state === "failed" ? "alert" : undefined}>
              {problem.words}
            </Note>
          )}
          {state === "retrying" && view.retryAt && timeOf(view.retryAt) && <p className="text-xs text-muted-foreground" data-import="next-try">{IMPORT_WORDS.nextTry(timeOf(view.retryAt))}</p>}
          {state !== "retrying" && <p className="text-xs text-muted-foreground" data-import="kept">{view.firstSync === false ? SYNC_WORDS.keptRefresh : SYNC_WORDS.kept}</p>}
          <div className="flex flex-wrap items-start gap-2">
            {problem.next.map((n, i) =>
              n.id === "reconnect" ? (
                <Button key="reconnect" variant={i === 0 ? "default" : "outline"} onClick={() => onReconnect?.()} data-import="reconnect">
                  <Unplug aria-hidden />
                  {n.label}
                </Button>
              ) : (
                retryAction(n.label, i === 0)
              ),
            )}
          </div>
        </div>
      )}

      {lost && live && <Note tone="info" role="status">{IMPORT_WORDS.lost}</Note>}
      {error && <Note tone="danger" role="alert">{error}</Note>}

      {state === "complete" && <Skipped skipped={view.skipped} />}

      {(state === "none" || state === "complete") && gate && (gate.id === "start_sync" || !gate.allowed) && view.linked !== false && (
        <Gated action={gate} reasonId="import-reason" variant={state === "none" ? "default" : "outline"} disabled={busy} aria-busy={busy || undefined} onClick={() => onAct?.({})}>
          <RefreshCw aria-hidden />
          {state === "none" ? IMPORT_WORDS.start : IMPORT_WORDS.refresh}
        </Gated>
      )}
    </div>
  );
}

// The live step: polling, visibility, backoff, the founder's actions.
export default function ImportStep({ step, onChange, onChoose }) {
  const [view, setView] = useState(step.facts?.sync || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [misses, setMisses] = useState(0);
  const [tick, setTick] = useState(0);
  const was = useRef(view?.state);

  // a fresh read of the steps brings a fresh view
  const fresh = JSON.stringify(step.facts?.sync || null);
  useEffect(() => {
    if (step.facts?.sync) setView(step.facts.sync);
  }, [fresh]);

  // the import changed state (running → retrying, finished, failed …): the
  // page re-reads its steps, so the step's actions (Try now) match the view
  useEffect(() => {
    if (!view || view.state === was.current) return;
    const before = was.current;
    was.current = view.state;
    if (before) onChange?.();
  }, [view?.state]);

  const live = Boolean(view && LIVE.has(view.state));
  async function read() {
    const next = await readSync().catch(() => null);
    if (next) {
      setMisses(0);
      setView(next);
    } else setMisses((m) => m + 1);
    setTick((x) => x + 1);
  }

  // no view yet (the steps couldn't read it): one read
  useEffect(() => {
    if (!view && step.state !== "blocked") read();
  }, []);

  useEffect(() => {
    if (!live) return undefined;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return undefined;
    const timer = setTimeout(read, misses >= LOST_AFTER ? SLOW_POLL_MS : POLL_MS);
    return () => clearTimeout(timer);
  }, [live, tick, misses]);

  useEffect(() => {
    if (!live) return undefined;
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [live]);

  async function act(body) {
    setBusy(true);
    setError(null);
    const res = await requestSync(body);
    if (res.ok && res.sync) {
      setMisses(0);
      setView(res.sync);
    } else if (!res.ok) setError(res.error);
    setBusy(false);
  }

  if (step.state === "blocked") return null;
  const gate = step.actions?.find((a) => a.id === "retry_sync") || step.actions?.find((a) => a.id === "start_sync") || null;
  return (
    <div data-onboarding="sync">
      <ImportStepBody
        view={view}
        gate={gate}
        busy={busy}
        error={error}
        lost={misses >= LOST_AFTER}
        showProblem={!(step.problem && view?.problem && step.problem === view.problem.words)}
        onAct={act}
        onReconnect={() => onChoose?.("connect", { focus: true })}
      />
    </div>
  );
}
