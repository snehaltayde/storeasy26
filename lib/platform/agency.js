// Agency platform (Session 48 / BE28). Plain-Node, control-plane backed.
//
// The boundary rules, enforced structurally:
//   · commercial status (verified / referral-eligible / commission rate) is
//     INDEPENDENT of client access — access exists only through grants the
//     CLIENT accepted, one store at a time, never role "owner";
//   · a grant invite binds to the client's email and expires; acceptance
//     happens inside the client's own console by a matching, team-managing
//     actor — a wrong recipient or a stale token creates nothing;
//   · every agency operation re-reads the grant (revocation is immediate);
//   · kits are SCRUBBED structure (no customer data, secrets, domains,
//     media paths, catalog ids) and apply as DRAFTS on the destination;
//   · approvals bind to an immutable content hash — a changed draft makes
//     every earlier approval visibly stale;
//   · commissions derive 1:1 from the billing-event ledger (UNIQUE event id:
//     revenue never counts twice, refunds reverse exactly once).
import { platformDb, getTenant } from "./control.js";
import { runAsTenant } from "./ops.js";
import { verifySession, sha256Hex, newToken } from "./sessions.js";
import { audit } from "./audit.js";
import { slog } from "../log.js";

const randHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const rid = (p) => `${p}_${randHex(9)}`;
const nowIso = () => new Date().toISOString();
const normEmail = (e) => String(e || "").trim().toLowerCase();
const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

export const AGENCY_GRANT_ROLES = ["support", "staff", "admin"]; // never owner
export const AGENCY_COOKIE = "_agency";

// ---- agencies + members --------------------------------------------------------

export async function createAgency({ name }) {
  if (!name?.trim()) throw new Error("agency name required");
  const row = { id: rid("agc"), name: name.trim().slice(0, 120), status: "pending", referral_eligible: 0, commission_bps: 1500, created_at: nowIso(), updated_at: nowIso() };
  await platformDb().execute({
    sql: "INSERT INTO agencies (id, name, status, referral_eligible, commission_bps, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    args: [row.id, row.name, row.status, 0, 1500, row.created_at, row.updated_at],
  });
  return row;
}

