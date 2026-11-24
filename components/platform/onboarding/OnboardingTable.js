"use client";

// Phase 1 line 8: one row per signup (until its store exists) and per store.
// Every cell is one line so rows stay 40px (48px on touch); anything cut short
// keeps its full text in a tooltip, and the sheet has the rest. Each row's
// store name is a button that opens the detail sheet (Tab to it, Enter); a
// click anywhere else on the row opens it too.
import { AlertTriangle, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { statusWords, stuckFor, when, STEP_LABELS, STEP_STATE_WORDS, PROVISION_STEP_WORDS } from "./onboardingWords";

const NOT_STUCK = ["open", "suspended", "address_freed", "superseded", "expired"];
const Dash = () => <span className="text-muted-foreground">–</span>;

// a one-line cut with the full text on hover and on keyboard focus
function Clip({ text, tip, className = "" }) {
  if (!text) return <Dash />;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={`block truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}>
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tip || text}</TooltipContent>
    </Tooltip>
  );
}

// a small marker icon whose words are in the tooltip and, for screen readers
// and the row's text, in a visually hidden span
function Marker({ icon: Icon, words, className }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className={`inline-flex shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}>
          <Icon className="size-3.5" aria-hidden />
          <span className="sr-only">{words}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{words}</TooltipContent>
    </Tooltip>
  );
}

function Who({ who }) {
  if (who.owners) return <Clip text={who.owners} />;
  return <Clip text={who.email || who.name} tip={[who.name, who.email].filter(Boolean).join(", ")} />;
}

function Progress({ row }) {
  if (row.provision) {
    const p = row.provision;
    const step = PROVISION_STEP_WORDS[p.step] || p.step || "Waiting to start";
    const more = [p.attempts ? `try ${p.attempts}` : "first try", p.nextRetryAt && `next try ${when(p.nextRetryAt)}`, p.alerted && "operator alerted"].filter(Boolean).join(", ");
    return <Clip text={`${step} (${p.attempts ? `try ${p.attempts}` : "first try"})`} tip={`${step}: ${more}`} />;
  }
  const o = row.onboarding;
  if (!o) return <span className="text-muted-foreground">{row.kind === "tenant" ? "Not checked yet" : "–"}</span>;
  if (!o.supported) return <span className="text-muted-foreground">No onboarding steps</span>;
  if (!o.step) return <span>All 4 steps done</span>;
  const words = `Step ${o.stepNumber} of 4 · ${STEP_LABELS[o.step]} (${STEP_STATE_WORDS[o.state] || o.state})`;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {o.problem && <Marker icon={AlertTriangle} words={o.problem} className="text-warning" />}
      <Clip text={words} />
    </div>
  );
}

function Stuck({ row }) {
  if (NOT_STUCK.includes(row.status) || !row.since) return <Dash />;
  const span = stuckFor(row.since);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="rounded-sm font-mono tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="sr-only">stuck {row.sinceExact ? "" : "at least "}</span>
          <span aria-hidden>{row.sinceExact ? "" : "≥ "}</span>
          {span}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Stuck {row.sinceExact ? "" : "at least "}
        {span}, since {when(row.since)}
      </TooltipContent>
    </Tooltip>
  );
}

export default function OnboardingTable({ rows, busy, onOpen, selected }) {
  return (
    <div className={`overflow-hidden rounded-card border border-border bg-card shadow-card transition-opacity motion-reduce:transition-none ${busy ? "opacity-60" : ""}`} aria-busy={busy || undefined}>
      <Table className="table-fixed min-w-[960px]">
        <colgroup>
          <col className="w-[20%]" />
          <col className="w-[18%]" />
          <col className="w-[10.5rem]" />
          <col className="w-[22%]" />
          <col className="w-[5.5rem]" />
          <col />
        </colgroup>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col">Store</TableHead>
            <TableHead scope="col">Founder or owners</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Setup or onboarding</TableHead>
            <TableHead scope="col" className="text-right">
              Stuck for
            </TableHead>
            <TableHead scope="col">Latest note</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const s = statusWords(r.status);
            return (
              <TableRow
                key={r.subject}
                data-subject={r.subject}
                data-status={r.status}
                data-state={selected === r.subject ? "selected" : undefined}
                onClick={(e) => {
                  if (!e.target.closest("button")) onOpen(r.subject);
                }}
                className="h-10 cursor-pointer pointer-coarse:h-12"
              >
                <TableCell>
                  <div className="flex min-w-0 items-baseline gap-2">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" onClick={() => onOpen(r.subject)} className="max-w-full shrink-0 truncate rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                          {r.store.name}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {r.store.name}
                        {r.store.address ? `, ${r.store.address}` : ""}
                      </TooltipContent>
                    </Tooltip>
                    {r.store.address && <span className="hidden min-w-0 shrink truncate font-mono text-xs text-muted-foreground lg:block">{r.store.address}</span>}
                  </div>
                </TableCell>
                <TableCell>
                  <Who who={r.who} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Badge variant={s.tone}>{s.label}</Badge>
                    {r.supportUntil && <Marker icon={Eye} words={`Support access open until ${when(r.supportUntil)}`} className="text-info" />}
                  </div>
                </TableCell>
                <TableCell>
                  <Progress row={r} />
                </TableCell>
                <TableCell className="text-right">
                  <Stuck row={r} />
                </TableCell>
                <TableCell>{r.note ? <Clip text={r.note.text} tip={`${r.note.text}${r.note.at ? ` (${when(r.note.at)})` : ""}`} /> : <Dash />}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
