"use client";

import { Check, Lock } from "lucide-react";
import { cn } from "@/components/ui/utils";

// The onboarding progress (docs/UI.md "StepList"): the four steps in order,
// each with its number, label and state in a plain word; a blocked step says
// why. Choosing one shows its panel (Onboarding.js). Two layouts of the same
// list: "rail" (vertical, left of the column from 1024px) and "compact" (a
// row of four above the panel below 1024px).
//   steps     the model's steps; selected: a step id; onSelect(id)
//   doneCount, total

export const STATE_WORDS = Object.freeze({ done: "Done", in_progress: "In progress", ready: "To do", blocked: "Blocked" });

// Why a blocked step waits, in a few words (the panel says it in full).
export function blockedReason(step, steps = []) {
  if (step.state !== "blocked") return null;
  const by = step.blockedBy && steps.find((s) => s.id === step.blockedBy);
  if (by) return `Waits for ${by.label}`;
  const n = step.facts?.blocking?.length || 0;
  return n === 1 ? "1 thing to fix first" : `${n} things to fix first`;
}

function Marker({ step, index, selected }) {
  const base = "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums font-mono";
  if (step.state === "done") return <span aria-hidden className={cn(base, "bg-success text-primary-foreground")}><Check className="size-3.5" strokeWidth={2.5} /></span>;
  if (step.state === "blocked") return <span aria-hidden className={cn(base, "border border-border bg-muted text-muted-foreground")}><Lock className="size-3" /></span>;
  if (step.state === "in_progress") return <span aria-hidden className={cn(base, "border-2 border-info text-info")}>{index + 1}</span>;
  return <span aria-hidden className={cn(base, "border", selected ? "border-primary text-primary" : "border-border text-muted-foreground")}>{index + 1}</span>;
}

const stateTone = (state) => (state === "done" ? "text-success" : state === "in_progress" ? "text-info" : state === "blocked" ? "text-warning-text" : "text-muted-foreground");

export function Progress({ doneCount, total }) {
  return (
    <div className="space-y-2" data-onboarding="progress">
      <p className="text-[0.8125rem] text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">{doneCount} of {total}</span> steps done
      </p>
      <div role="progressbar" aria-label="Onboarding steps done" aria-valuemin={0} aria-valuemax={total} aria-valuenow={doneCount} className="flex gap-1">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={cn("h-1 flex-1 rounded-full", i < doneCount ? "bg-success" : "bg-border")} />
        ))}
      </div>
    </div>
  );
}

export default function StepList({ steps, selected, onSelect, doneCount, total, variant = "rail" }) {
  if (variant === "compact") {
    return (
      <nav aria-label="Onboarding steps" data-onboarding="steplist-compact" className="space-y-3">
        <Progress doneCount={doneCount} total={total} />
        <ol className="grid grid-cols-4 gap-1">
          {steps.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                aria-current={s.id === selected ? "step" : undefined}
                data-step={s.id}
                data-state={s.state}
                className={cn(
                  "flex min-h-12 w-full flex-col items-center gap-1 rounded-md px-1 py-1.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  s.id === selected ? "bg-card shadow-card" : "hover:bg-muted",
                )}
              >
                <Marker step={s} index={i} selected={s.id === selected} />
                <span className="text-xs leading-tight text-foreground">{s.label}</span>
                <span className="sr-only">
                  {STATE_WORDS[s.state]}
                  {blockedReason(s, steps) ? `: ${blockedReason(s, steps)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
    );
  }
  return (
    <nav aria-label="Onboarding steps" data-onboarding="steplist" className="space-y-6">
      <Progress doneCount={doneCount} total={total} />
      <ol className="relative space-y-1">
        <span aria-hidden className="absolute top-5 bottom-5 left-[1.375rem] w-px bg-border" />
        {steps.map((s, i) => {
          const why = blockedReason(s, steps);
          const on = s.id === selected;
          return (
            <li key={s.id} className="relative">
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                aria-current={on ? "step" : undefined}
                data-step={s.id}
                data-state={s.state}
                className={cn(
                  "flex w-full items-start gap-3 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-colors",
                  on ? "bg-card shadow-card" : "hover:bg-muted",
                )}
              >
                <span className="bg-background"><Marker step={s} index={i} selected={on} /></span>
                <span className="min-w-0 pt-0.5">
                  <span className={cn("block text-sm", on ? "font-medium text-foreground" : "text-foreground")}>{s.label}</span>
                  <span className={cn("block text-xs", stateTone(s.state))} data-onboarding="state">{STATE_WORDS[s.state]}</span>
                  {why && <span className="block text-xs text-muted-foreground" data-onboarding="blocked-reason">{why}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
