"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/kit/page-header";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { roleAllows } from "@/lib/platform/authz";
import { fmtDate } from "@/components/admin/media/media-words";
import { ExperimentForm, TARGETS } from "./ExperimentForm";

// The experiments list on the new UI (Phase 2 line 9): tabs by status with
// counts (reads), one row per experiment linking to its page. Writers
// (storefront.write) get "New experiment" (a draft, in a sheet); support
// gets no write control. Starting happens on the experiment's own page.
//   initial: experiments (lib/experiments.js listExperiments) | null (the read failed); role
export const EXPERIMENT_STATUS = Object.freeze({
  draft: ["Draft", "muted"],
  running: ["Running", "success"],
  paused: ["Paused", "warning"],
  completed: ["Completed", "info"],
});
export function ExperimentStatus({ status }) {
  const [label, tone] = EXPERIMENT_STATUS[status] || ["Unknown", "muted"];
  return (
    <Badge variant={tone} data-experiment-status={status}>
      {label}
    </Badge>
  );
}
export const splitWords = (variants) => variants.map((v) => `${v.key} ${v.weight}%`).join(" / ");
const TABS = [["all", "All"], ["running", "Running"], ["draft", "Drafts"], ["paused", "Paused"], ["completed", "Completed"]];

export function ExperimentsList({ initial, role }) {
  const router = useRouter();
  const [tab, setTab] = useState("all");
  const [creating, setCreating] = useState(false);
  const rows = initial || [];
  const counts = useMemo(() => Object.fromEntries(TABS.map(([k]) => [k, k === "all" ? rows.length : rows.filter((e) => e.status === k).length])), [rows]);
  const shown = tab === "all" ? rows : rows.filter((e) => e.status === tab);
  const canWrite = roleAllows(role, "storefront.write");

  return (
    <>
      <PageHeader
        title="Experiments"
        description="Test a change to your home page hero on part of your visitors before you keep it."
        actions={
          <RoleGate role={role} action="storefront.write" mode="hide">
            <Button type="button" onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              New experiment
            </Button>
          </RoleGate>
        }
      />
      {!canWrite && <p className="mb-4 text-[0.8125rem] text-muted-foreground">You have read-only access to experiments.</p>}
      {initial == null ? (
        <EmptyState
          title="Couldn't read your experiments just now."
          description="Nothing is lost. Try again in a moment."
          action={
            <Button type="button" variant="outline" data-read-control onClick={() => router.refresh()}>
              Try again
            </Button>
          }
        />
      ) : (
        <>
          <Tabs value={tab} onValueChange={setTab} className="mb-3">
            <TabsList aria-label="Experiments by status" data-read-control className="max-w-full overflow-x-auto">
              {TABS.map(([k, label]) => (
                <TabsTrigger key={k} value={k} data-read-control>
                  {label} <span className="font-mono text-muted-foreground tabular-nums">{counts[k]}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <DataTable
            label="Experiments"
            rows={shown}
            rowKey={(e) => e.slug}
            rowHref={(e) => `/admin/experiments/${encodeURIComponent(e.slug)}`}
            columns={[
              { key: "name", header: "Name", truncate: true },
              { key: "status", header: "Status", cell: (e) => <ExperimentStatus status={e.status} /> },
              { key: "target_kind", header: "Changes", cell: (e) => TARGETS[e.target_kind] || e.target_kind },
              { key: "split", header: "Split", cell: (e) => <span className="font-mono text-[0.8125rem] tabular-nums">{splitWords(e.variants)}</span> },
              { key: "started_at", header: "Started", cell: (e) => (e.started_at ? fmtDate(e.started_at) : "Not yet") },
            ]}
            empty={
              rows.length === 0 ? (
                <EmptyState title="No experiments yet." description={canWrite ? "Start with a new experiment: it stays a draft until it is started." : "Experiments appear here once someone creates one."} />
              ) : (
                <EmptyState title="Nothing in this tab." className="py-6" />
              )
            }
          />
        </>
      )}
      {canWrite && <ExperimentForm open={creating} onOpenChange={setCreating} onSaved={(saved) => router.push(`/admin/experiments/${encodeURIComponent(saved.slug)}`)} />}
    </>
  );
}
