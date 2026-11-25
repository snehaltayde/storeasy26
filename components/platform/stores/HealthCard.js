"use client";

// A store's live health on its page (Phase 3 line 1): GET
// /api/platform/tenants?health=<id>, at most 5 seconds on the server. Try again
// re-runs the check. A failed request or a slow store reads "Can't reach the
// store's database", never healthy.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/components/ui/utils";
import HealthMark from "./HealthMark";
import { when } from "./storesWords";

export default function HealthCard({ storeId }) {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const check = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/platform/tenants?health=${encodeURIComponent(storeId)}`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      setHealth((res.ok && body?.health?.[storeId]) || { state: "unreachable", reasons: [] });
    } catch {
      setHealth({ state: "unreachable", reasons: [] });
    }
    setLoading(false);
  }, [storeId]);
  useEffect(() => {
    check();
  }, [check]);

  return (
    <Card data-card="health" aria-busy={loading || undefined}>
      <CardHeader>
        <CardTitle>Health</CardTitle>
        <CardAction>
          <Button type="button" variant="outline" size="sm" data-read-control onClick={check} disabled={loading}>
            <RefreshCw aria-hidden /> Try again
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-1.5">
            <Skeleton className="size-5 rounded-full" />
            <Skeleton className="h-5 w-56" />
          </div>
        ) : (
          // the page's headline: the verdict in words, before the numbers
          <HealthMark health={health} size="lg" />
        )}
        {!loading && health?.reachable && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Products</dt>
              <dd className="font-mono tabular-nums">{health.products}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last synced</dt>
              <dd>{when(health.lastSyncedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Orders in flight</dt>
              <dd className="font-mono tabular-nums">{health.ordersInFlight}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Failed pushes</dt>
              <dd className={cn("font-mono tabular-nums", health.failedPushes > 0 && "text-warning-text")}>{health.failedPushes}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