export async function setAgencyStatus(id, { status, referral_eligible, commission_bps } = {}) {
  const sets = [];
  const args = [];
  if (status != null) {
    if (!["pending", "verified", "suspended"].includes(status)) throw new Error("status: pending | verified | suspended");
    sets.push("status = ?");
    args.push(status);
  }
  if (referral_eligible != null) {
    sets.push("referral_eligible = ?");
    args.push(referral_eligible ? 1 : 0);
  }
  if (commission_bps != null) {
    const bps = Number(commission_bps);
    if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw new Error("commission: 0–5000 bps");
    sets.push("commission_bps = ?");
    args.push(bps);
  }
  if (!sets.length) throw new Error("nothing to change");
  await platformDb().execute({ sql: `UPDATE agencies SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, args: [...args, nowIso(), id] });
  return { id };
}

export async function listAgencies() {
  const r = await platformDb().execute(
    `SELECT a.*, (SELECT COUNT(*) FROM agency_members m WHERE m.agency_id = a.id) members,
            (SELECT COUNT(*) FROM agency_grants g WHERE g.agency_id = a.id AND g.status = 'accepted') clients
     FROM agencies a ORDER BY a.created_at ASC`
  );
  return r.rows.map((row) => ({ ...row, referral_eligible: !!Number(row.referral_eligible) }));
}

export async function getAgency(id) {
  const r = await platformDb().execute({ sql: "SELECT * FROM agencies WHERE id = ?", args: [id] });
  return r.rows[0] ? { ...r.rows[0], referral_eligible: !!Number(r.rows[0].referral_eligible) } : null;
}

export async function addAgencyMember(agencyId, userId, role = "member") {
  await platformDb().execute({
    sql: "INSERT INTO agency_members (agency_id, user_id, role, created_at) VALUES (?,?,?,?) ON CONFLICT(agency_id, user_id) DO UPDATE SET role = excluded.role",
    args: [agencyId, userId, role === "owner" ? "owner" : "member", nowIso()],
  });
}

// Session (kind "agency") → { user, agency } — suspended agencies get null.
export async function agencyFromToken(token) {
  const s = await verifySession(token, "agency");
  if (!s) return null;
  const r = await platformDb().execute({
    sql: `SELECT a.*, m.role AS member_role, u.email, u.name AS user_name
          FROM agency_members m JOIN agencies a ON a.id = m.agency_id JOIN users u ON u.id = m.user_id
          WHERE m.user_id = ?`,
    args: [s.userId],
  });
  const row = r.rows[0];
  if (!row || row.status === "suspended") return null;
  return {
    userId: s.userId,
    sessionId: s.sessionId,
    email: row.email,
    userName: row.user_name,
    memberRole: row.member_role,
    agency: { id: row.id, name: row.name, status: row.status, referral_eligible: !!Number(row.referral_eligible), commission_bps: Number(row.commission_bps) },
  };
}

// ---- grants (client-accepted access) -------------------------------------------

export async function createGrantInvite({ agencyId, clientEmail, role = "staff", ttlMs = 7 * 24 * 60 * 60 * 1000 }) {
  if (!AGENCY_GRANT_ROLES.includes(role)) throw new Error(`role must be one of ${AGENCY_GRANT_ROLES.join(", ")} — owner is never grantable`);
  const email = normEmail(clientEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error("a valid client email is required — acceptance is bound to it");
  const token = newToken();
  const row = { id: rid("agr"), agency_id: agencyId, client_email: email, role, status: "pending", expires_at: new Date(Date.now() + ttlMs).toISOString(), created_at: nowIso() };
  await platformDb().execute({
    sql: "INSERT INTO agency_grants (id, agency_id, client_email, role, status, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
    args: [row.id, agencyId, email, role, "pending", await sha256Hex(token), row.expires_at, row.created_at],
  });
  slog("agency_grant_invited", { grant: row.id, agency: agencyId });
  return { ...row, token }; // token shown ONCE — the agency sends it to the client
}

// Acceptance runs in the CLIENT'S console: the caller has already proven the
// actor can manage this tenant's team; here we check token validity, expiry
// and that the actor's email is the invited one. Wrong recipient → nothing.
export async function acceptGrant(token, { tenantId, actorEmail }) {
  const now = nowIso();
  const res = await platformDb().execute({
    sql: `UPDATE agency_grants SET status = 'accepted', tenant_id = ?, accepted_by = ?, accepted_at = ?, token_hash = NULL
          WHERE token_hash = ? AND status = 'pending' AND expires_at > ? AND client_email = ?
          RETURNING *`,
    args: [tenantId, normEmail(actorEmail), now, await sha256Hex(token), now, normEmail(actorEmail)],
  });
  const row = res.rows[0];
  if (!row) return null; // expired, used, or wrong recipient — no grant created
  await audit({ actor: `client:${normEmail(actorEmail)}`, action: "agency.grant_accepted", tenantId, resource: `grant:${row.id}`, diff: { agency: row.agency_id, role: row.role } });
  slog("agency_grant_accepted", { grant: row.id, tenant: tenantId });
  return { ...row };
}

export async function revokeGrant(id, actor = "unknown") {
  const res = await platformDb().execute({
    sql: "UPDATE agency_grants SET status = 'revoked', revoked_at = ?, token_hash = NULL WHERE id = ? AND status IN ('pending','accepted') RETURNING *",
    args: [nowIso(), id],
  });
  if (!res.rows[0]) throw new Error("grant not found (or already closed)");
  await audit({ actor, action: "agency.grant_revoked", tenantId: res.rows[0].tenant_id, resource: `grant:${id}` });
  slog("agency_grant_revoked", { grant: id });
  return { id, status: "revoked" };
}

export async function grantsForAgency(agencyId) {
  const r = await platformDb().execute({ sql: "SELECT * FROM agency_grants WHERE agency_id = ? ORDER BY created_at DESC", args: [agencyId] });
  const now = nowIso();
  return r.rows.map((g) => ({ ...g, status: g.status === "pending" && g.expires_at <= now ? "expired" : g.status }));
}

export async function grantsForTenant(tenantId) {
  const r = await platformDb().execute({
    sql: `SELECT g.*, a.name AS agency_name FROM agency_grants g JOIN agencies a ON a.id = g.agency_id
          WHERE g.tenant_id = ? ORDER BY g.created_at DESC`,
    args: [tenantId],
  });
  return r.rows.map((g) => ({ ...g }));
}

// THE access check — called on every agency operation, never cached.
export async function activeGrant(agencyId, tenantId) {
  const r = await platformDb().execute({
    sql: "SELECT * FROM agency_grants WHERE agency_id = ? AND tenant_id = ? AND status = 'accepted' LIMIT 1",
    args: [agencyId, tenantId],
  });
  return r.rows[0] ? { ...r.rows[0] } : null;
}

// Portfolio: ONLY granted stores, with per-store currency/timezone retained.
export async function agencyPortfolio(agencyId) {
  const grants = (await grantsForAgency(agencyId)).filter((g) => g.status === "accepted");
  const out = [];
  for (const g of grants) {
    const t = await getTenant(g.tenant_id).catch(() => null);
    if (!t || t.status !== "active") {
      out.push({ tenant: g.tenant_id, name: t?.name || g.tenant_id, role: g.role, reachable: false });
      continue;
    }
    const health = await runAsTenant(g.tenant_id, async () => {
      const { db } = await import("../db.js");
      const n = async (q) => Number((await q.executeTakeFirst())?.n || 0);
      const { listReturns } = await import("../returns.js");
      const [products, orders30] = await Promise.all([
        n(db.selectFrom("products").select(({ fn }) => fn.countAll().as("n")).where("available", "=", 1)),
        n(db.selectFrom("orders").select(({ fn }) => fn.countAll().as("n")).where("created_at", ">=", new Date(Date.now() - 30 * 86400000).toISOString())),
      ]);
      const openReturns = (await listReturns({ status: "requested" })).length;
      return { products, orders30, openReturns };
    }).catch(() => null);
    const approvals = await platformDb().execute({
      sql: "SELECT COUNT(*) n FROM client_approvals WHERE agency_id = ? AND tenant_id = ? AND status = 'pending'",
      args: [agencyId, g.tenant_id],
    });
    out.push({
      tenant: g.tenant_id,
      name: t.name,
      role: g.role,
      reachable: !!health,
      currency: t.config?.currency || "INR",
      timezone: t.config?.merchant_timezone || t.config?.timezone || "Asia/Kolkata",
      health,
      pendingApprovals: Number(approvals.rows[0]?.n || 0),
      grantId: g.id,
    });
  }
  return out;
}

// ---- kits (AG03): scrubbed structure, drafts on apply --------------------------

// What a kit keeps per block — structure and generic text ONLY.
function scrubKitPayload({ hero, announcement, home_sections, brand }) {
  const s = (v, n = 300) => String(v ?? "").slice(0, n);
  const noPaths = (v) => (/(https?:\/\/|\/api\/media\/|@)/i.test(String(v || "")) ? "" : s(v));
  const out = {};
  if (hero) {
    out.hero = { title: noPaths(hero.title), highlight: noPaths(hero.highlight), subtitle: noPaths(s(hero.subtitle, 400)) };
    for (const btn of ["primary", "secondary"]) {
      const href = String(hero[btn]?.href || "");
      // only generic storefront destinations survive; collection/product
      // handles are the source merchant's catalog data
      if (["/collections", "/search", "/", "#new"].includes(href)) out.hero[btn] = { label: noPaths(hero[btn].label), href };
    }
  }
  if (announcement) out.announcement = { enabled: false, text: noPaths(announcement.text), href: "" };
  if (Array.isArray(home_sections)) {
    // keep section kinds/titles/limits; DROP anything naming catalog entities
    out.home_sections = home_sections.map((x) => ({ kind: s(x.kind, 30), title: noPaths(x.title), limit: Number(x.limit) || 6, enabled: x.enabled !== false }));
  }
  if (brand) {
    // design tokens are generic by nature; keep only known token keys
    out.brand = {};
    for (const k of ["accent", "background", "foreground", "radius", "font_display", "font_body"]) if (brand[k] != null) out.brand[k] = s(brand[k], 60);
  }
  return out;
}

// Scanner used by tests AND by export: any marker leaking in = hard fail.
export function kitScan(payload, markers) {
  const blob = JSON.stringify(payload).toLowerCase();
  return (markers || [])
    .map((m) => String(m || "").toLowerCase())
    .filter(Boolean)
    .filter((m) => blob.includes(m));
}

export async function exportAgencyKit({ agencyId, tenantId, name }) {
  const grant = await activeGrant(agencyId, tenantId);
  if (!grant) throw new Error("no accepted grant for that store");
  const t = await getTenant(tenantId);
  const raw = await runAsTenant(tenantId, async () => {
    const { getHero, getAnnouncement, getHomeSections } = await import("../cms/store.js");
    return { hero: await getHero(), announcement: await getAnnouncement(), home_sections: await getHomeSections() };
  });
  const payload = scrubKitPayload({ ...raw, brand: t.config?.brand || null });
  // hard gate: source identifiers must not survive the scrub. Markers under
  // 4 chars are skipped (a 2-letter slug matches ordinary prose); emails and
  // URLs are caught structurally below regardless.
  const markers = [tenantId, ...(t.domains || [])].filter((m) => String(m).length >= 4).concat(["/api/media/", "gid://shopify", "myshopify.com"]);
  const leaked = kitScan(payload, markers);
  const blob = JSON.stringify(payload);
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(blob)) leaked.push("an email address");
  if (/https?:\/\//i.test(blob)) leaked.push("an absolute URL");
  if (leaked.length) throw new Error(`kit scrub failed — refusing to store (leaked: ${leaked.join(", ")})`);
  const row = { id: rid("akit"), agency_id: agencyId, name: String(name || t.name).trim().slice(0, 120), source_note: t.name, payload: JSON.stringify(payload), created_at: nowIso() };
  await platformDb().execute({
    sql: "INSERT INTO agency_kits (id, agency_id, name, source_note, payload, created_at) VALUES (?,?,?,?,?,?)",
    args: [row.id, agencyId, row.name, row.source_note, row.payload, row.created_at],
  });
  slog("agency_kit_exported", { kit: row.id, agency: agencyId });
  return { ...row, payload };
}

export async function listAgencyKits(agencyId) {
  const r = await platformDb().execute({ sql: "SELECT * FROM agency_kits WHERE agency_id = ? ORDER BY created_at DESC", args: [agencyId] });
  return r.rows.map((k) => ({ ...k, payload: parse(k.payload, {}) }));
}

// Apply = CMS DRAFTS on the destination (normal store path; the merchant
// publishes a release as usual). Brand tokens come back as a SUGGESTION —
// brand edits are live-effect, so an agency never flips them silently.
export async function applyAgencyKit({ agencyId, kitId, tenantId }) {
  const grant = await activeGrant(agencyId, tenantId);
  if (!grant) throw new Error("no accepted grant for that store");
  if (!["staff", "admin"].includes(grant.role)) throw new Error(`the client granted "${grant.role}" — content writes need staff or admin`);
  const r = await platformDb().execute({ sql: "SELECT * FROM agency_kits WHERE id = ? AND agency_id = ?", args: [kitId, agencyId] });
  if (!r.rows[0]) throw new Error("kit not found");
  const payload = parse(r.rows[0].payload, {});
  const written = await runAsTenant(tenantId, async () => {
    const { setBlock } = await import("../cms/store.js");
    const done = [];
    if (payload.hero?.title) {
      await setBlock("hero", payload.hero);
      done.push("hero");
    }
    if (payload.home_sections?.length) {
      await setBlock("home_sections", payload.home_sections);
      done.push("home_sections");
    }
    if (payload.announcement?.text) {
      await setBlock("announcement", payload.announcement);
      done.push("announcement");
    }
    return done;
  });
  await audit({ actor: `agency:${agencyId}`, action: "agency.kit_applied", tenantId, resource: `kit:${kitId}`, diff: { blocks: written } });
  slog("agency_kit_applied", { kit: kitId, tenant: tenantId, blocks: written.length });
  return { written, brandSuggestion: payload.brand || null, note: "written as DRAFTS — the store publishes a release to take them live" };
}

// ---- approvals (AG04): hash-bound, signed, expiring ----------------------------

export async function currentDraftHash(tenantId) {
  return runAsTenant(tenantId, async () => {
    const { snapshotContent, stableStringify, sha256Hex: sh } = await import("../releases.js");
    return sh(stableStringify(await snapshotContent()));
  });
}

export async function createClientApproval({ agencyId, tenantId, note = "", ttlMs = 7 * 24 * 60 * 60 * 1000 }) {
  const grant = await activeGrant(agencyId, tenantId);
  if (!grant) throw new Error("no accepted grant for that store");
  const hash = await currentDraftHash(tenantId);
  const token = newToken();
  const row = {
    id: rid("apr"),
    agency_id: agencyId,
    tenant_id: tenantId,
    content_hash: hash,
    note: String(note || "").slice(0, 500),
    status: "pending",
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
    created_at: nowIso(),
  };
  await platformDb().execute({
    sql: "INSERT INTO client_approvals (id, agency_id, tenant_id, content_hash, note, token_hash, status, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    args: [row.id, agencyId, tenantId, hash, row.note, await sha256Hex(token), "pending", row.expires_at, row.created_at],
  });
  slog("client_approval_created", { approval: row.id, tenant: tenantId });
  return { ...row, token }; // shown once; the link embeds it
}

export async function approvalByToken(token) {
  const r = await platformDb().execute({ sql: "SELECT * FROM client_approvals WHERE token_hash = ?", args: [await sha256Hex(token)] });
  const row = r.rows[0];
  if (!row) return null;
  if (row.status === "pending" && row.expires_at <= nowIso()) return { ...row, status: "expired" };
  return { ...row };
}

export async function decideApproval(token, { decision, approver, comment = "" }) {
  if (!["approved", "rejected"].includes(decision)) throw new Error("decision must be approved or rejected");
  const who = String(approver || "").trim().slice(0, 120);
  if (who.length < 2) throw new Error("the approver's name is required — the decision is recorded against it");
  const now = nowIso();
  const res = await platformDb().execute({
    sql: `UPDATE client_approvals SET status = ?, approver = ?, comment = ?, decided_at = ?
          WHERE token_hash = ? AND status = 'pending' AND expires_at > ? RETURNING *`,
    args: [decision, who, String(comment || "").slice(0, 1000), now, await sha256Hex(token), now],
  });
  const row = res.rows[0];
  if (!row) throw new Error("this approval link is expired or already decided");
  slog("client_approval_decided", { approval: row.id, status: decision });
  return { ...row };
}

export async function approvalsForAgency(agencyId) {
  const r = await platformDb().execute({ sql: "SELECT * FROM client_approvals WHERE agency_id = ? ORDER BY created_at DESC LIMIT 50", args: [agencyId] });
  const now = nowIso();
  const rows = r.rows.map((a) => ({ ...a, status: a.status === "pending" && a.expires_at <= now ? "expired" : a.status }));
  // staleness: an approval authorizes ITS hash, not the current draft
  for (const a of rows) {
    if (a.status === "approved") a.current = (await currentDraftHash(a.tenant_id).catch(() => null)) === a.content_hash;
  }
  return rows;
}

// ---- referrals + commissions (AG05) --------------------------------------------

export async function attributeReferral(tenantId, agencyId, note = "") {
  const existing = await platformDb().execute({ sql: "SELECT agency_id, status FROM agency_referrals WHERE tenant_id = ?", args: [tenantId] });
  if (existing.rows[0] && existing.rows[0].status === "attributed" && existing.rows[0].agency_id !== agencyId) {
    throw new Error(`"${tenantId}" is already attributed to another agency — void that attribution first (disputes are explicit, never silent re-pointing)`);
  }
  await platformDb().execute({
    sql: `INSERT INTO agency_referrals (tenant_id, agency_id, status, note, created_at, updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(tenant_id) DO UPDATE SET agency_id = excluded.agency_id, status = 'attributed', note = excluded.note, updated_at = excluded.updated_at`,
    args: [tenantId, agencyId, "attributed", String(note).slice(0, 300), nowIso(), nowIso()],
  });
  return { tenantId, agencyId };
}

export async function voidReferral(tenantId, note = "") {
  await platformDb().execute({
    sql: "UPDATE agency_referrals SET status = 'void', note = ?, updated_at = ? WHERE tenant_id = ?",
    args: [String(note).slice(0, 300), nowIso(), tenantId],
  });
  return { tenantId, status: "void" };
}

// Idempotent ledger derivation: one commission row per billing event
// (UNIQUE billing_event_id). Positive amounts = eligible collected revenue
// → earned; negative = refunds → reversed. Re-runs insert nothing twice.
export async function recomputeCommissions() {
  const refs = await platformDb().execute("SELECT r.tenant_id, r.agency_id, a.commission_bps, a.referral_eligible FROM agency_referrals r JOIN agencies a ON a.id = r.agency_id WHERE r.status = 'attributed'");
  let inserted = 0;
  for (const ref of refs.rows) {
    if (!Number(ref.referral_eligible)) continue;
    const events = await platformDb().execute({
      sql: "SELECT id, amount, occurred_at FROM billing_events WHERE tenant_id = ? AND amount != 0",
      args: [ref.tenant_id],
    });
    for (const ev of events.rows) {
      const amount = Math.round((Number(ev.amount) * Number(ref.commission_bps)) / 10000);
      if (!amount) continue;
      const res = await platformDb().execute({
        sql: `INSERT INTO agency_commissions (id, agency_id, tenant_id, billing_event_id, kind, base_amount, amount, period, created_at)
              VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(billing_event_id) DO NOTHING`,
        args: [rid("acm"), ref.agency_id, ref.tenant_id, ev.id, Number(ev.amount) > 0 ? "earned" : "reversed", Number(ev.amount), amount, String(ev.occurred_at).slice(0, 7), nowIso()],
      });
      inserted += Number(res.rowsAffected) || 0;
    }
  }
  return { inserted };
}

// Statement: calculated commissions by month. PAYOUTS ARE NOT BUILT — the
// statement is the reconciliation artifact; money moves outside, manually.
export async function commissionStatement(agencyId) {
  const r = await platformDb().execute({
    sql: `SELECT period, SUM(CASE WHEN kind='earned' THEN amount ELSE 0 END) earned,
                 SUM(CASE WHEN kind='reversed' THEN amount ELSE 0 END) reversed,
                 SUM(amount) net, COUNT(*) events
          FROM agency_commissions WHERE agency_id = ? GROUP BY period ORDER BY period DESC`,
    args: [agencyId],
  });
  const rows = await platformDb().execute({ sql: "SELECT * FROM agency_commissions WHERE agency_id = ? ORDER BY created_at DESC LIMIT 100", args: [agencyId] });
  return { months: r.rows.map((x) => ({ ...x })), entries: rows.rows.map((x) => ({ ...x })), payoutsNote: "payouts are settled outside this ledger — these are calculated commissions, not payments" };
}

// ---- reports (AG06) ------------------------------------------------------------

export async function agencyClientReport(agencyId, tenantId) {
  const grant = await activeGrant(agencyId, tenantId);
  if (!grant) throw new Error("no accepted grant for that store");
  const t = await getTenant(tenantId);
  return runAsTenant(tenantId, async () => {
    const { salesRollup, topProducts, funnel } = await import("../reporting.js");
    return {
      tenant: tenantId,
      name: t.name,
      currency: t.config?.currency || "INR",
      timezone: t.config?.merchant_timezone || "Asia/Kolkata",
      generated_at: nowIso(),
      sales: await salesRollup({ days: 30 }),
      topProducts: await topProducts({ days: 30 }),
      funnel: await funnel({ days: 30 }).catch(() => null),
    };
  });
}
