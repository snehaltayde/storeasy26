"use client";

// A store's live health on its page (Phase 3 line 1): GET
// /api/platform/tenants?health=<id>, at most 5 seconds on the server. Try again
// re-runs the check. A failed request or a slow store reads "Can't reach the
// store's database", never healthy.
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { healthWords, when } from "./storesWords";

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

  const { label, tone } = healthWords(loading ? null : health);
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
          <Skeleton className="h-5 w-48" />
        ) : (
          <Badge variant={tone} data-health={health.state} className="whitespace-normal">
            {label}
          </Badge>
        )}
        {!loading && health?.reachable && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
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
              <dd className="font-mono tabular-nums">{health.failedPushes}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
