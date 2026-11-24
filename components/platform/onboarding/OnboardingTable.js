"use client";

// Phase 1 line 8: one row per signup (until its store exists) and per store.
// Each row's store name is a button that opens the detail sheet (keyboard:
// Tab to it, Enter). Long names truncate, with the full text in a tooltip.
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { statusWords, stuckLabel, when, STEP_LABELS, STEP_STATE_WORDS, PROVISION_STEP_WORDS } from "./onboardingWords";

function Clip({ text, className = "max-w-48" }) {
  if (!text) return <span className="text-muted-foreground">–</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={`block truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}>
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

function Who({ who }) {
  if (who.owners) return <Clip text={who.owners} className="max-w-56" />;
  return (
    <div className="min-w-0">
      <Clip text={who.name} className="max-w-56" />
      <Clip text={who.email} className="max-w-56 text-xs text-muted-foreground" />
    </div>
  );
}

function Progress({ row }) {
  if (row.provision) {
    const p = row.provision;
    return (
      <div className="text-[0.8125rem]">
        <div>{PROVISION_STEP_WORDS[p.step] || p.step || "Waiting to start"}</div>
        <div className="text-xs text-muted-foreground">
          {p.attempts ? `try ${p.attempts}` : "first try"}
          {p.nextRetryAt ? ` · next ${when(p.nextRetryAt)}` : ""}
          {p.alerted ? " · operator alerted" : ""}
        </div>
      </div>
    );
  }
  const o = row.onboarding;
  if (!o) return <span className="text-xs text-muted-foreground">{row.kind === "tenant" ? "Not checked yet" : "–"}</span>;
  if (!o.supported) return <span className="text-xs text-muted-foreground">No onboarding steps</span>;
  if (!o.step) return <span className="text-[0.8125rem]">All 4 steps done</span>;
  return (
    <div className="text-[0.8125rem]">
      <div>
        Step {o.stepNumber} of 4 · {STEP_LABELS[o.step]} <span className="text-muted-foreground">({STEP_STATE_WORDS[o.state] || o.state})</span>
      </div>
      {o.problem && <Clip text={o.problem} className="max-w-64 text-xs text-warning-text" />}
    </div>
  );
}

export default function OnboardingTable({ rows, busy, onOpen, selected }) {
  return (
    <div className={`rounded-card border border-border bg-card ${busy ? "opacity-70" : ""}`} aria-busy={busy || undefined}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Store</TableHead>
            <TableHead>Who</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Setup or onboarding</TableHead>
            <TableHead>Stuck</TableHead>
            <TableHead>Latest note</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const s = statusWords(r.status);
            const stuck = ["open", "suspended", "address_freed", "superseded", "expired"].includes(r.status) ? null : stuckLabel(r);
            return (
              <TableRow key={r.subject} data-subject={r.subject} data-status={r.status} data-state={selected === r.subject ? "selected" : undefined} className="h-10 pointer-coarse:h-12">
                <TableCell className="max-w-60">
                  <button type="button" onClick={() => onOpen(r.subject)} className="block max-w-full rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="block truncate" title={r.store.name}>
                      {r.store.name}
                    </span>
                  </button>
                  <span className="block truncate font-mono text-xs text-muted-foreground" title={r.store.address}>
                    {r.store.address}
                  </span>
                </TableCell>
                <TableCell>
                  <Who who={r.who} />
                </TableCell>
                <TableCell>
                  <Badge variant={s.tone}>{s.label}</Badge>
                  {r.supportUntil && <div className="mt-1 text-xs text-muted-foreground">Support access open until {when(r.supportUntil)}</div>}
                </TableCell>
                <TableCell>
                  <Progress row={r} />
                </TableCell>
                <TableCell className="text-[0.8125rem] tabular-nums">{stuck || <span className="text-muted-foreground">–</span>}</TableCell>
                <TableCell>{r.note ? <Clip text={r.note.text} className="max-w-48 text-[0.8125rem]" /> : <span className="text-muted-foreground">–</span>}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
