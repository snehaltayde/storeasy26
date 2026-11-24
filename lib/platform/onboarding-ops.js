// Phase 1 line 8: the operator's "Signups & onboarding" screen
// (docs/plans/phase-1.md, Line 8). Node only; every caller has already passed
// platformOperator() (lib/platform/admin-auth.js).
//
// A subject is a signup until its store exists, then the store: one row each.
//   listOnboarding({ view, stuckHours, q, sort, cursor, now })
//       -> { rows, next, counts }   50 rows, keyset cursor; ids first, then
//       only that page is enriched (run step, note, support access)
//   onboardingSubject(subject, { now }) -> the detail sheet (store steps read live)
//   resumeForSubject / resendSignupCode / sendSigninHelp / sendOwnerInvite /
//   openSupportAccess / revokeSupportAccess / releaseSignupAddress / addOperatorNote
//       (subject, opts, operator) -> { ok, ... } | { error, status }
//       Each success writes exactly one audit row naming the operator; each
//       refusal says what to do next. No answer carries a token or a link:
//       sign-in help and owner invites are mailed to an address on file.
import { randomBytes } from "node:crypto";
import { platformDb, getTenant } from "./control.js";
import { audit } from "./audit.js";
import { createInvite, countOwners, loginThrottle } from "./identity.js";
import { sendPlatformMail } from "./platform-mail.js";
import { createSupportGrant, revokeSupportGrant } from "./support.js";
import { scrubSecrets } from "./turso-api.js";
import { slog } from "../log.js";

export const PAGE_SIZE = 50;
export const VIEWS = Object.freeze(["attention", "signup", "closed", "open", "lapsed", "all"]);
export const STUCK_HOURS = Object.freeze([1, 6, 24, 72]);
export const SORTS = Object.freeze(["stuck", "newest"]);
export const HELP_LIMIT = Object.freeze({ limit: 5, windowMs: 60 * 60 * 1000 });
export const NOTE_MAX = 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LAPSE_AFTER_MS = 24 * 60 * 60 * 1000;

export const opsClock = { now: () => Date.now() };
const iso = (ms) => new Date(ms).toISOString();
const db = () => platformDb();
const rows = async (sql, args = []) => (await db().execute({ sql, args })).rows.map((r) => ({ ...r }));
const one = async (sql, args = []) => (await rows(sql, args))[0] ?? null;
const refuse = (error, status = 409) => ({ error, status });
const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

// ---- the subject query ---------------------------------------------------------

// Every subject with the columns the views, search and sort need. ?1 = now,
// ?2 = the lapse cutoff (now - 24 h). A signup whose store exists is carried
// by the store's row (its latest signup).
const SUBJECTS = `
WITH sg AS (
  SELECT s.*,
    CASE WHEN s.status IN ('failed','verified','provisioning') AND (s.failure_kind = 'lapsed' OR s.expires_at <= ?2 OR (s.user_id IS NULL AND s.password_hash IS NULL)) THEN 1 ELSE 0 END AS lapsed,
    CASE WHEN s.status IN ('pending','existing') AND s.expires_at <= ?1 THEN 'expired' ELSE s.status END AS shown_status
  FROM signups s
),
subj AS (
  SELECT 'signup' AS kind, s.id AS id, 'signup:' || s.id AS k, s.shown_status AS status, s.failure_kind AS failure_kind, s.lapsed AS lapsed,
    NULL AS tenant_status, NULL AS open, s.name AS who_name, s.email AS who_email, '' AS owners,
    s.store_name AS store_name, s.slug AS slug, s.created_at AS created_at,
    COALESCE(s.updated_at, s.created_at) AS since, 1 AS since_exact, 0 AS problem, NULL AS current_step
  FROM sg s
  WHERE NOT (s.tenant_id IS NOT NULL AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = s.tenant_id))
  UNION ALL
  SELECT 'tenant', t.id, 'tenant:' || t.id, COALESCE(CASE WHEN s.status IN ('verified','provisioning','failed') THEN s.status END, 'store'),
    s.failure_kind, COALESCE(s.lapsed, 0), t.status, p.open, s.name, s.email,
    COALESCE((SELECT group_concat(COALESCE(u.name, '') || ' <' || u.email || '>', ', ') FROM memberships m JOIN users u ON u.id = m.user_id
              WHERE m.tenant_id = t.id AND m.role = 'owner'), ''),
    t.name, t.id, t.created_at,
    COALESCE(CASE WHEN s.status IN ('verified','provisioning','failed') THEN s.updated_at END, p.step_since, t.created_at),
    COALESCE(p.step_since_exact, CASE WHEN p.tenant_id IS NULL THEN 1 ELSE 0 END),
    CASE WHEN p.check_error IS NOT NULL OR instr(COALESCE(p.steps, ''), '"problem"') > 0 THEN 1 ELSE 0 END, p.current_step
  FROM tenants t
  LEFT JOIN onboarding_progress p ON p.tenant_id = t.id
  LEFT JOIN sg s ON s.id = (SELECT id FROM signups WHERE tenant_id = t.id ORDER BY created_at DESC LIMIT 1)
),
v AS (
  SELECT subj.*,
    CASE
      WHEN status = 'failed' AND lapsed = 0 THEN 1
      WHEN status IN ('verified','provisioning') AND lapsed = 0 AND since <= ?3 THEN 1
      WHEN kind = 'tenant' AND status = 'store' AND tenant_status = 'active' AND COALESCE(open, 0) != 1 AND (problem = 1 OR since <= ?3) THEN 1
      ELSE 0 END AS v_attention,
    CASE WHEN kind = 'signup' AND status IN ('pending','existing','verified','provisioning','failed') AND lapsed = 0 THEN 1 ELSE 0 END AS v_signup,
    CASE WHEN kind = 'tenant' AND COALESCE(open, 0) != 1 THEN 1 ELSE 0 END AS v_closed,
    CASE WHEN kind = 'tenant' AND open = 1 THEN 1 ELSE 0 END AS v_open,
    CASE WHEN kind = 'signup' AND (status IN ('expired','superseded','released') OR lapsed = 1) THEN 1 ELSE 0 END AS v_lapsed
  FROM subj
)`;

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function searchClause(q) {
  const text = String(q || "").trim().slice(0, 200);
  if (!text) return { sql: "", args: [] };
  if (text.includes("@")) {
    const email = text.toLowerCase();
    return {
      sql: ` AND (lower(who_email) = ? OR (kind = 'tenant' AND EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = v.id AND m.role = 'owner' AND u.email = ?)))`,
      args: [email, email],
    };
  }
  const like = `%${likeEscape(text.toLowerCase())}%`;
  return {
    sql: ` AND (lower(store_name) LIKE ? ESCAPE '\\' OR lower(slug) LIKE ? ESCAPE '\\' OR lower(COALESCE(who_name, '')) LIKE ? ESCAPE '\\' OR lower(owners) LIKE ? ESCAPE '\\')`,
    args: [like, like, like, like],
  };
}

