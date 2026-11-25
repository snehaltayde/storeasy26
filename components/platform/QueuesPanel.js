"use client";

import { useEffect, useState, useCallback } from "react";
import { RotateCcw } from "lucide-react";
import { Card, CardHeader } from "@/components/console/Card";
import { Button } from "@/components/console/Button";
import { StatusBadge } from "@/components/console/Badge";
import { Table } from "@/components/console/Table";
import { Stat, SkeletonText, ErrorState, EmptyState } from "@/components/console/bits";
import { useToast } from "@/components/kit/toast";

// Queue & webhook inspector (S29 / OP05, redesigned S50): stats, non-done
// jobs and inbox rows (metadata only — payloads never leave the server),
// per-row replay, and a "run due now" button. Replays are audited
// server-side.
const JOB_COLUMNS = [
  { key: "status", header: "Status" },
  { key: "type", header: "Job" },
  { key: "tenant_id", header: "Tenant" },
  { key: "attempts", header: "Attempts", align: "right" },
  { key: "last_error", header: "Last error" },
  { key: "replay", header: "", width: "6rem" },
];

const INBOX_COLUMNS = [
  { key: "status", header: "Status" },
  { key: "topic", header: "Webhook" },
  { key: "tenant_id", header: "Tenant" },
  { key: "last_error", header: "Last error" },
  { key: "replay", header: "", width: "6rem" },
];

export default function QueuesPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null); // action key in flight ("tick" | "job:<id>" | "inbox:<id>")
  const toast = useToast();

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const res = await fetch("/api/platform/queues?limit=30");
      if (res.ok) setData(await res.json());
      else setErr(`Couldn't load queues (${res.status})`);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function act(body, label, key) {
    setBusy(key);
    const res = await fetch("/api/platform/queues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) toast.success(`${label}: ok${j.ran !== undefined ? ` (ran ${j.ran}, failed ${j.failed})` : ""}`);
    else toast.error(`${label}: ${j.error || res.status}`);
    setBusy(null);
    refresh();
  }

  const interesting = (data?.jobs || []).filter((j) => j.status !== "done");
  const inboxRows = (data?.inbox || []).filter((r) => r.status !== "done" && r.status !== "ignored");

  const replayCell = (kind) => (row) =>
    row.status === "dead" ? (
      <Button
        size="sm"
        icon={<RotateCcw size={13} aria-hidden />}
        busy={busy === `${kind}:${row.id}`}
        disabled={busy !== null && busy !== `${kind}:${row.id}`}
        onClick={() => act({ action: "replay", kind, id: row.id }, `replay ${row.id}`, `${kind}:${row.id}`)}
      >
        Replay
      </Button>
    ) : null;

  return (
    <Card id="queues">
      <CardHeader
        title="Queues & webhooks"
        description="Metadata only — payloads never leave the server. Replays are audited."
        actions={
          <>
            <Button size="sm" busy={busy === "tick"} disabled={busy !== null && busy !== "tick"} onClick={() => act({ action: "tick" }, "tick", "tick")}>
              Run due now
            </Button>
            <Button size="sm" disabled={busy !== null} onClick={refresh}>
              Refresh
            </Button>
          </>
        }
      />
      {err && <ErrorState title="Couldn't load queues" detail={err} onRetry={refresh} />}
      {!data && !err && <SkeletonText lines={3} />}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Jobs pending" value={data.stats.jobs.pending} sub={data.stats.jobs.oldest_pending_min ? `oldest ${data.stats.jobs.oldest_pending_min}m` : undefined} />
            <Stat label="Jobs leased" value={data.stats.jobs.leased} />
            <Stat label="Jobs dead" value={data.stats.jobs.dead} tone={data.stats.jobs.dead ? "danger" : "muted"} />
            <Stat label="Inbox" value={data.stats.inbox.pending} sub={`pending · ${data.stats.inbox.dead} dead`} tone={data.stats.inbox.dead ? "danger" : undefined} />
          </div>

          {interesting.length === 0 && inboxRows.length === 0 ? (
            <EmptyState title="Queue drained" body="Nothing pending or dead across jobs and webhook inbox." />
          ) : (
            <>
              {interesting.length > 0 && (
                <>
                  <h3 className="mt-5 text-xs font-semibold text-fg-muted">Jobs</h3>
                  <Table
                    className="mt-1"
                    dense
                    columns={JOB_COLUMNS}
                    rows={interesting}
                    renderCell={(j, col) => {
                      switch (col.key) {
                        case "status":
                          return <StatusBadge status={j.status} />;
                        case "type":
                          return <span className="font-mono text-xs">{j.type}</span>;
                        case "tenant_id":
                          return <span className="text-xs text-fg-muted">{j.tenant_id || "—"}</span>;
                        case "attempts":
                          return (
                            <span className="text-xs text-fg-muted">
                              {j.attempts}/{j.max_attempts}
                            </span>
                          );
                        case "last_error":
                          return j.last_error ? (
                            <span className="block max-w-56 truncate text-xs text-danger" title={String(j.last_error)}>
                              {String(j.last_error).slice(0, 80)}
                            </span>
                          ) : (
                            <span className="text-xs text-fg-subtle">—</span>
                          );
                        case "replay":
                          return replayCell("job")(j);
                        default:
                          return j[col.key];
                      }
                    }}
                  />
                </>
              )}

              {inboxRows.length > 0 && (
                <>
                  <h3 className="mt-5 text-xs font-semibold text-fg-muted">Webhook inbox</h3>
                  <Table
                    className="mt-1"
                    dense
                    columns={INBOX_COLUMNS}
                    rows={inboxRows}
                    renderCell={(r, col) => {
                      switch (col.key) {
                        case "status":
                          return <StatusBadge status={r.status} />;
                        case "topic":
                          return (
                            <span className="font-mono text-xs">
                              {r.source}:{r.topic || "?"}
                            </span>
                          );
                        case "tenant_id":
                          return <span className="text-xs text-fg-muted">{r.tenant_id || "—"}</span>;
                        case "last_error":
                          return r.last_error ? (
                            <span className="block max-w-56 truncate text-xs text-danger" title={String(r.last_error)}>
                              {String(r.last_error).slice(0, 80)}
                            </span>
                          ) : (
                            <span className="text-xs text-fg-subtle">—</span>
                          );
                        case "replay":
                          return replayCell("inbox")(r);
                        default:
                          return r[col.key];
                      }
                    }}
                  />
                </>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}
