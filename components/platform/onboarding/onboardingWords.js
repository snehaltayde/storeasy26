// Phase 1 line 8: the plain words and badge tones for the operator's
// "Signups & onboarding" screen. Pure (no imports), so the suite tests it and
// the client components share it. The API sends codes; the screen says words.

const STATUS = Object.freeze({
  waiting_code: { label: "Waiting for email code", tone: "muted" },
  has_account: { label: "Already has an account", tone: "muted" },
  setting_up: { label: "Setting up", tone: "info" },
  failed_retries: { label: "Failed: retries used up", tone: "danger" },
  failed_needs_us: { label: "Failed: needs us", tone: "danger" },
  failed_lapsed: { label: "Failed: lapsed", tone: "warning" },
  address_freed: { label: "Address freed", tone: "muted" },
  superseded: { label: "Superseded", tone: "muted" },
  expired: { label: "Expired", tone: "muted" },
  done: { label: "Store made", tone: "success" },
  closed: { label: "Closed", tone: "warning" },
  open: { label: "Open", tone: "success" },
  suspended: { label: "Suspended", tone: "danger" },
});

export const statusWords = (code) => STATUS[code] || { label: "Unknown", tone: "muted" };

// line 9: a store an operator created carries this badge (rows' source "operator")
export const sourceLabel = (source) => (source === "operator" ? "Created by Storeasy" : null);

export const VIEW_LABELS = Object.freeze({
  attention: "Needs attention",
  signup: "In signup",
  closed: "Closed stores",
  open: "Open stores",
  lapsed: "Lapsed or freed",
  all: "All",
});

export const STEP_LABELS = Object.freeze({ connect: "Connect Shopify", import: "Import products", brand: "Brand", open: "Open your store" });
export const STEP_STATE_WORDS = Object.freeze({ done: "Done", in_progress: "In progress", ready: "Ready", blocked: "Blocked" });

export const MAIL_KIND_WORDS = Object.freeze({
  signup_code: "Signup code",
  signup_existing: "Already-has-an-account note",
  operator_signin_help: "Sign-in help",
  operator_owner_invite: "Owner invite",
  operator_start_again: "Start-again note",
  operator_store_invite: "Owner invite (store created)",
});

export const PROVISION_STEP_WORDS = Object.freeze({
  create_db: "Creating the database",
  apply_schema: "Applying the schema",
  content_mode: "Setting the editor",
  seed_defaults: "Adding defaults",
  register_tenant: "Registering the store",
  init_billing: "Starting billing",
  record_onboarding: "Recording onboarding",
});

// "2 d 4 h", "3 h 10 min", "5 min"
export function stuckFor(sinceIso, now = Date.now()) {
  const ms = Math.max(0, now - Date.parse(sinceIso));
  const mins = Math.floor(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  return `${Math.max(m, 1)} min`;
}

export function stuckLabel(row, now = Date.now()) {
  if (!row?.since) return null;
  return `stuck ${row.sinceExact ? "" : "at least "}${stuckFor(row.since, now)}`;
}

export function when(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// the sheet's lists: setup-run step states, mail delivery, team roles and who
// did an audited thing, in words (unknown codes fall back to the code)
export const RUN_STEP_WORDS = Object.freeze({
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  running: { label: "Running", tone: "info" },
  pending: { label: "Waiting", tone: "muted" },
});
export const MAIL_STATUS_WORDS = Object.freeze({ sent: "Sent", queued: "Sending", mock: "Logged only (no mail provider)", failed: "Not sent" });
export const ROLE_WORDS = Object.freeze({ owner: "Owner", admin: "Admin", staff: "Staff", support: "Support" });
export const ACTOR_KIND_WORDS = Object.freeze({ operator: "Operator", member: "Member", system: "System", bootstrap: "Setup" });