const encodeCursor = (v, k) => Buffer.from(JSON.stringify([v, k])).toString("base64url");
function decodeCursor(c) {
  if (!c) return null;
  const v = parseJson(Buffer.from(String(c), "base64url").toString("utf8"), null);
  return Array.isArray(v) && v.length === 2 && typeof v[1] === "string" ? v : null;
}

export function listParams(input = {}) {
  const view = VIEWS.includes(input.view) ? input.view : "attention";
  const stuckHours = STUCK_HOURS.includes(Number(input.stuck)) ? Number(input.stuck) : 24;
  const sort = SORTS.includes(input.sort) ? input.sort : "stuck";
  return { view, stuckHours, sort, q: String(input.q || "").trim().slice(0, 200), cursor: input.cursor || null };
}

export async function onboardingCounts({ stuckHours = 24, q = "", now = opsClock.now() } = {}) {
  const s = searchClause(q);
  const r = await one(
    `${SUBJECTS} SELECT SUM(v_attention) AS attention, SUM(v_signup) AS signup, SUM(v_closed) AS closed, SUM(v_open) AS open, SUM(v_lapsed) AS lapsed, COUNT(*) AS "all" FROM v WHERE 1=1${s.sql}`,
    [iso(now), iso(now - LAPSE_AFTER_MS), iso(now - stuckHours * 3600_000), ...s.args],
  );
  return Object.fromEntries(VIEWS.map((k) => [k, Number(r?.[k] ?? 0)]));
}

export async function listOnboarding(input = {}, { now = opsClock.now() } = {}) {
  const { view, stuckHours, sort, q, cursor } = listParams(input);
  const s = searchClause(q);
  const col = sort === "newest" ? "created_at" : "since";
  const dir = sort === "newest" ? "DESC" : "ASC";
  const cmp = sort === "newest" ? "<" : ">";
  const cur = decodeCursor(cursor);
  const where = `${view === "all" ? "" : ` AND v_${view} = 1`}${s.sql}${cur ? ` AND (COALESCE(${col}, '') ${cmp} ? OR (COALESCE(${col}, '') = ? AND k ${cmp} ?))` : ""}`;
  const page = await rows(
    `${SUBJECTS} SELECT kind, id, k, status, failure_kind, lapsed, tenant_status, open, who_name, who_email, owners, store_name, slug, created_at, since, since_exact, current_step, v_attention
     FROM v WHERE 1=1${where} ORDER BY COALESCE(${col}, '') ${dir}, k ${dir} LIMIT ${PAGE_SIZE + 1}`,
    [iso(now), iso(now - LAPSE_AFTER_MS), iso(now - stuckHours * 3600_000), ...s.args, ...(cur ? [cur[0], cur[0], cur[1]] : [])],
  );
  const more = page.length > PAGE_SIZE;
  const list = page.slice(0, PAGE_SIZE);
  const last = list[list.length - 1];
  return {
    rows: await enrich(list, now),
    next: more && last ? encodeCursor(last[col] ?? "", last.k) : null,
    counts: await onboardingCounts({ stuckHours, q, now }),
    params: { view, stuckHours, sort, q },
  };
}

