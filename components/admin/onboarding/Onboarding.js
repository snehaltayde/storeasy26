"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlert, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import StepList, { STATE_WORDS } from "./StepList";
import { BrandPanel, ConnectPanel, ImportPanel, OpenPanel, ONBOARDING_URL } from "./StepPanels";

// The onboarding page's steps (Phase 1 line 3, docs/UI.md "Onboarding"): the
// Welcome card, then one step's panel at a time with the StepList beside it
// (from 1024px) or above it (narrower). The page opens on initialStep
// (?step=…, else the first step not done); choosing a step replaces ?step=
// without scrolling. The steps are re-read from GET /api/admin/onboarding:
// every 10 s while a step is in progress and the tab is visible, when the
// window gets focus, and after anything in a panel saves. A failed re-read
// keeps what is on screen.
//   initial      the GET answer's shape (lib/onboarding/steps.js deriveSteps)
//   initialStep  a step id; canSync: the role may run a sync (FirstRun)
//   publishHref  the editor's Publish; welcome: the rendered Welcome card

export const REFRESH_MS = 10_000;
const PANELS = { connect: ConnectPanel, import: ImportPanel, brand: BrandPanel, open: OpenPanel };
const PILL = {
  done: "bg-success/10 text-success",
  in_progress: "bg-info/10 text-info",
  ready: "bg-muted text-muted-foreground",
  blocked: "bg-warning/10 text-warning-text",
};

export default function Onboarding({ initial, initialStep, canSync = false, publishHref, welcome = null }) {
  const router = useRouter();
  const [model, setModel] = useState(initial);
  const [selected, setSelected] = useState(initialStep);
  const reading = useRef(false);
  const heading = useRef(null);
  const focusHeading = useRef(false);

  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const res = await fetch(ONBOARDING_URL, { headers: { Accept: "application/json" }, cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok && Array.isArray(json.steps)) setModel(json);
    } catch {
      // keep what is on screen
    } finally {
      reading.current = false;
    }
  }, []);

  const busy = model.steps.some((s) => s.state === "in_progress");
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [busy, refresh]);
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    heading.current?.focus();
  }, [selected]);

  // from a button inside the panel (Next, Go to …), which goes away with the
  // panel: focus moves to the new step's title so the keyboard isn't lost
  function choose(id, { focus = false } = {}) {
    focusHeading.current = focus;
    setSelected(id);
    router.replace(`?step=${id}`, { scroll: false });
  }

  const index = Math.max(0, model.steps.findIndex((s) => s.id === selected));
  const step = model.steps[index];
  const Panel = PANELS[step.id];
  const nextUp = step.state === "done" ? model.steps.find((s, i) => i > index && s.state !== "done") || null : null;
  // the step this one waits for, when that is another step: the way to it is
  // the page's one next action
  const waitsFor = step.state === "blocked" ? model.steps.find((s) => s.id === step.blockedBy) || null : null;
  // Brand and Import still show old screens (data-legacy) until lines 4–7
  // rebuild them: they sit on a sunken tray, so their own cards read as
  // content inside the step, not as a second page inside the card
  const tray = (step.id === "brand" || step.id === "import") && step.state !== "blocked";
  const list = { steps: model.steps, selected: step.id, onSelect: choose, doneCount: model.doneCount, total: model.total };

  return (
    <div data-onboarding="page" className="lg:grid lg:grid-cols-[200px_minmax(0,640px)] lg:justify-center lg:gap-8">
      <div className="hidden lg:block">
        <div className="sticky top-8 pt-1">
          <StepList {...list} />
        </div>
      </div>
      <div data-onboarding="column" className="mx-auto w-full max-w-[640px] min-w-0 space-y-8">
        {welcome}
        <div className="lg:hidden">
          <StepList {...list} variant="compact" />
        </div>

        <section aria-labelledby="onboarding-step-title" data-onboarding="panel" data-step={step.id} data-state={step.state} className="rounded-card border border-border bg-card text-card-foreground shadow-card">
          <header className="space-y-2 p-4 md:p-6">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground tabular-nums">
                Step {index + 1} of {model.total}
              </p>
              <span data-onboarding="step-state" className={cn("rounded-full px-2 py-0.5 text-xs font-medium", PILL[step.state])}>
                {STATE_WORDS[step.state]}
              </span>
            </div>
            <h2 ref={heading} tabIndex={-1} id="onboarding-step-title" className="text-[1.375rem] leading-tight font-semibold outline-none">
              {step.label}
            </h2>
            {step.state === "blocked" ? (
              <p data-onboarding="words" className="flex items-start gap-2 text-sm text-foreground">
                <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">{step.words}</span>
              </p>
            ) : (
              <p data-onboarding="words" className="text-sm text-muted-foreground">
                {step.words}
              </p>
            )}
            {step.problem && (
              <p role="status" data-onboarding="problem" className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning-text">
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">{step.problem}</span>
              </p>
            )}
          </header>
          <div data-onboarding="panel-body" data-tray={tray || undefined} className={cn("space-y-4 border-t border-border p-4 md:p-6 empty:hidden", tray && "rounded-b-card bg-muted")}>
            {waitsFor && (
              <Button size="lg" className="h-10 px-4" onClick={() => choose(waitsFor.id, { focus: true })} data-onboarding="go-blocker">
                Go to {waitsFor.label}
              </Button>
            )}
            <Panel key={step.id} step={step} canSync={canSync} publishHref={publishHref} onChange={refresh} onModel={setModel} />
            {nextUp && (
              <Button size="lg" className="h-10 px-4" onClick={() => choose(nextUp.id, { focus: true })} data-onboarding="next">
                Next: {nextUp.label}
              </Button>
            )}
          </div>
        </section>

        {model.doneCount === model.total ? (
          // every step done: the dashboard is the one next action
          <Button asChild size="lg" className="h-10 px-4">
            <Link href="/admin/dashboard">Go to your dashboard</Link>
          </Button>
        ) : (
          <p className="text-sm">
            <Link href="/admin/dashboard" className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              Go to your dashboard
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
