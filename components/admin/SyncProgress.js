"use client";

import { CircleAlert, LoaderCircle, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

// Bringing products in from Shopify (GEN-02): honest progress, read from the
// sync's own record. While a sync runs, onboarding's Brand step polls
// /api/admin/sync (readSync), which also gives the sync its next slice; a
// failure shows a plain message and a retry. On components/ui since Phase 2
// line 11. The view object (state, headline, detail, message) is built server
// side by lib/admin/sync-view.js, so the words match everywhere.

export const POLL_MS = 3000;

export async function readSync() {
  const res = await fetch("/api/admin/sync", { headers: { Accept: "application/json" }, cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  return res.ok && data.sync ? data.sync : null;
}

export async function requestSync(body) {
  const res = await fetch("/api/admin/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok) return { ok: true, sync: data.sync };
  if (res.status === 429) return { ok: false, error: "That was a lot of tries in a row. Wait a minute, then try again." };
  return { ok: false, error: data.error || "Couldn't start. Check your connection, then try again." };
}

const timeOf = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : null;
};

// Pure render, so the suite can check every state's markup.
export function SyncProgressBody({ view, busy = false, error = null, canRun = true, showStart = false, onRetry, onStart }) {
  if (!view) return null;
  const { state, products } = view;
  const total = products?.total;
  const counting = (state === "running" || state === "retrying") && (!view.phase || view.phase === "products");
  const pct = counting && total > 0 ? Math.min(100, Math.round((products.done / total) * 100)) : null;
  const working = state === "running" || state === "retrying";
  const retryLabel = state === "retrying" ? "Try again now" : "Try again";
  const startLabel = state === "none" ? "Bring in products" : "Refresh from Shopify";
  // A refresh of a store that already has its products is a warning, not an
  // alarm: the store keeps working on what it had.
  const tone = state === "retrying" || view.firstSync === false ? "warning" : "danger";
  const canStartHere = view.canStart && (state === "none" || showStart);
  const Busy = ({ icon: Icon }) => (busy ? <LoaderCircle aria-hidden className="motion-safe:animate-spin" /> : <Icon aria-hidden />);
  return (
    <div className="space-y-3">
      <div aria-live="polite" className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">{view.headline}</p>
        {view.message && (
          <Alert variant={tone === "danger" ? "destructive" : "warning"} role={tone === "danger" ? "alert" : "status"} data-tone={tone}>
            {tone === "danger" ? <CircleAlert aria-hidden /> : <TriangleAlert aria-hidden />}
            <AlertDescription className="text-current">
              <p>{view.message}</p>
            </AlertDescription>
          </Alert>
        )}
        {view.detail && <p className="text-xs text-muted-foreground">{view.detail}</p>}
        {view.retryAt && timeOf(view.retryAt) && <p className="text-xs text-muted-foreground">Next try at about {timeOf(view.retryAt)}.</p>}
      </div>
      {working && (
        <div
          role="progressbar"
          aria-label="Products brought in"
          aria-valuemin={pct != null ? 0 : undefined}
          aria-valuemax={pct != null ? 100 : undefined}
          aria-valuenow={pct ?? undefined}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={pct != null ? "h-full rounded-full bg-primary motion-safe:transition-[width]" : "h-full w-1/3 rounded-full bg-primary/60 motion-safe:animate-pulse"}
            style={pct != null ? { width: `${Math.max(pct, 2)}%` } : undefined}
          />
        </div>
      )}
      {error && (
        <Alert variant="destructive" data-tone="danger">
          <CircleAlert aria-hidden />
          <AlertTitle>Couldn&apos;t start</AlertTitle>
          <AlertDescription className="text-current">
            <p>{error}</p>
          </AlertDescription>
        </Alert>
      )}
      {canRun && (view.canRetry || canStartHere) && (
        <div className="flex flex-wrap gap-2">
          {view.canRetry && (
            <Button disabled={busy} aria-busy={busy || undefined} onClick={onRetry}>
              <Busy icon={RotateCcw} />
              {retryLabel}
            </Button>
          )}
          {!view.canRetry && canStartHere && (
            <Button variant={state === "none" ? "default" : "outline"} disabled={busy} aria-busy={busy || undefined} onClick={onStart}>
              <Busy icon={RefreshCw} />
              {startLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