// ---- words the client shows (kept as codes; components/platform/onboarding/onboardingWords.js words them) ----

function statusCode(r) {
  if (r.kind === "tenant" && r.status === "store") return r.tenant_status !== "active" ? "suspended" : r.open === 1 ? "open" : "closed";
  if (r.status === "failed") return r.lapsed ? "failed_lapsed" : r.failure_kind === "needs_operator" ? "failed_needs_us" : "failed_retries";
  if (["verified", "provisioning"].includes(r.status)) return r.lapsed ? "failed_lapsed" : "setting_up";
  if (r.status === "pending") return "waiting_code";
  if (r.status === "existing") return "has_account";
  if (r.status === "released") return "address_freed";
  return ["superseded", "expired", "done"].includes(r.status) ? r.status : "unknown";
}

async function enrich(list, now) {
  if (!list.length) return [];
  const signupIds = [];
  const tenantIds = [];
  for (const r of list) (r.kind === "signup" ? signupIds : tenantIds).push(r.id);
  const marks = (n) => Array(n).fill("?").join(",");
  // the signups behind the rows (a store row's latest signup)
  const sg = await rows(
    `SELECT id, tenant_id, provision_run_id, provision_attempts, next_attempt_at, alerted_kinds, error FROM signups
     WHERE id IN (${marks(signupIds.length || 1)}) OR (tenant_id IN (${marks(tenantIds.length || 1)}) AND id = (SELECT id FROM signups s2 WHERE s2.tenant_id = signups.tenant_id ORDER BY created_at DESC LIMIT 1))`,
    [...(signupIds.length ? signupIds : [""]), ...(tenantIds.length ? tenantIds : [""])],
  );
  const bySignup = new Map(sg.map((s) => [s.id, s]));
  const byTenantSignup = new Map(sg.filter((s) => s.tenant_id).map((s) => [s.tenant_id, s]));
  const runIds = [...new Set(sg.map((s) => s.provision_run_id).filter(Boolean))];
  const runs = runIds.length ? await rows(`SELECT id, status, steps FROM provision_runs WHERE id IN (${marks(runIds.length)})`, runIds) : [];
  const runById = new Map(runs.map((r) => [r.id, r]));
  const progress = tenantIds.length ? await rows(`SELECT tenant_id, supported, open, current_step, done_count, steps, checked_at, check_error FROM onboarding_progress WHERE tenant_id IN (${marks(tenantIds.length)})`, tenantIds) : [];
  const progressBy = new Map(progress.map((p) => [p.tenant_id, p]));
  const subjects = list.map((r) => r.k);
  const notes = await rows(
    `SELECT subject, body, operator_id, created_at FROM operator_notes n WHERE subject IN (${marks(subjects.length)})
       AND created_at = (SELECT MAX(created_at) FROM operator_notes n2 WHERE n2.subject = n.subject)`,
    subjects,
  );
  const noteBy = new Map(notes.map((n) => [n.subject, n]));
  const grants = tenantIds.length
    ? await rows(`SELECT tenant_id, MAX(expires_at) AS until FROM support_grants WHERE tenant_id IN (${marks(tenantIds.length)}) AND revoked_at IS NULL AND expires_at > ? GROUP BY tenant_id`, [...tenantIds, iso(now)])
    : [];
  const grantBy = new Map(grants.map((g) => [g.tenant_id, g.until]));

  return list.map((r) => {
    const s = r.kind === "signup" ? bySignup.get(r.id) : byTenantSignup.get(r.id);
    const run = s?.provision_run_id ? runById.get(s.provision_run_id) : null;
    const runSteps = run ? parseJson(run.steps, []) : [];
    const failedStep = runSteps.find((x) => x.status === "failed") || runSteps.find((x) => x.status !== "done") || null;
    const p = r.kind === "tenant" ? progressBy.get(r.id) : null;
    const pSteps = p ? parseJson(p.steps, []) : [];
    const cur = p?.current_step ? pSteps.find((x) => x.id === p.current_step) : null;
    const note = noteBy.get(r.k);
    return {
      subject: r.k,
      kind: r.kind,
      id: r.id,
      who: r.kind === "tenant" && r.owners ? { owners: r.owners } : { name: r.who_name || null, email: r.who_email || null },
      store: { name: r.store_name, address: r.slug },
      status: statusCode(r),
      attention: Boolean(r.v_attention),
      provision: s && ["verified", "provisioning", "failed"].includes(r.status)
        ? { step: failedStep?.name || null, attempts: Number(s.provision_attempts) || 0, nextRetryAt: s.next_attempt_at || null, alerted: Boolean(s.alerted_kinds) }
        : null,
      onboarding: p
        ? { supported: Boolean(p.supported), step: p.current_step || null, stepNumber: p.current_step ? ["connect", "import", "brand", "open"].indexOf(p.current_step) + 1 : null, state: cur?.state || null, problem: cur?.problem || p.check_error || null, doneCount: Number(p.done_count) || 0, checkedAt: p.checked_at }
        : null,
      since: r.since || null,
      sinceExact: Boolean(r.since_exact),
      createdAt: r.created_at || null,
      note: note ? { text: note.body.slice(0, 140), at: note.created_at } : null,
      supportUntil: grantBy.get(r.id) || null,
    };
  });
}

