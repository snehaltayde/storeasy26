"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/kit/role-gate";
import { StatusBadge } from "@/components/kit/status-badge";
import { useToast } from "@/components/console/Toast";

// The Catalog header's facts and action (docs/plans/phase-2.md "Line 3" §1.4):
// when the catalog last came in from Shopify, how many products there are,
// and "Sync from Shopify" through the existing POST /api/admin/sync (sync.run;
// other roles see the button disabled with the reason). While a sync runs the
// header reads GET /api/admin/sync every few seconds, then reloads the page.
export const SYNC_REASON = "Only the store's owner or an admin can sync from Shopify.";
const ACTIVE = new Set(["running", "retrying", "stalled"]);
const POLL_MS = 3000;

const productWords = (n) => (n === 1 ? "1 product" : `${n} products`);

export function SyncHeader({ role, canSync, lastSynced, products, sync }) {
  const router = useRouter();
  const toast = useToast();
  const [view, setView] = useState(sync);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  const state = view?.state || "none";
  const active = ACTIVE.has(state);

  useEffect(() => {
    if (!active) return undefined;
    timer.current = setTimeout(async () => {
      const body = await fetch("/api/admin/sync", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!body?.sync) return setView((v) => ({ ...v }));
      setView(body.sync);
      if (body.sync.state === "complete") {
        toast.success("Your catalog is up to date.");
        router.refresh();
      } else if (body.sync.state === "failed") toast.error(body.sync.headline || "The sync stopped. Try again.");
    }, POLL_MS);
    return () => clearTimeout(timer.current);
  }, [active, view, router, toast]);

  async function start() {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state === "failed" || state === "stalled" ? { retry: true } : {}) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) throw new Error(body?.error || "We couldn't start the sync. Try again.");
      setView(body.sync);
      toast.info("Syncing your catalog from Shopify.");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const unlinked = view?.linked === false;
  return (
    <div data-catalog="sync-header" className="flex flex-col items-start gap-2 sm:items-end">
      <p className="text-sm text-muted-foreground">
        <span data-catalog="last-synced">{lastSynced ? `Last synced ${lastSynced}` : "Not synced yet"}</span>
        <span aria-hidden> · </span>
        <span data-catalog="product-count" className="font-mono tabular-nums">
          {productWords(products)}
        </span>
      </p>
      <div className="flex items-center gap-2">
        {active && <StatusBadge kind="sync" status={state} />}
        {canSync && unlinked ? (
          <Button type="button" variant="outline" size="sm" disabled title="Storeasy isn't linked to your Shopify store yet. Contact support to link it.">
            <RefreshCw aria-hidden data-icon="inline-start" />
            Sync from Shopify
          </Button>
        ) : (
          <RoleGate role={role} action="sync.run" reason={SYNC_REASON}>
            <Button type="button" variant="outline" size="sm" data-sync-button="" onClick={start} disabled={busy || active}>
              <RefreshCw aria-hidden data-icon="inline-start" className={active ? "motion-safe:animate-spin" : undefined} />
              {active ? "Syncing…" : "Sync from Shopify"}
            </Button>
          </RoleGate>
        )}
      </div>
      {unlinked && <p className="max-w-xs text-xs text-muted-foreground sm:text-right">Storeasy isn't linked to your Shopify store yet. Contact support to link it.</p>}
    </div>
  );
}
