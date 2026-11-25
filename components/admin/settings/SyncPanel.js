import { SyncCard } from "@/components/admin/dashboard/SyncCard";

// Settings → Products from Shopify (Phase 2 line 7): the dashboard's sync card
// (onboarding's ImportStepBody on GET /api/admin/sync), always shown here,
// with "Run sync" gated on sync.run, and a line of what the store holds now.
//   view: catalogSyncStatus().view (null when it couldn't be read)
//   counts: { products, collections } or null; gate: gateAction("sync.run", role)
export function SyncPanel({ view, counts, gate, canReconnect }) {
  return (
    <div className="space-y-4" data-settings-tab="sync">
      {counts && (
        <p className="text-sm text-muted-foreground">
          Your store has <span className="font-mono text-foreground">{counts.products}</span> products and <span className="font-mono text-foreground">{counts.collections}</span>{" "}
          collections now. Changes you make in Shopify also come in by themselves.
        </p>
      )}
      {view ? (
        <SyncCard initial={view} gate={gate} canReconnect={canReconnect} title="Products from Shopify" />
      ) : (
        <p className="rounded-card border border-border px-4 py-3 text-sm" role="alert">
          We couldn't check the sync just now. Reload the page to try again.
        </p>
      )}
    </div>
  );
}