// ---- the detail sheet ---------------------------------------------------------------

export function parseSubject(subject) {
  const m = /^(signup|tenant):([A-Za-z0-9_-]{1,80})$/.exec(String(subject || ""));
  return m ? { kind: m[1], id: m[2], key: `${m[1]}:${m[2]}` } : null;
}

const signupById = (id) => one("SELECT * FROM signups WHERE id = ?", [id]);
const latestSignupFor = (tenantId) => one("SELECT * FROM signups WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1", [tenantId]);

// What the sheet may show of a signup: no hashes, no ip, no browser cookie.
function signupFacts(s, now) {
  const lapsed = ["failed", "verified", "provisioning"].includes(s.status) && (s.failure_kind === "lapsed" || s.expires_at <= iso(now - LAPSE_AFTER_MS) || (!s.user_id && !s.password_hash));
  const shown = ["pending", "existing"].includes(s.status) && s.expires_at <= iso(now) ? "expired" : s.status;
  return {
    id: s.id,
    status: statusCode({ kind: "signup", status: shown, failure_kind: s.failure_kind, lapsed }),
    lapsed,
    name: s.name,
    email: s.email,
    storeName: s.store_name,
    address: s.slug,
    createdAt: s.created_at,
    verifiedAt: s.verified_at || null,
    expiresAt: s.expires_at,
    sends: Number(s.sends) || 0,
    provisionAttempts: Number(s.provision_attempts) || 0,
    nextRetryAt: s.next_attempt_at || null,
    failureKind: s.failure_kind || null,
    error: s.error ? scrubSecrets(String(s.error)).slice(0, 300) : null,
    alerted: s.alerted_kinds ? s.alerted_kinds.split(",").filter(Boolean) : [],
    doneAt: s.done_at || null,
    releasedAt: s.released_at || null,
  };
}

