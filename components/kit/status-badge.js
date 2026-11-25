import { Badge } from "@/components/ui/badge";

// A domain state as a plain word and a status tone (docs/UI.md "Components":
// StatusBadge). One table per kind; a state the table doesn't know shows
// "Unknown" in the muted tone rather than a raw code.
//   order: orders.status (lib/orders.js ORDER_STATUS)
//   offer, bundle: offerState() below (enabled and the schedule window)
//   media: live | archived (media.archived_at)
//   sync: runState() in lib/admin/sync-view.js
//   theme: a look's use (Phase 5): live | draft (lib/themes/packages.js inUse)
export const STATUS_WORDS = Object.freeze({
  order: Object.freeze({
    pending_payment: ["Awaiting payment", "warning"],
    cod_pending: ["Cash on delivery", "info"],
    paid: ["Paid", "info"],
    syncing_shopify: ["Sending to Shopify", "info"],
    synced: ["In Shopify", "success"],
    sync_failed: ["Shopify push failed", "danger"],
    cancelled: ["Cancelled", "muted"],
  }),
  offer: Object.freeze({
    live: ["Live", "success"],
    scheduled: ["Scheduled", "info"],
    ended: ["Ended", "muted"],
    off: ["Off", "muted"],
  }),
  bundle: Object.freeze({
    live: ["Live", "success"],
    scheduled: ["Scheduled", "info"],
    ended: ["Ended", "muted"],
    off: ["Off", "muted"],
    // Phase 8 line 5: lib/admin/schedule.js offerScheduleStatus on a bundle row
    draft: ["Draft", "muted"],
    paused: ["Off", "muted"],
    active: ["Live", "success"],
    expired: ["Ended", "muted"],
  }),
  media: Object.freeze({
    live: ["In use", "success"],
    archived: ["Archived", "muted"],
  }),
  sync: Object.freeze({
    none: ["Not synced yet", "muted"],
    running: ["Syncing", "info"],
    retrying: ["Retrying", "warning"],
    stalled: ["Stalled", "warning"],
    failed: ["Failed", "danger"],
    complete: ["Up to date", "success"],
  }),
  theme: Object.freeze({
    live: ["Live", "success"],
    draft: ["In your draft", "warning"],
  }),
});

// An offer's or bundle's state from its row: { enabled, starts_at, ends_at }.
export function offerState({ enabled, starts_at = null, ends_at = null } = {}, nowMs = Date.now()) {
  if (!enabled) return "off";
  const end = Date.parse(ends_at || "");
  if (Number.isFinite(end) && end <= nowMs) return "ended";
  const start = Date.parse(starts_at || "");
  if (Number.isFinite(start) && start > nowMs) return "scheduled";
  return "live";
}

export function statusWords(kind, status) {
  const [label, tone] = STATUS_WORDS[kind]?.[status] || ["Unknown", "muted"];
  return { label, tone };
}

export function StatusBadge({ kind, status, className, ...props }) {
  const { label, tone } = statusWords(kind, status);
  return (
    <Badge {...props} variant={tone} data-kit="status-badge" data-status={status} className={className}>
      {label}
    </Badge>
  );
}
