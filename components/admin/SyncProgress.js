"use client";

import { useEffect, useState } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { Card, CardHeader } from "@/components/console/Card";
import { Banner } from "@/components/console/Banner";
import { Button } from "@/components/console/Button";

// Bringing products in from Shopify (GEN-02): honest progress, read from the
// sync's own record. While a sync runs the card polls /api/admin/sync, which
// also gives the sync its next slice; a failure shows a plain message and a
// retry. The view object (state, headline, detail, message) is built server
// side by lib/admin/sync-view.js, so the words match everywhere.

export const POLL_MS = 3000;
const LIVE = new Set(["running", "retrying"]);

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
  return (
    <div className="space-y-3">
      <div aria-live="polite" className="space-y-1.5">
        <p className="text-sm font-medium text-fg">{view.headline}</p>
        {view.message && (
          <Banner tone={state === "retrying" ? "warning" : "danger"}>
            <p>{view.message}</p>
          </Banner>
        )}
        {view.detail && <p className="text-xs text-fg-muted">{view.detail}</p>}
        {view.retryAt && timeOf(view.retryAt) && <p className="text-xs text-fg-muted">Next try at about {timeOf(view.retryAt)}.</p>}
      </div>
      {working && (
        <div
          role="progressbar"
          aria-label="Products brought in"
          aria-valuemin={pct != null ? 0 : undefined}
          aria-valuemax={pct != null ? 100 : undefined}
          aria-valuenow={pct ?? undefined}
          className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
        >
          <div
            className={pct != null ? "h-full rounded-full bg-primary motion-safe:transition-[width]" : "h-full w-1/3 rounded-full bg-primary/60 motion-safe:animate-pulse"}
            style={pct != null ? { width: `${Math.max(pct, 2)}%` } : undefined}
          />
        </div>
      )}
      {error && (
        <Banner tone="danger" title="Couldn't start">
          <p>{error}</p>
        </Banner>
      )}
      {canRun && (view.canRetry || (showStart && view.canStart) || state === "none") && (
        <div className="flex flex-wrap gap-2">
          {view.canRetry && (
            <Button variant="primary" busy={busy} icon={<RotateCcw size={14} aria-hidden />} onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
          {!view.canRetry && (state === "none" || showStart) && view.canStart && (
            <Button variant={state === "none" ? "primary" : "secondary"} busy={busy} icon={<RefreshCw size={14} aria-hidden />} onClick={onStart}>
              {startLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default function SyncProgress({ initial, canRun = true, showStart = false, id, title = "Your products from Shopify", description }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Poll while it runs. Each answer re-arms the timer, so a stopped sync
  // stops the polling too.
  useEffect(() => {
    if (!view || !LIVE.has(view.state)) return undefined;
    const timer = setTimeout(async () => {
      const next = await readSync().catch(() => null);
      if (next) setView(next);
      else setView((v) => ({ ...v }));
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [view]);

  async function act(body) {
    setBusy(true);
    setError(null);
    const res = await requestSync(body);
    if (res.ok && res.sync) setView(res.sync);
    else if (!res.ok) setError(res.error);
    setBusy(false);
  }

  if (!view) return null;
  return (
    <Card id={id}>
      <CardHeader title={title} description={description} />
      <SyncProgressBody
        view={view}
        busy={busy}
        error={error}
        canRun={canRun}
        showStart={showStart}
        onRetry={() => act({ retry: true })}
        onStart={() => act({})}
      />
    </Card>
  );
}
