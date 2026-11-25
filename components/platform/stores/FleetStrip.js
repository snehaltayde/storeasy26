"use client";

// The fleet at a glance above the Stores list (Phase 3 line 1): store counts
// by status (from the list's own control-plane counts), and from
// /api/platform/overview the 30-day net revenue (stores that could not be
// counted are listed, never counted as zero), MRR, and how many stores are
// behind on migrations. `counts` is null while the list loads and false when
// it failed. The overview opens every store's database, so it loads
// on its own and never holds up the list.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MoneyCell } from "@/components/kit/money-cell";
import { cn } from "@/components/ui/utils";

// The strip stays quiet (the table's Health column is the screen's focus):
// a small label, the number, and one line of context. `alert` colours a number
// that needs the operator (stores behind on migrations).
function Stat({ label, children, note = null, alert = false }) {
  return (
    <Card className="gap-0 py-3" data-fleet-stat={label}>
      <CardContent className="space-y-1 px-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className={cn("flex h-7 items-center font-mono text-lg font-semibold tabular-nums", alert ? "text-warning-text" : "text-foreground")}>{children}</div>
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
  const failed = <span className="font-sans text-sm font-normal text-destructive">Couldn't load</span>;

  return (
    <section aria-label="Fleet" data-fleet-strip className="mb-6 space-y-2">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Stores" note={counts ? `${counts.active} active, ${counts.suspended} suspended, ${counts.maintenance} in maintenance` : null}>
          {counts ? counts.all : counts === false ? failed : pending}
        </Stat>
        <Stat
          label="Net revenue, 30 days"
          note={d && (uncovered.length ? `Not counted: ${uncovered.map((u) => u.tenant).join(", ")}` : `All ${d.revenue30d.covered_tenants} active stores counted`)}
        >
          {state.loading && !d ? pending : d ? <MoneyCell amount={d.revenue30d.net} currency="INR" className="text-left" /> : failed}
        </Stat>
        <Stat label="MRR">{state.loading && !d ? pending : d ? <MoneyCell amount={(Number(d.mrr) || 0) / 100} currency="INR" className="text-left" /> : failed}</Stat>
        <Stat label="Behind on migrations" alert={behind > 0} note={d && (unknownMigrations ? `${unknownMigrations} couldn't be checked` : `Repo head ${d.repoMigrationHead}`)}>
          {state.loading && !d ? pending : d ? behind : failed}
        </Stat>
      </div>
      {state.error && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="status">
          The fleet numbers didn't load.
          <Button type="button" variant="outline" size="sm" data-read-control onClick={load}>
            <RefreshCw aria-hidden /> Try again
          </Button>
        </p>
      )}
    </section>
  );
}