async function runFacts(runId) {
  if (!runId) return null;
  const r = await one("SELECT id, status, steps, error, created_at, updated_at FROM provision_runs WHERE id = ?", [runId]);
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    error: r.error ? scrubSecrets(String(r.error)).slice(0, 300) : null,
    steps: parseJson(r.steps, []).map((x) => ({ name: x.name, status: x.status, at: x.at || x.finished_at || x.started_at || null, error: x.error ? scrubSecrets(String(x.error)).slice(0, 300) : null })),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const AUDIT_COLS = "at, actor, actor_kind, action, resource, diff";

export async function onboardingSubject(subject, { now = opsClock.now(), origin = null } = {}) {
  const sub = parseSubject(subject);
  if (!sub) return refuse("Pick a signup or a store from the list.", 400);
  const notes = await rows("SELECT id, body, operator_id, created_at FROM operator_notes WHERE subject = ? ORDER BY created_at DESC LIMIT 100", [sub.key]);
  const noteList = notes.map((n) => ({ id: n.id, text: n.body, operator: n.operator_id, at: n.created_at }));
  if (sub.kind === "signup") {
    const s = await signupById(sub.id);
    if (!s) return refuse("That signup is gone. Reload the list.", 404);
    const mail = await rows("SELECT kind, recipient, status, created_at FROM platform_mail WHERE ref = ? ORDER BY created_at DESC LIMIT 50", [s.id]);
    const auditRows = await rows(`SELECT ${AUDIT_COLS} FROM audit_log WHERE resource = ? OR instr(COALESCE(diff, ''), ?) > 0 ORDER BY at DESC LIMIT 20`, [sub.key, `"signup":"${s.id}"`]);
    const facts = signupFacts(s, now);
    return {
      ok: true,
      subject: sub.key,
      kind: "signup",
      signup: facts,
      run: await runFacts(s.provision_run_id),
      mail: mail.map((m) => ({ kind: m.kind, recipient: m.recipient, status: m.status, at: m.created_at })),
      notes: noteList,
      audit: auditRows.map(auditOut),
      actions: signupActions(facts),
    };
  }
  const tenant = await getTenant(sub.id, { fresh: true });
  if (!tenant) return refuse("That store is gone. Reload the list.", 404);
  const s = await latestSignupFor(tenant.id);
  const { snapshotTenant } = await import("../onboarding/snapshot.js");
  const live = tenant.status === "active" ? await snapshotTenant(tenant, { now }) : { ok: false, error: "The store is suspended, so its steps aren't read." };
  const members = await rows(
    "SELECT u.email AS email, u.name AS name, m.role AS role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? ORDER BY m.role, u.email",
    [tenant.id],
  );
  const invites = await rows(
    "SELECT email, role, expires_at FROM invitations WHERE tenant_id = ? AND kind = 'invite' AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 20",
    [tenant.id, iso(now)],
  );
  const refs = [`tenant:${tenant.id}`, ...(s ? [s.id] : [])];
  const mail = await rows(`SELECT kind, recipient, status, created_at FROM platform_mail WHERE ref IN (${refs.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 50`, refs);
  const grants = await rows("SELECT id, operator, reason, created_at, expires_at, revoked_at FROM support_grants WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20", [tenant.id]);
  const auditRows = await rows(`SELECT ${AUDIT_COLS} FROM audit_log WHERE tenant_id = ? OR resource = ? ORDER BY at DESC LIMIT 20`, [tenant.id, sub.key]);
  const owners = members.filter((m) => m.role === "owner");
  const activeGrant = grants.find((g) => !g.revoked_at && g.expires_at > iso(now)) || null;
  const signup = s ? signupFacts(s, now) : null;
  const failedRun = await one("SELECT id FROM provision_runs WHERE tenant_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1", [tenant.id]);
  return {
    ok: true,
    subject: sub.key,
    kind: "tenant",
    store: { id: tenant.id, name: tenant.name, status: tenant.status, address: tenant.domains?.[0] || null },
    signup,
    run: await runFacts(s?.provision_run_id || failedRun?.id || null),
    onboarding: live.ok
      ? { supported: live.model.supported, open: live.model.open, openKnown: live.model.openKnown, current: live.model.current, doneCount: live.model.doneCount, words: live.model.words || null, steps: live.model.steps.map((x) => ({ id: x.id, label: x.label, state: x.state, words: x.words, problem: x.problem || null, blockedBy: x.blockedBy || null })) }
      : { error: live.error },
    members: members.map((m) => ({ email: m.email, name: m.name || null, role: m.role })),
    invites: invites.map((i) => ({ email: i.email, role: i.role, expiresAt: i.expires_at })),
    mail: mail.map((m) => ({ kind: m.kind, recipient: m.recipient, status: m.status, at: m.created_at })),
    grants: grants.map((g) => ({ id: g.id, operator: g.operator, reason: g.reason, at: g.created_at, until: g.expires_at, revokedAt: g.revoked_at || null })),
    notes: noteList,
    audit: auditRows.map(auditOut),
    actions: {
      resume: Boolean((signup && ["failed", "verified", "provisioning"].includes(s.status) && !signup.lapsed) || (!signup && failedRun)),
      signinHelp: owners.length > 0 && tenant.status === "active",
      ownerEmails: owners.map((o) => o.email),
      ownerInvite: owners.length === 0 && Boolean(s?.email),
      inviteEmail: owners.length === 0 ? s?.email || null : null,
      supportAccess: tenant.status === "active",
      activeGrant: activeGrant ? { id: activeGrant.id, until: activeGrant.expires_at } : null,
      consoleUrl: activeGrant ? `${storeOrigin(tenant, origin)}/admin` : null,
    },
  };
}

function auditOut(a) {
  return { at: a.at, actor: a.actor, actorKind: a.actor_kind, action: a.action, resource: a.resource, diff: a.diff ? parseJson(a.diff, null) : null };
}

function signupActions(f) {
  return {
    resume: ["failed_retries", "failed_needs_us", "setting_up"].includes(f.status),
    resendCode: ["waiting_code", "has_account"].includes(f.status),
    release: f.status === "failed_lapsed",
  };
}

// The store's own origin (its first domain), on the protocol and port the
// operator is using now when the domain names no port (a signup's store is
// registered as <slug>.<domain>, like storeOriginFor); otherwise http for a
// local host, https for a real one.
export function storeOrigin(tenant, origin = null) {
  const host = tenant?.domains?.[0];
  if (!host) return null;
  if (origin && !/:\d+$/.test(host)) {
    try {
      const u = new URL(origin);
      return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`;
    } catch {
      // no usable origin: fall through
    }
  }
  const local = /(^|\.)localhost(:|$)|^127\.0\.0\.1|\.test(:|$)/.test(host);
  return `${local && process.env.NODE_ENV !== "production" ? "http" : "https"}://${host}`;
}

// ---- help actions --------------------------------------------------------------

const auditOp = (operator, action, { tenantId = null, resource, diff }) => audit({ actor: { kind: "operator", id: String(operator.id) }, action, tenantId, resource, diff });
const help = (action, subject) => slog("operator_help", { action, subject });

// Resume provisioning: a signup's run through its job (the caller runs the job
// in after()); an operator-made store's failed run through runProvision.
export async function resumeForSubject(subject, { origin = null } = {}, operator) {
  const sub = parseSubject(subject);
  if (!sub) return refuse("Pick a signup or a store from the list.", 400);
  const s = sub.kind === "signup" ? await signupById(sub.id) : await latestSignupFor(sub.id);
  if (sub.kind === "signup" && !s) return refuse("That signup is gone. Reload the list.", 404);
  if (s) {
    if (s.status === "done") return refuse("This signup is already done: its store is made. Help from the store's row instead.");
    if (!["failed", "verified", "provisioning"].includes(s.status)) return refuse("Nothing to resume: the founder hasn't confirmed their email yet. Resend the email code instead.");
    const SP = await import("./signup-provision.js");
    if (SP.signupLapsed(s) || s.failure_kind === "lapsed") return refuse("This signup has lapsed, so it can't be resumed. Free its address and ask the founder to start again.");
    let q;
    if (s.provision_run_id) q = await SP.resumeSignupRun(s.provision_run_id);
    else {
      const { storeOriginFor } = await import("./signup.js");
      const c = await SP.claimSignupProvision(s, { siteUrl: origin ? storeOriginFor(s.slug, origin) : null });
      q = { signupId: s.id, jobId: c.jobId || s.job_id || null };
      if (c.already === "provisioning" && s.job_id) {
        const { makeJobDue } = await import("./jobs.js");
        await makeJobDue(s.job_id);
      }
    }
    if (!q?.jobId) return refuse("This signup has no setup job to resume. Add a note and check the Provisioning panel.");
    await auditOp(operator, "tenant.provision", { tenantId: s.tenant_id || null, resource: `run:${s.provision_run_id || "none"}`, diff: { resumed: true, via: "onboarding", signup: s.id } });
    help("resume", sub.key);
    return { ok: true, queued: true, jobId: q.jobId };
  }
  const run = await one("SELECT id FROM provision_runs WHERE tenant_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1", [sub.id]);
  if (!run) return refuse("Nothing to resume: this store's setup isn't failed.");
  const { runProvision } = await import("./provision.js");
  const r = await runProvision({ dbToken: null }, { resumeRunId: run.id });
  await auditOp(operator, "tenant.provision", { tenantId: sub.id, resource: `run:${run.id}`, diff: { resumed: true, via: "onboarding", status: r.run?.status || null } });
  help("resume", sub.key);
  return { ok: true, status: r.run?.status || null, failedStep: r.failedStep || null };
}

export async function resendSignupCode(subject, _opts, operator) {
  const sub = parseSubject(subject);
  if (sub?.kind !== "signup") return refuse("Only a signup waiting for its email code can get a new one.", 400);
  const s = await signupById(sub.id);
  if (!s) return refuse("That signup is gone. Reload the list.", 404);
  if (!["pending", "existing"].includes(s.status)) return refuse("This signup isn't waiting for an email code, so there is nothing to resend.");
  const { resendCodeById } = await import("./signup.js");
  const r = await resendCodeById(s.id);
  if (!r.ok) return { error: r.error, status: r.status, ...(r.retryAfter ? { retryAfter: r.retryAfter } : {}) };
  await auditOp(operator, "signup.code_resent", { resource: sub.key, diff: { via: "operator-onboarding" } });
  help("resend_code", sub.key);
  return { ok: true, note: "A new code is on its way. It works only in the browser the founder signed up in." };
}

async function storeForHelp(subject) {
  const sub = parseSubject(subject);
  if (sub?.kind !== "tenant") return { refusal: refuse("This works on a store's row. The signup has no store yet.", 400) };
  const tenant = await getTenant(sub.id, { fresh: true });
  if (!tenant) return { refusal: refuse("That store is gone. Reload the list.", 404) };
  return { sub, tenant };
}

async function helpThrottled(tenantId) {
  return (await loginThrottle(`operator-help:${tenantId}`, HELP_LIMIT)).blocked;
}
const THROTTLED = "This store has had 5 help emails in the last hour. Wait an hour, then try again.";
const MAIL_FAILED = "The email didn't go out. Check the mail provider, then try again.";

export async function sendSigninHelp(subject, { email, origin = null } = {}, operator) {
  const { sub, tenant, refusal } = await storeForHelp(subject);
  if (refusal) return refusal;
  if (tenant.status !== "active") return refuse("This store is suspended. Reactivate it first.");
  const owners = await rows("SELECT u.email AS email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.role = 'owner' AND u.status = 'active' ORDER BY u.email", [tenant.id]);
  if (!owners.length) return refuse("This store has no owner yet. Email an owner invite instead.");
  const wanted = String(email || "").trim().toLowerCase();
  const to = wanted ? owners.find((o) => o.email === wanted)?.email : owners.length === 1 ? owners[0].email : null;
  if (!to) return refuse(wanted ? "That address isn't an owner of this store. Pick one of the owners on file." : "Pick which owner to email.", 400);
  const base = storeOrigin(tenant, origin);
  if (!base) return refuse("This store has no address yet. Add a domain in the Tenants panel first.");
  if (await helpThrottled(tenant.id)) return refuse(THROTTLED, 429);
  const { token } = await createInvite({ email: to, tenantId: tenant.id, kind: "reset", ttlMs: RESET_TTL_MS });
  const loginUrl = `${base}/admin/login`;
  const mail = await sendPlatformMail({
    kind: "operator_signin_help",
    to,
    ref: `tenant:${tenant.id}`,
    subject: `Signing in to ${tenant.name} on Storeasy`,
    text: `Storeasy support is helping you sign in to ${tenant.name}.\n\nSign in here: ${loginUrl}\n\nIf you've forgotten your password, set a new one here. The link works once, for one hour:\n${base}/admin/reset?token=${token}\n\nIf you didn't ask Storeasy for help, ignore this email: nothing has changed.`,
  });
  await auditOp(operator, "founder.signin_help_sent", { tenantId: tenant.id, resource: sub.key, diff: { mail: mail.status } });
  help("signin_help", sub.key);
  if (!mail.ok) return refuse(MAIL_FAILED, 502);
  return { ok: true, mail: mail.status, sentTo: to };
}

export async function sendOwnerInvite(subject, { origin = null } = {}, operator) {
  const { sub, tenant, refusal } = await storeForHelp(subject);
  if (refusal) return refusal;
  if (tenant.status !== "active") return refuse("This store is suspended. Reactivate it first.");
  if ((await countOwners(tenant.id)) > 0) return refuse("This store already has an owner. Send sign-in help instead.");
  const s = await latestSignupFor(tenant.id);
  const to = s?.email ? String(s.email).toLowerCase() : null;
  if (!to) return refuse("There's no email on file for this store's founder. Add a note and reach them another way.");
  const base = storeOrigin(tenant, origin);
  if (!base) return refuse("This store has no address yet. Add a domain in the Tenants panel first.");
  if (await helpThrottled(tenant.id)) return refuse(THROTTLED, 429);
  const t = opsClock.now();
  // only one live owner invite for this email: earlier unused ones expire now
  await db().execute({
    sql: "UPDATE invitations SET expires_at = ? WHERE tenant_id = ? AND email = ? AND kind = 'invite' AND role = 'owner' AND accepted_at IS NULL AND expires_at > ?",
    args: [iso(t), tenant.id, to, iso(t)],
  });
  const { token } = await createInvite({ email: to, tenantId: tenant.id, role: "owner", invitedBy: String(operator.id), ttlMs: INVITE_TTL_MS });
  const mail = await sendPlatformMail({
    kind: "operator_owner_invite",
    to,
    ref: `tenant:${tenant.id}`,
    subject: `You're the owner of ${tenant.name} on Storeasy`,
    text: `Storeasy support has invited you to own ${tenant.name}'s store console.\n\nAccept here and choose your password. The link works once, for 7 days:\n${base}/admin/accept-invite?token=${token}\n\nIf you didn't expect this, ignore this email.`,
  });
  await auditOp(operator, "team.invite_created", { tenantId: tenant.id, resource: sub.key, diff: { role: "owner", via: "operator-onboarding", mail: mail.status } });
  help("owner_invite", sub.key);
  if (!mail.ok) return refuse(MAIL_FAILED, 502);
  return { ok: true, mail: mail.status, sentTo: to };
}

export async function openSupportAccess(subject, { reason, hours, origin = null } = {}, operator) {
  const { sub, tenant, refusal } = await storeForHelp(subject);
  if (refusal) return refusal;
  if (tenant.status !== "active") return refuse("This store is suspended, so its console can't be opened.");
  const why = String(reason || "").trim();
  if (why.length < 5 || why.length > 500) return refuse("Say why you need access, in 5 to 500 characters.", 400);
  const h = Number(hours);
  if (!Number.isInteger(h) || h < 1 || h > 72) return refuse("Choose between 1 and 72 hours.", 400);
  const g = await createSupportGrant({ tenantId: tenant.id, reason: why, hours: h, operator: String(operator.id) });
  help("support_open", sub.key);
  return { ok: true, grant: { id: g.id, until: g.expiresAt }, consoleUrl: `${storeOrigin(tenant, origin)}/admin` };
}

export async function revokeSupportAccess(subject, { grant } = {}, operator) {
  const { sub, tenant, refusal } = await storeForHelp(subject);
  if (refusal) return refusal;
  const g = await one("SELECT id FROM support_grants WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL", [String(grant || ""), tenant.id]);
  if (!g) return refuse("That support access is already closed. Reload the sheet.");
  await revokeSupportGrant(g.id, { operator: String(operator.id) });
  help("support_revoke", sub.key);
  return { ok: true };
}

// Whether the run behind this address made a database that still exists.
// -> { db: "none" | "absent" } | { refusal }
export async function signupDatabaseGone(slug) {
  const runs = await rows("SELECT id, refs, params FROM provision_runs WHERE tenant_id = ?", [slug]);
  const made = runs.map((r) => ({ refs: parseJson(r.refs, {}), params: parseJson(r.params, {}) })).filter((r) => r.refs.dbUrl || r.refs.dbCreateRequestedAt || r.refs.dbCreated);
  if (!made.length) return { db: "none" };
  const CANT = "We couldn't check whether this signup's database is gone, so the address stays held. Try again later.";
  for (const r of made) {
    const driver = r.params.dbDriver || "turso";
    if (driver === "file") {
      const url = String(r.refs.dbUrl || "");
      if (!url.startsWith("file:")) return { refusal: refuse(CANT, 503) };
      const { access } = await import("node:fs/promises");
      const exists = await access(url.slice(5)).then(() => true, () => false);
      if (exists) return { refusal: refuse("This signup's database file still exists. Delete it first, then free the address.") };
      continue;
    }
    if (driver !== "turso-api") return { refusal: refuse(CANT, 503) };
    const { tursoApi, tursoApiConfigured } = await import("./turso-api.js");
    if (!tursoApiConfigured()) return { refusal: refuse(CANT, 503) };
    const { tenantDbName } = await import("./provision.js");
    try {
      await tursoApi().getDatabase(tenantDbName(slug));
      return { refusal: refuse("This signup's database still exists at the hosting provider. Delete it there first, then free the address.") };
    } catch (e) {
      if (e?.status !== 404) return { refusal: refuse(CANT, 503) };
    }
  }
  return { db: "absent" };
}

export async function releaseSignupAddress(subject, { notify = false } = {}, operator) {
  const sub = parseSubject(subject);
  if (sub?.kind !== "signup") return refuse("Only a lapsed signup's address can be freed.", 400);
  const s = await signupById(sub.id);
  if (!s) return refuse("That signup is gone. Reload the list.", 404);
  if (s.status === "provisioning") return refuse("This signup is still being set up. Wait for it to finish or fail, then try again.");
  const SP = await import("./signup-provision.js");
  const lapsed = ["failed", "verified"].includes(s.status) && (s.failure_kind === "lapsed" || SP.signupLapsed(s));
  if (!lapsed) return refuse(s.status === "released" ? "This address is already free." : "This signup hasn't lapsed, so its address stays with it. Resume it or wait for it to lapse.");
  if (await one("SELECT 1 AS x FROM tenants WHERE id = ?", [s.slug])) return refuse("A store uses this address, so it can't be freed.");
  const gone = await signupDatabaseGone(s.slug);
  if (gone.refusal) return gone.refusal;
  const t = opsClock.now();
  const r = await db().execute({
    sql: "UPDATE signups SET status = 'released', released_at = ?, released_by = ?, password_hash = NULL, code_hash = NULL, updated_at = ? WHERE id = ? AND status = ? RETURNING id",
    args: [iso(t), String(operator.id), iso(t), s.id, s.status],
  });
  if (!r.rows.length) return refuse("This signup changed while you were looking. Reload the sheet.");
  let notified = false;
  if (notify) {
    const { platformSiteHosts } = await import("../platform-site.js");
    const site = platformSiteHosts()[0];
    const mail = await sendPlatformMail({
      kind: "operator_start_again",
      to: s.email,
      ref: s.id,
      subject: "Start your Storeasy store again",
      text: `Your Storeasy signup for ${s.store_name} lapsed before your store was made, so nothing was created.\n\nYou can start again${site ? ` at ${/localhost|\.test(:|$)/.test(site) ? "http" : "https"}://${site}/signup` : " on the Storeasy sign-up page"}. The address you chose is free again, if it's still the one you want.`,
    });
    notified = mail.ok;
  }
  await auditOp(operator, "signup.address_released", { resource: sub.key, diff: { slug: s.slug, db: gone.db, notified } });
  help("release", sub.key);
  return { ok: true, notified };
}

export async function addOperatorNote(subject, { text } = {}, operator) {
  const sub = parseSubject(subject);
  if (!sub) return refuse("Pick a signup or a store from the list.", 400);
  const body = String(text ?? "").trim();
  if (body.length < 1 || body.length > NOTE_MAX) return refuse(`Write a note of 1 to ${NOTE_MAX} characters.`, 400);
  const exists = sub.kind === "signup" ? await one("SELECT 1 AS x FROM signups WHERE id = ?", [sub.id]) : await one("SELECT 1 AS x FROM tenants WHERE id = ?", [sub.id]);
  if (!exists) return refuse("That signup or store is gone. Reload the list.", 404);
  const id = `opn_${randomBytes(8).toString("hex")}`;
  const at = iso(opsClock.now());
  await db().execute({ sql: "INSERT INTO operator_notes (id, subject, body, operator_id, created_at) VALUES (?, ?, ?, ?, ?)", args: [id, sub.key, body, String(operator.id), at] });
  await auditOp(operator, "operator.note_added", { tenantId: sub.kind === "tenant" ? sub.id : null, resource: sub.key, diff: { subject: sub.key, chars: body.length } });
  help("note", sub.key);
  return { ok: true, note: { id, text: body, operator: String(operator.id), at } };
}

export const ACTIONS = Object.freeze({
  resume: resumeForSubject,
  resend_code: resendSignupCode,
  signin_help: sendSigninHelp,
  owner_invite: sendOwnerInvite,
  support_open: openSupportAccess,
  support_revoke: revokeSupportAccess,
  release: releaseSignupAddress,
  note: addOperatorNote,
});
