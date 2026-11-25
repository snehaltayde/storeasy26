"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";

// A custom app's last 100 API calls (Phase 4 line 4), read from
// GET /api/admin/apps/[id]/calls (audit.read: owner and admin; the card does
// not draw it for others). Time, method and path (mono), the answer's status
// and which token made it. The store's Audit log tab shows the same rows.
//   installId
const TIME = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", second: "2-digit" });
const timeOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : TIME.format(d);
};
const tone = (s) => (s >= 500 ? "danger" : s === 429 || s === 403 || s === 401 ? "warning" : s >= 200 && s < 300 ? "success" : "muted");

export function CallLog({ installId }) {
  const [calls, setCalls] = useState(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/apps/${encodeURIComponent(installId)}/calls`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error);
      setCalls(json.calls);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [installId]);
  useEffect(() => {
    load();
  }, [load]);

  const columns = [
    { key: "at", header: "Time", cell: (c) => <span className="tabular-nums">{timeOf(c.at)}</span> },
    { key: "path", header: "Call", cell: (c) => <span className="font-mono text-xs break-all">{`${c.method} ${c.path}`}</span> },
    {
      key: "status",
      header: "Answer",
      cell: (c) => (
        <Badge variant={tone(c.status)} className="font-mono" data-call-status={c.status}>
          {c.status ?? "—"}
        </Badge>
      ),
    },
    { key: "tokenName", header: "Token", truncate: true, cell: (c) => c.tokenName ?? c.tokenId ?? "—" },
  ];

  return (
    <section aria-labelledby="api-calls" className="space-y-3" data-apps="call-log">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="api-calls" className="text-sm font-medium text-foreground">
          Recent calls
        </h3>
        <Button type="button" variant="outline" size="sm" data-read-control data-apps="calls-refresh" disabled={loading} onClick={() => load()}>
          Refresh
        </Button>
      </div>
      {failed ? (
        <p className="text-sm text-muted-foreground">We couldn't load the calls. Try Refresh.</p>
      ) : (
        <DataTable label="Recent API calls" columns={columns} rows={calls ?? []} loading={loading && !calls} empty={<EmptyState icon={Activity} title="No calls yet" description="Each call this app makes with a token shows here, including refused ones." />} />
      )}
    </section>
  );
}
