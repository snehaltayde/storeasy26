"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/kit/toast";
import { DELIVERY_STATES, NO_MANAGE, aboutIn, postApp, shortDate } from "@/components/admin/apps/app-words";

// The last 50 deliveries of an app (Phase 4 line 3): topic, event id, status
// (Delivered / Retrying / Waiting / Failed / Skipped), attempts, the last HTTP
// status, the next retry ("about": retries run on the job tick) and how long
// the last attempt took. Status and Topic filters re-ask the GET (reads).
// Resend on Failed or Skipped (admin and owner; RoleGate'd). View payload only
// when the route says this role may see payloads (support and operator
// support get status only).
//   view: GET /api/admin/apps/[id]/webhooks; installId; role
//   onFilter({ status, topic }): re-read with filters; onChanged(): re-read
const ALL = "all";
const STATUS_OPTIONS = [ALL, "delivered", "retrying", "failed", "skipped", "pending"];

export function DeliveriesTable({ view, installId, role, filters, onFilter, onChanged, loading = false }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [shown, setShown] = useState(null);
  async function resend(d) {
    setBusy(d.id);
    const r = await postApp(`apps/${encodeURIComponent(installId)}/webhooks`, { resend: d.id });
    setBusy(null);
    if (!r.ok) return toast.error(r.error);
    toast.success("Sending it again.");
    onChanged();
  }
  const topics = [ALL, ...view.topics.map((t) => t.topic), "ping"];
  const columns = [
    { key: "topic", header: "Event", cell: (d) => <span className="font-mono text-xs">{d.topic}</span> },
    { key: "eventId", header: "Event id", cell: (d) => <span className="font-mono text-xs text-muted-foreground">{d.eventId}</span> },
    {
      key: "status",
      header: "Status",
      cell: (d) => {
        const [label, tone] = DELIVERY_STATES[d.status] ?? ["Unknown", "muted"];
        return (
          <Badge variant={tone} data-delivery-status={d.status} title={d.lastError || undefined}>
            {label}
          </Badge>
        );
      },
    },
    { key: "attempts", header: "Attempts", align: "right", cell: (d) => <span className="tabular-nums">{d.attempts}</span> },
    { key: "lastStatus", header: "Last answer", cell: (d) => (d.lastStatus ? <span className="font-mono tabular-nums">{d.lastStatus}</span> : <span className="text-muted-foreground">{d.lastError ? "None" : "—"}</span>) },
    { key: "nextAttemptAt", header: "Next try", cell: (d) => (d.nextAttemptAt ? aboutIn(d.nextAttemptAt) : <span className="text-muted-foreground">—</span>) },
    { key: "lastMs", header: "Took", align: "right", cell: (d) => (d.lastMs != null ? <span className="tabular-nums">{`${d.lastMs} ms`}</span> : "—") },
    { key: "createdAt", header: "Created", cell: (d) => shortDate(d.createdAt) },
  ];
  return (
    <section aria-labelledby="deliveries-title" className="space-y-3" data-apps="deliveries">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 id="deliveries-title" className="text-sm font-medium text-foreground">
          Recent deliveries
        </h3>
        <div className="flex flex-wrap gap-2">
          <Select value={filters.status ?? ALL} onValueChange={(v) => onFilter({ ...filters, status: v === ALL ? null : v })}>
            <SelectTrigger size="sm" aria-label="Status" data-read-control data-deliveries-filter="status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === ALL ? "Any status" : DELIVERY_STATES[s][0]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.topic ?? ALL} onValueChange={(v) => onFilter({ ...filters, topic: v === ALL ? null : v })}>
            <SelectTrigger size="sm" aria-label="Event" data-read-control data-deliveries-filter="topic">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {topics.map((t) => (
                <SelectItem key={t} value={t}>
                  {t === ALL ? "Any event" : t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <DataTable
        label="Recent deliveries"
        columns={columns}
        rows={view.deliveries}
        loading={loading}
        rowActions={(d) => (
          <div className="flex justify-end gap-1">
            {view.canSeePayloads && d.payload && (
              <Button type="button" variant="ghost" size="sm" data-read-control data-delivery-action="view" onClick={() => setShown(d)}>
                View
              </Button>
            )}
            {(d.status === "failed" || d.status === "skipped") && (
              <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
                <Button type="button" variant="outline" size="sm" disabled={busy === d.id} data-delivery-action="resend" onClick={() => resend(d)}>
                  <Send aria-hidden="true" />
                  {busy === d.id ? "Sending…" : "Resend"}
                </Button>
              </RoleGate>
            )}
          </div>
        )}
        empty={<EmptyState icon={Send} title={filters.status || filters.topic ? "No deliveries match" : "No deliveries yet"} description={filters.status || filters.topic ? "Try another status or event." : "When an order is placed or fulfilled, each delivery shows here. Send a test event to try it now."} />}
      />
      <Dialog open={Boolean(shown)} onOpenChange={(v) => !v && setShown(null)}>
        <DialogContent className="sm:max-w-2xl" data-apps="payload">
          {shown && (
            <>
              <DialogHeader>
                <DialogTitle>{`${shown.topic} · ${shown.eventId}`}</DialogTitle>
                <DialogDescription>{shown.lastError ? `Last try: ${shown.lastError}` : "The event data that was sent (the signature headers are not kept)."}</DialogDescription>
              </DialogHeader>
              <pre className="max-h-[60dvh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{JSON.stringify(shown.payload, null, 2)}</pre>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
