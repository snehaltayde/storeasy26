"use client";

// Phase 3 line 6: the Queues tab (was QueuesPanel). Counts by state, the jobs
// and webhook rows that aren't finished (metadata only: payloads never leave
// the server), Retry and Discard on a dead letter, and "Run due jobs now".
// Every write is audited on the server with the operator's id.
import { useCallback, useEffect, useState } from "react";
import { Play, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { ConfirmDialog, LoadError, Notice, opsGet, opsPost, when } from "./opsShared";

const STATE = {
  pending: ["Waiting", "info"],
  leased: ["Running", "info"],
  dead: ["Dead letter", "danger"],
  done: ["Done", "success"],
  discarded: ["Discarded", "muted"],
  ignored: ["Discarded", "muted"],
};
const StateBadge = ({ status }) => {
  const [label, tone] = STATE[status] || [String(status || "Unknown"), "muted"];
  return (
    <Badge variant={tone} data-ops-state={status}>
      {label}
    </Badge>
  );
};
const errorCell = (row) => (row.last_error ? String(row.last_error).slice(0, 200) : "—");

// A count; a danger count above zero gets the danger edge so the eye lands on
// what needs an operator.
function Stat({ label, value, note, alarm = false, valueAlarm = true }) {
  return (
    <Card size="sm" className={`py-3 ${alarm ? "border-destructive/40 shadow-[inset_3px_0_0_var(--c-danger)]" : ""}`} data-ops-stat-alarm={alarm || undefined}>
      <CardContent className="px-4">
        <p className={`text-xs ${alarm && valueAlarm ? "font-medium text-destructive" : "text-muted-foreground"}`}>{label}</p>
        <p className={`mt-1 font-mono text-[1.375rem] leading-tight font-semibold tabular-nums ${alarm && valueAlarm ? "text-destructive" : "text-foreground"}`}>{value}</p>
        {note && <p className={`mt-0.5 text-xs ${alarm && !valueAlarm ? "font-medium text-destructive" : "text-muted-foreground"}`}>{note}</p>}
      </CardContent>
    </Card>
  );
}

// Dead letters first: they are the rows with something to do.
const deadFirst = (rows) => [...rows].sort((a, b) => (b.status === "dead") - (a.status === "dead"));

export default function Queues() {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [deadOnly, setDeadOnly] = useState(false);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [discarding, setDiscarding] = useState(null); // { kind, row }

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ loading: false, error: null, data: await opsGet(`queues?limit=50${deadOnly ? "&status=dead" : ""}`) });
    } catch (e) {
      setState((s) => ({ loading: false, error: String(e?.message || e), data: s.data }));
    }
  }, [deadOnly]);
  useEffect(() => {
    load();
  }, [load]);

  async function act(key, body, done) {
    setBusy(key);
    setNotice(null);
    try {
      const j = await opsPost("queues", body);
      setNotice({ tone: "success", text: typeof done === "function" ? done(j) : done });
    } catch (e) {
      setNotice({ tone: "error", text: String(e?.message || e) });
    } finally {
      setBusy(null);
      load();
    }
  }

  const data = state.data;
  const jobs = deadFirst((data?.jobs || []).filter((j) => !["done", "discarded"].includes(j.status)));
  const inbox = deadFirst((data?.inbox || []).filter((r) => !["done", "ignored"].includes(r.status)));

  const actions = (kind) => (row) =>
    row.status === "dead" ? (
      <div className="flex justify-end gap-1">
        <Button size="xs" variant="outline" disabled={busy != null} onClick={() => act(`${kind}:${row.id}`, { action: "replay", kind, id: row.id }, "Queued again. It runs on the next tick.")} aria-label={`Retry ${row.id}`}>
          <RotateCcw aria-hidden /> Retry
        </Button>
        <Button size="xs" variant="ghost" disabled={busy != null} onClick={() => setDiscarding({ kind, row })} aria-label={`Discard ${row.id}`}>
          <Trash2 aria-hidden /> Discard
        </Button>
      </div>
    ) : null;

  const jobColumns = [
    { key: "status", header: "State", cell: (j) => <StateBadge status={j.status} /> },
    { key: "type", header: "Job", cell: (j) => <span className="font-mono text-xs">{j.type}</span> },
    { key: "tenant_id", header: "Store", cell: (j) => j.tenant_id || "Platform" },
    { key: "attempts", header: "Tries", align: "right", cell: (j) => `${j.attempts}/${j.max_attempts}` },
    { key: "updated_at", header: "Updated", className: "hidden whitespace-nowrap lg:table-cell", cell: (j) => when(j.updated_at) },
    { key: "last_error", header: "Last error", truncate: true, cell: errorCell },
  ];
  const inboxColumns = [
    { key: "status", header: "State", cell: (r) => <StateBadge status={r.status} /> },
    { key: "topic", header: "Webhook", cell: (r) => <span className="font-mono text-xs">{`${r.source}:${r.topic || "?"}`}</span> },
    { key: "tenant_id", header: "Store", cell: (r) => r.tenant_id || "—" },
    { key: "received_at", header: "Received", className: "hidden whitespace-nowrap lg:table-cell", cell: (r) => when(r.received_at) },
    { key: "last_error", header: "Last error", truncate: true, cell: errorCell },
  ];

  return (
    <section aria-labelledby="ops-queues-title" className="space-y-4" data-ops-tab="queues">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="ops-queues-title" className="text-base font-semibold">
            Job queues and webhooks
          </h2>
          <p className="text-sm text-muted-foreground">Payloads never leave the server. Retries and discards are audited.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" aria-pressed={deadOnly} className="aria-pressed:border-foreground/30 aria-pressed:bg-muted" onClick={() => setDeadOnly((v) => !v)}>
            {deadOnly ? "Show everything unfinished" : "Dead letters only"}
          </Button>
          <Button size="sm" variant="outline" disabled={state.loading} onClick={load}>
            <RefreshCw aria-hidden /> Refresh
          </Button>
          <Button size="sm" disabled={busy != null} onClick={() => act("tick", { action: "tick" }, (j) => `Ran ${j.ran} due job${j.ran === 1 ? "" : "s"}; ${j.failed} failed.`)}>
            <Play aria-hidden /> {busy === "tick" ? "Running…" : "Run due jobs now"}
          </Button>
        </div>
      </div>

      <Notice notice={notice} onClose={() => setNotice(null)} />
      {state.error && <LoadError what="the queues" error={state.error} onRetry={load} />}

      {!data && state.loading ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-card" />
          ))}
        </div>
      ) : data ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-ops-stats>
          <Stat label="Jobs waiting" value={data.stats.jobs.pending} note={data.stats.jobs.oldest_pending_min ? `Oldest waited ${data.stats.jobs.oldest_pending_min} min` : null} />
          <Stat label="Jobs running" value={data.stats.jobs.leased} />
          <Stat label="Dead jobs" value={data.stats.jobs.dead} alarm={data.stats.jobs.dead > 0} />
          <Stat label="Webhooks waiting" value={data.stats.inbox.pending} note={data.stats.inbox.dead ? `${data.stats.inbox.dead} dead` : "None dead"} alarm={data.stats.inbox.dead > 0} valueAlarm={false} />
        </div>
      ) : null}

      {(data || state.loading) && (
        <>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Jobs</h3>
            <DataTable
              label="Jobs"
              columns={jobColumns}
              rows={jobs}
              loading={!data && state.loading}
              rowActions={actions("job")}
              empty={<EmptyState title={deadOnly ? "No dead jobs." : "No jobs waiting, running or dead."} />}
            />
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Webhook inbox</h3>
            <DataTable
              label="Webhook inbox"
              columns={inboxColumns}
              rows={inbox}
              loading={!data && state.loading}
              rowActions={actions("inbox")}
              empty={<EmptyState title={deadOnly ? "No dead webhooks." : "No webhooks waiting or dead."} />}
            />
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!discarding}
        onOpenChange={(o) => !o && setDiscarding(null)}
        title={`Discard ${discarding?.kind === "inbox" ? "this webhook" : "this job"}?`}
        description="It won't run again unless someone retries it from here. The row stays for the record."
        confirmLabel="Discard"
        onConfirm={async () => {
          const { kind, row } = discarding;
          await opsPost("queues", { action: "discard", kind, id: row.id });
          setNotice({ tone: "success", text: `Discarded ${row.id}.` });
          load();
        }}
      />
    </section>
  );
}
