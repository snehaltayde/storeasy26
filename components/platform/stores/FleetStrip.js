"use client";

// The fleet at a glance above the Stores list (Phase 3 line 1): store counts
// by status (from the list's own control-plane counts), and from
// /api/platform/overview the 30-day net revenue (stores that could not be
// counted are listed, never counted as zero), MRR, and how many stores are
// behind on migrations. The overview opens every store's database, so it loads
// on its own and never holds up the list.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney } from "@/lib/format";

function Stat({ label, children, note = null }) {
  return (
    <Card className="py-3" data-fleet-stat={label}>
      <CardContent className="space-y-1 px-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="font-mono text-lg font-semibold tabular-nums text-foreground">{children}</div>
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
      </CardContent>
    </Card>
  );
}

export default function FleetStrip({ counts }) {
  const [state, setState] = useState({ loading: true, error: false, data: null });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: false }));
    try {
      const res = await fetch("/api/platform/overview", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      setState({ loading: false, error: !res.ok || !data?.ok, data: res.ok ? data : null });
    } catch {
      setState({ loading: false, error: true, data: null });
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const d = state.data;
  const uncovered = d?.revenue30d?.uncovered || [];
  const behind = d ? (d.fleet || []).filter((f) => f.behind).length : null;
  const unknownMigrations = d ? (d.fleet || []).filter((f) => !f.reachable).length : 0;
  const pending = <Skeleton className="h-6 w-20" />;
  const failed = <span className="text-sm font-normal text-destructive">Couldn't load</span>;

  return (
    <section aria-label="Fleet" data-fleet-strip className="mb-6 space-y-2">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Stores" note={counts ? `${counts.active} active · ${counts.suspended} suspended · ${counts.maintenance} in maintenance` : null}>
          {counts ? counts.all : pending}
        </Stat>
        <Stat
          label="Net revenue, 30 days"
          note={d && (uncovered.length ? `Not counted: ${uncovered.map((u) => u.tenant).join(", ")}` : `All ${d.revenue30d.covered_tenants} active stores counted`)}
        >
          {state.loading && !d ? pending : d ? formatMoney(d.revenue30d.net, "INR") : failed}
        </Stat>
        <Stat label="MRR">{state.loading && !d ? pending : d ? formatMoney((Number(d.mrr) || 0) / 100, "INR") : failed}</Stat>
        <Stat label="Behind on migrations" note={d && (unknownMigrations ? `${unknownMigrations} couldn't be checked` : `Repo head ${d.repoMigrationHead}`)}>
          {state.loading && !d ? pending : d ? behind : failed}
        </Stat>
      </div>
      {state.error && (
        <p className="flex items-center gap-2 text-xs text-destructive" role="status">
          The fleet numbers didn't load.
          <Button type="button" variant="outline" size="sm" data-read-control onClick={load}>
            <RefreshCw aria-hidden /> Try again
          </Button>
        </p>
      )}
    </section>
  );
}
