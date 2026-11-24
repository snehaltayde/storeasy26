"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, CircleAlert, CircleCheck, Clock, RefreshCw, RotateCcw, Unplug } from "lucide-react";
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
  // the estimate covers products only (collections and search come after
  // and are usually quick), so it says so
  left: (words) => `${words} for products.`,
  showAll: (n) => `Show all ${fmt(n)}`,
  fewer: "Show fewer",
});

const fmt = (x) => Number(x || 0).toLocaleString("en-IN");
const timeOf = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : null;
};
// read so far: brought in plus skipped, so the bar can reach 100%
const readOf = (c) => Number(c?.done || 0) + Number(c?.skipped || 0);
const pctOf = (c) => (c && c.total > 0 ? Math.min(100, Math.round((readOf(c) / c.total) * 100)) : null);

// A notice inside the step. No live role: the headline is the step's one
// live region, and it changes with every state these notices belong to.
function Note({ tone, children, ...props }) {
  const Icon = tone === "success" ? CircleCheck : CircleAlert;
  return (
    <p className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-sm", tone === "danger" ? "bg-danger/10 text-danger" : tone === "warning" ? "bg-warning/10 text-warning-text" : "bg-info/10 text-info")} {...props}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

// The four stages, in order: a column on phones, a row from 640px up.
function Stages({ stage }) {
  return (
    <ol aria-label="Import stages" className="grid gap-x-3 gap-y-1.5 text-[0.8125rem] sm:grid-cols-4" data-import="stages">
      {SYNC_STAGES.map((s, i) => {
        const at = i + 1;
        const state = at < stage.index ? "done" : at === stage.index ? "current" : "todo";
        return (
          <li key={s.id} data-stage={s.id} data-stage-state={state} aria-current={state === "current" ? "step" : undefined} className={cn("flex min-w-0 items-start gap-1.5 leading-snug", state === "current" ? "font-medium text-foreground" : "text-muted-foreground")}>
            {state === "done" ? (
              <CircleCheck aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
            ) : (
              <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center pt-0.5">
                <span className={cn("block size-2 rounded-full", state === "current" ? "bg-primary" : "border border-muted-foreground/50")} />
              </span>
            )}
            <span className="min-w-0">
              {s.label}
              {state === "done" && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// The products that couldn't come in. The first few show; the rest are one
// "Show all" away, so a long list doesn't push the step's next action down.
const SKIPPED_SHOWN = 5;
function Skipped({ skipped }) {
  const [all, setAll] = useState(false);
  if (!skipped?.count) return null;
  const items = skipped.items || [];
  const folded = items.length > SKIPPED_SHOWN;
  return (
    <section className="space-y-2" data-import="skipped" aria-labelledby="import-skipped-title">
      <h3 id="import-skipped-title" className="flex items-start gap-2 text-sm font-medium text-foreground">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <span className="min-w-0">{SKIPPED_WORDS(skipped)}</span>
      </h3>
      {items.length > 0 && (
        <ul id="import-skipped-list" className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {items.map((it, i) => (
            <li key={i} hidden={folded && !all && i >= SKIPPED_SHOWN} className="space-y-0.5 px-3 py-2.5 text-[0.8125rem] leading-snug" data-skip-reason={it.reason}>
              <p className="font-medium text-foreground [overflow-wrap:anywhere]">{it.name}</p>
              <p className="text-muted-foreground">{it.why}</p>
              <p className="text-foreground">{it.todo}</p>
              {it.kept && <p className="text-xs text-muted-foreground">{KEPT_WORDS}</p>}
            </li>
          ))}
        </ul>
      )}
      {(folded || skipped.more > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {folded && (
            <Button variant="ghost" size="sm" className="-ml-2" aria-expanded={all} aria-controls="import-skipped-list" onClick={() => setAll((x) => !x)} data-import="skipped-toggle">
              <ChevronDown aria-hidden className={cn("motion-safe:transition-transform", all && "rotate-180")} />
              {all ? IMPORT_WORDS.fewer : IMPORT_WORDS.showAll(items.length)}
            </Button>
          )}
          {skipped.more > 0 && <p className="text-xs text-muted-foreground">{IMPORT_WORDS.more(skipped.more)}</p>}
        </div>
      )}
    </section>
  );
}

// One view, laid out. `gate` is the step's sync action ({ id, allowed,
// reason }) or null; `showProblem` false when the step header already shows
// the problem's words. Hierarchy: the headline (the one live region), then
// the count of total over the bar (where the eye lands), the time line, the
// four stages; a problem's one next action is the only filled button.
export function ImportStepBody({ view, gate = null, busy = false, error = null, lost = false, showProblem = true, onAct, onReconnect }) {
  if (!view) {
    return (
      <div className="space-y-3" data-import="loading" aria-busy="true">
        <Skeleton className="h-5 w-2/3" />
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
  // the filled button is the one obvious next step; while it retries by
  // itself, waiting is, so Try now stays quiet
  const filled = (i) => i === 0 && state !== "retrying";
  const big = { size: "lg", className: "h-10 px-4" };
  const retryAction = (label, primary) => (
    <Gated key="retry" action={gate} reasonId="import-reason" variant={primary ? "default" : "outline"} {...(primary ? big : {})} disabled={busy} aria-busy={busy || undefined} onClick={() => onAct?.({ retry: true })}>
      <RotateCcw aria-hidden />
      {label}
    </Gated>
  );

  return (
    <div className="space-y-5" data-import="body" data-import-state={state}>
      <div className="space-y-1">
        <p aria-live="polite" className="flex items-start gap-2 text-base leading-snug font-medium text-foreground" data-import="headline">
          {state === "complete" && <CircleCheck aria-hidden className="mt-0.5 size-[1.125rem] shrink-0 text-success" />}
          <span className="min-w-0">{view.headline}</span>
        </p>
        {(state === "none" || state === "complete") && view.detail && (
          <p className={cn("text-sm text-muted-foreground", state === "complete" && "pl-[1.625rem]")} data-import="detail">
            {view.detail}
            {state === "complete" && view.durationMs != null ? ` ${IMPORT_WORDS.took(view.durationMs)}` : ""}
          </p>
        )}
      </div>

      {stage && state !== "none" && state !== "complete" && (
        <div className="space-y-4" data-import="progress">
          <div className="space-y-2">
            <dl className="space-y-1 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <dt className="sr-only">Products</dt>
                <dd className={cn("tabular-nums", collecting ? "flex items-center gap-1.5 text-muted-foreground" : "font-medium text-foreground")} data-import="products">
                  {collecting && <CircleCheck aria-hidden className="size-3.5 shrink-0 text-success" />}
                  {collecting ? IMPORT_WORDS.allIn(view.products.done) : IMPORT_WORDS.products(view.products.total ? readOf(view.products) : view.products.done, view.products.total)}
                  {pct != null && stage.index === 1 ? ` (${pct}%)` : ""}
                </dd>
              </div>
              {collecting && (
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <dt className="sr-only">Collections</dt>
                  <dd className={cn("tabular-nums", stage.index === 2 ? "font-medium text-foreground" : "text-muted-foreground")} data-import="collections">
                    {IMPORT_WORDS.collections(stage.index === 2 && view.collections.total ? readOf(view.collections) : view.collections.done, stage.index === 2 ? view.collections.total : null)}
                    {pct != null && stage.index === 2 ? ` (${pct}%)` : ""}
                  </dd>
                </div>
              )}
            </dl>
            {live && (
              <Progress
                value={pct}
                aria-label={stage.index === 2 ? "Collections brought in" : stage.index === 1 ? "Products brought in" : stage.label}
                aria-valuetext={pct != null ? `${pct}%` : undefined}
              />
            )}
            {(view.elapsedMs != null || view.eta) && (
              <p className="text-xs text-muted-foreground tabular-nums" data-import="time">
                {view.elapsedMs != null ? `${IMPORT_WORDS.started(view.elapsedMs)}.` : ""}
                {view.eta ? ` ${IMPORT_WORDS.left(view.eta.words)}` : ""}
              </p>
            )}
          </div>
          <Stages stage={stage} />
          {view.big && (
            <p className="flex items-start gap-2 text-[0.8125rem] text-muted-foreground" data-import="big">
              <Clock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0">{SYNC_WORDS.big}</span>
            </p>
          )}
        </div>
      )}

      {problem && (
        <div className="space-y-3" data-import="problem" data-kind={problem.kind}>
          {showProblem && <Note tone={state === "retrying" || view.firstSync === false ? "warning" : "danger"}>{problem.words}</Note>}
          {state === "retrying" && view.retryAt && timeOf(view.retryAt) && <p className="text-xs text-muted-foreground" data-import="next-try">{IMPORT_WORDS.nextTry(timeOf(view.retryAt))}</p>}
          {state !== "retrying" && <p className="text-xs text-muted-foreground" data-import="kept">{view.firstSync === false ? SYNC_WORDS.keptRefresh : SYNC_WORDS.kept}</p>}
          <div className="flex flex-wrap items-start gap-2">
            {problem.next.map((n, i) =>
              n.id === "reconnect" ? (
                <Button key="reconnect" variant={filled(i) ? "default" : "outline"} {...(filled(i) ? big : {})} onClick={() => onReconnect?.()} data-import="reconnect">
                  <Unplug aria-hidden />
                  {n.label}
                </Button>
              ) : (
                retryAction(n.label, filled(i))
              ),
            )}
          </div>
        </div>
      )}

      {lost && live && <Note tone="info">{IMPORT_WORDS.lost}</Note>}
      {/* the answer to the founder's own click: said at once */}
      {error && <Note tone="danger" role="alert">{error}</Note>}

      {state === "complete" && <Skipped skipped={view.skipped} />}

      {(state === "none" || state === "complete") && gate && (gate.id === "start_sync" || !gate.allowed) && view.linked !== false && (
        <Gated action={gate} reasonId="import-reason" variant={state === "none" ? "default" : "outline"} {...(state === "none" ? big : {})} disabled={busy} aria-busy={busy || undefined} onClick={() => onAct?.({})}>
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
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
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
  const liveRef = useRef(live);
  liveRef.current = live;
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

  // hidden: the pending poll is cleared (the effect re-runs on `visible`)
  useEffect(() => {
    if (!live || !visible) return undefined;
    const timer = setTimeout(read, misses >= LOST_AFTER ? SLOW_POLL_MS : POLL_MS);
    return () => clearTimeout(timer);
  }, [live, visible, tick, misses]);

  useEffect(() => {
    const onVisibility = () => {
      const now = document.visibilityState === "visible";
      setVisible(now);
      if (now && liveRef.current) read();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

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
