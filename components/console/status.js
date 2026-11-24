// THE status vocabulary (S50): one tone map + one humanizer for every status
// string the consoles render, replacing 12+ local chip maps. Tones are
// semantic (success=emerald, warning=amber, danger=red, info=sky,
// accent=the sparing lime, neutral=zinc) — lime no longer means "success".
// Raw status strings stay available on the chip's title attribute, since
// docs and support threads reference them literally.

export const STATUS_TONE = {
  // orders
  pending_payment: "neutral",
  cod_pending: "warning",
  paid: "success",
  syncing_shopify: "info",
  synced: "success",
  sync_failed: "danger",
  cancelled: "neutral",
  // offer lifecycle
  draft: "neutral",
  scheduled: "info",
  active: "success",
  paused: "warning",
  expired: "neutral",
  // experiments
  running: "success",
  completed: "info",
  // automation runs
  done: "success",
  skipped: "neutral",
  failed: "danger",
  dry_run: "info",
  pending: "warning",
  // returns
  requested: "warning",
  approved: "success",
  rejected: "danger",
  // invitations and grants (support grants, team invites)
  accepted: "success",
  revoked: "neutral",
  // tenants / platform
  suspended: "danger",
  verified: "success",
  uninstalled: "danger",
  unreachable: "danger",
  maintenance: "warning",
  // billing subscriptions
  authenticated: "info",
  grace: "warning",
  past_due: "danger",
  halted: "danger",
  // incidents / privacy / flags
  open: "warning",
  resolved: "success",
  critical: "danger",
  on: "success",
  off: "neutral",
  // CMS
  customized: "accent",
  default: "neutral",
  hidden: "neutral",
  live: "success",
  current: "success",
  stale: "warning",
  // messaging / generic
  queued: "info",
  sent: "success",
  ok: "success",
  warn: "warning",
  error: "danger",
  // AI insights
  proposed: "info",
  applied: "success",
  dismissed: "neutral",
  new: "info",
  // integrations
  connected: "success",
  unconfigured: "neutral",
};

const LABELS = {
  pending_payment: "Pending payment",
  cod_pending: "COD pending",
  syncing_shopify: "Syncing",
  sync_failed: "Sync failed",
  dry_run: "Dry run",
  past_due: "Past due",
};

export function humanizeStatus(status) {
  const s = String(status || "");
  if (LABELS[s]) return LABELS[s];
  const t = s.replaceAll("_", " ").replaceAll("-", " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const statusTone = (status) => STATUS_TONE[String(status || "")] || "neutral";
