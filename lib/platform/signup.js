// Self-serve signup (Phase 1 line 1, docs/plans/phase-1.md). Node-only.
//
// A founder fills the form on the marketing host; a 6-digit code goes to the
// email; only a verified code creates anything. Line 2: verify queues a
// provision_store job (lib/platform/signup-provision.js) and answers at once;
// the job makes the store's database (the Turso Platform API, or a local file
// outside production), the user and the owner membership. The waiting page
// polls signupStatus, which shows four plain steps and, once done, makes a
// 2-minute single-use handoff token that signs the founder in on the new
// store's own host (at most one live; after it was used or 30 minutes, a
// sign-in link instead).
//
//   validateSignup(input)                 -> { fields, errors }
//   slugFor(storeName)                    -> "my-store" ("" when nothing is left)
//   slugAvailable(slug)                   -> { ok, reason? } reason: format | reserved | taken
//   startSignup({ input, ip })            -> { ok, browserToken, signup } | { errors } | { limited }
//   resendCode({ browserToken })          -> { ok } | { error, status, retryAfter? }
//   resendCodeById(signupId)              -> the same, for an operator (line 8)
//   verifySignup({ browserToken, code, ip, origin }) -> queueSignupProvision's answer | { error, status }
//   retrySignup({ browserToken, origin }) -> queueSignupProvision's answer | { ok, status: "done", loginUrl } | { error, status }
//   queueSignupProvision(row, { origin }) -> { ok, status: "provisioning", jobId } | { error, status: 503 }
//   signupStatus({ browserToken, origin }) -> { ok, status, steps, note?, error?, failureKind?, canRetry?, redirect?, loginUrl? } | { error, status }
//   storeHostFor(slug), storeOriginFor(slug, origin)
//
// Rules held here: the code is stored as sha256(signupId:code) and compared in
// constant time; verify, resend and retry act only on the signup whose
// browser_hash matches the se_signup cookie (another browser's signup is never
// read, so its tries are never spent); an email that already has an account
// gets the same answers, the same scrypt work and an email with no code; every
// failed code gets the same words, and counts toward a daily cap per email
// (past it: the same answers, no code stored, nothing sent). 'existing' holds
// its address like 'pending'. Only finished rows are pruned; a stalled one
// loses its password hash a day past expiry. Nothing here trusts an id from
// the body.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { platformDb } from "./control.js";
import { findUserByEmail, createInvite, hashPassword, passwordProblem, loginThrottle } from "./identity.js";
import { sendPlatformMail } from "./platform-mail.js";
import { platformSiteHosts } from "../platform-site.js";
import { slog } from "../log.js";

export const SIGNUP_COOKIE = "se_signup";
// The plan names it ff_self_signup, but flag keys are ff_<lowercase-slug>
// (lib/platform/flags.js KEY_RE: no "_" after the prefix), so an operator
// could never turn that one on. The hyphen keeps it settable.
export const SIGNUP_FLAG = "ff_self-signup";
export const CODE_TTL_MS = 15 * 60 * 1000;
export const CODE_MAX_TRIES = 5;
export const RESEND_GAP_MS = 60 * 1000;
export const MAX_SENDS = 5;
export const SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;
export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const HANDOFF_TTL_MS = 2 * 60 * 1000;
// The store's handoff page; the token rides in the fragment (never sent to a
// server, so never in a log or a Referer). A constant, so the Shopify-boundary
// scan reads it as our own console page.
export const HANDOFF_PATH = "/admin/handoff";
// After this long (or once the handoff was used) the status gives a sign-in link.
export const HANDOFF_FRESH_MS = 30 * 60 * 1000;
export const LIMITS = Object.freeze({
  startPerIp: { limit: 5, windowMs: 60 * 60 * 1000 },
  startPerEmail: { limit: 3, windowMs: 60 * 60 * 1000 },
  verifyPerIp: { limit: 20, windowMs: 15 * 60 * 1000 },
  // failed code tries per email per day, across all of its signups
  codeFailsPerEmail: { limit: 10, windowMs: 24 * 60 * 60 * 1000 },
});
// A failed, verified or provisioning signup keeps its password hash (Try
// again needs it to make the user) until this long past its expiry.
export const LAPSE_AFTER_MS = 24 * 60 * 60 * 1000;

export const RESERVED_SLUGS = Object.freeze([
  "www", "admin", "api", "app", "platform", "storeasy", "mail", "help", "status", "signup",
  "login", "billing", "support", "security", "account", "accounts", "checkout", "cdn", "assets", "static", "docs", "blog", "shop", "store", "stores",
]);
// Statuses that hold their slug (the partial unique index in migration 0011).
// 'existing' holds it exactly like 'pending', so an address answers the same
// whether or not the email behind it already has an account.
// line 8: 'released' (an operator freed a lapsed signup's address) holds nothing.
const LIVE = ["pending", "existing", "verified", "provisioning", "failed"];

export const CODE_FAILED = "That code didn't work. Check the newest email we sent, or ask for a new code.";
export const SIGNUP_GONE = "We couldn't find your signup in this browser. Start again.";
export const SIGNUP_LAPSED = "This signup has lapsed. Start again.";
export const SIGNUP_UNAVAILABLE = "Signups are unavailable right now. Try again soon.";
export const STATUS_STEPS = Object.freeze([
  { label: "Creating your store's database", steps: ["create_db"] },
  { label: "Preparing your store", steps: ["apply_schema", "content_mode", "seed_defaults"] },
  { label: "Registering your store address", steps: ["register_tenant", "init_billing", "record_onboarding"] },
  { label: "Creating your account", steps: [] },
]);

const now = () => Date.now();
const iso = (ms = now()) => new Date(ms).toISOString();
const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const normEmail = (e) => String(e ?? "").trim().toLowerCase();
const signupId = () => `sgn_${randomBytes(8).toString("hex")}`;
export const codeHash = (id, code) => sha256(`${id}:${code}`);
export const browserHash = (token) => sha256(token);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
// no "--" anywhere, so never an IDNA "xn--" label or another punycode look-alike
const slugShapeOk = (s) => SLUG_RE.test(s) && !s.includes("--");
export const codeFailKey = (email) => `signup-codefail:${normEmail(email)}`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const signupStoreDomain = () => String(process.env.SIGNUP_STORE_DOMAIN || "").trim().toLowerCase();
export const storeHostFor = (slug) => `${slug}.${signupStoreDomain()}`;

// The new store's origin, on the protocol and port the founder is using now
// (storeasy.localhost:3017 → my-store.localhost:3017; storeasy.app → my-store.<domain>).
export function storeOriginFor(slug, origin) {
  let protocol = "https:";
  let port = "";
  try {
    const u = new URL(origin);
    protocol = u.protocol;
    port = u.port;
  } catch {
    // no usable origin: https on the default port
  }
  return `${protocol}//${storeHostFor(slug)}${port ? `:${port}` : ""}`;
}

export function slugFor(storeName) {
  const s = String(storeName ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s.length >= 2 ? s : "";
}

// Every label of every marketing host is reserved too (storeasy.app → storeasy, app).
export function reservedSlugs() {
  const labels = platformSiteHosts().flatMap((h) => h.split(":")[0].split("."));
  return new Set([...RESERVED_SLUGS, ...labels.filter(Boolean)]);
}

export async function slugAvailable(slug) {
  const s = String(slug ?? "");
  if (!slugShapeOk(s)) return { ok: false, reason: "format" };
  if (reservedSlugs().has(s)) return { ok: false, reason: "reserved" };
  const host = storeHostFor(s);
  // one answer from the database: a store with this id (primary key), the
  // domain registry, or a store already resolving this host (tenants.domains is
  // what resolution reads; json_each skips a broken row); never every row
  const taken = await platformDb().execute({
    sql: `SELECT 1 FROM tenants WHERE id = ?
          UNION ALL SELECT 1 FROM domains WHERE host = ? OR host LIKE ?
          UNION ALL SELECT 1 FROM tenants t, json_each(CASE WHEN json_valid(t.domains) THEN t.domains ELSE '[]' END) d
            WHERE lower(d.value) = ? OR lower(d.value) LIKE ?
          LIMIT 1`,
    args: [s, host, `${host}:%`, host, `${host}:%`],
  });
  if (taken.rows.length) return { ok: false, reason: "taken" };
  const held = await platformDb().execute({
    sql: `SELECT 1 FROM signups WHERE slug = ? AND status IN (${LIVE.map(() => "?").join(",")})
            AND NOT (status IN ('pending','existing') AND expires_at <= ?) LIMIT 1`,
    args: [s, ...LIVE, iso()],
  });
  return held.rows.length ? { ok: false, reason: "taken" } : { ok: true };
}

export const SLUG_WORDS = {
  format: "Use 2–40 lower-case letters, numbers and single hyphens, starting and ending with a letter or number.",
  reserved: "That address is reserved. Try another.",
  taken: "That address is taken. Try another.",
};

export function validateSignup(input = {}) {
  const name = String(input.name ?? "").trim();
  const email = normEmail(input.email);
  const password = typeof input.password === "string" ? input.password : "";
  const storeName = String(input.storeName ?? "").trim();
  const slug = String(input.slug ?? "").trim().toLowerCase() || slugFor(storeName);
  const errors = {};
  if (name.length < 1 || name.length > 80) errors.name = "Enter your name (up to 80 characters).";
  if (!EMAIL_RE.test(email) || email.length > 200) errors.email = "Enter a valid email address.";
  const pw = passwordProblem(password, email);
  if (pw) errors.password = pw;
  if (storeName.length < 2 || storeName.length > 60) errors.storeName = "Your store name needs 2–60 characters.";
  if (!slugShapeOk(slug)) errors.slug = SLUG_WORDS.format;
  return { fields: { name, email, password, storeName, slug }, errors };
}

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

function codeMail(code) {
  return {
    kind: "signup_code",
    subject: "Your Storeasy sign-up code",
    text: `Your Storeasy sign-up code is ${code}\n\nIt works for 15 minutes. Type it on the sign-up page to create your store.\n\nIf you didn't try to sign up, ignore this email: nothing is created without the code.`,
  };
}
const EXISTING_MAIL = {
  kind: "signup_existing",
  subject: "Your Storeasy sign-up",
  text: "Someone, hopefully you, tried to sign up for Storeasy with this email address.\n\nYou already have an account. Sign in at your store's /admin/login page, or use \"Forgot password\" there to reset your password.\n\nIf this wasn't you, you can ignore this email: nothing has changed.",
};

async function byBrowser(browserToken) {
  if (!browserToken || typeof browserToken !== "string") return null;
  const r = await platformDb().execute({
    sql: "SELECT * FROM signups WHERE browser_hash = ? ORDER BY created_at DESC LIMIT 1",
    args: [browserHash(browserToken)],
  });
  return r.rows[0] ? { ...r.rows[0] } : null;
}

async function setRow(id, patch) {
  const keys = Object.keys(patch);
  await platformDb().execute({
    sql: `UPDATE signups SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    args: [...keys.map((k) => patch[k]), iso(), id],
  });
}

// The daily cap on failed code tries for one email (login_limits, counted by
// loginThrottle on each failure). Reading it adds nothing to the count.
async function codeFailsCapped(email) {
  const r = await platformDb().execute({ sql: "SELECT count, reset_at FROM login_limits WHERE key = ?", args: [codeFailKey(email)] });
  const row = r.rows[0];
  return Boolean(row && row.reset_at > iso() && Number(row.count) >= LIMITS.codeFailsPerEmail.limit);
}

// ---- start -----------------------------------------------------------------

export async function startSignup({ input, ip = "local" }) {
  if ((await loginThrottle(`signup-ip:${ip}`, LIMITS.startPerIp)).blocked) return { limited: true };
  const { fields, errors } = validateSignup(input);
  if (Object.keys(errors).length) return { errors };
  if ((await loginThrottle(`signup-email:${fields.email}`, LIMITS.startPerEmail)).blocked) return { limited: true };
  const avail = await slugAvailable(fields.slug);
  if (!avail.ok) return { errors: { slug: SLUG_WORDS[avail.reason] } };

  const t = now();
  const db = platformDb();
  // housekeeping before a new row: prune old rows, expire lapsed ones (freeing
  // their address), and supersede this email's older signup
  // (only finished rows are pruned: failed, verified and provisioning rows stay
  // for operators), and drop the password hash of a stalled one a day past
  // its expiry (Try again then says start again)
  await db.execute({ sql: "DELETE FROM signups WHERE status IN ('done','expired','superseded') AND created_at < ?", args: [iso(t - PRUNE_AFTER_MS)] });
  await db.execute({ sql: "UPDATE signups SET status = 'expired', password_hash = NULL, code_hash = NULL, updated_at = ? WHERE status IN ('pending','existing') AND expires_at <= ?", args: [iso(t), iso(t)] });
  await db.execute({
    sql: "UPDATE signups SET password_hash = NULL, updated_at = ? WHERE status IN ('failed','verified','provisioning') AND password_hash IS NOT NULL AND expires_at <= ?",
    args: [iso(t), iso(t - LAPSE_AFTER_MS)],
  });
  await db.execute({ sql: "UPDATE signups SET status = 'superseded', password_hash = NULL, code_hash = NULL, updated_at = ? WHERE email = ? AND status IN ('pending','existing')", args: [iso(t), fields.email] });

  // the scrypt work runs for every email, so an existing account takes as long
  const passwordHash = await hashPassword(fields.password);
  const existing = await findUserByEmail(fields.email);
  // an email past its daily cap of failed codes gets the same answer and row,
  // but no code is stored and nothing is sent
  const capped = await codeFailsCapped(fields.email);
  const id = signupId();
  const browserToken = randomBytes(32).toString("hex");
  const code = existing || capped ? null : newCode();
  try {
    await db.execute({
      sql: `INSERT INTO signups (id, email, name, store_name, slug, password_hash, browser_hash, code_hash, code_expires_at,
              code_attempts, sends, last_sent_at, status, ip, created_at, updated_at, expires_at)
            VALUES (?,?,?,?,?,?,?,?,?,0,1,?,?,?,?,?,?)`,
      args: [
        id, fields.email, fields.name, fields.storeName, fields.slug,
        existing ? null : passwordHash, browserHash(browserToken),
        code ? codeHash(id, code) : null, iso(t + CODE_TTL_MS),
        iso(t), existing ? "existing" : "pending", String(ip).slice(0, 64), iso(t), iso(t), iso(t + SIGNUP_TTL_MS),
      ],
    });
  } catch (e) {
    // another signup took the address between the check and the insert
    if (/UNIQUE/i.test(String(e?.message || e))) return { errors: { slug: SLUG_WORDS.taken } };
    throw e;
  }
  slog("signup_started", { signup: id, ...(capped ? { capped: true } : {}) });
  if (!capped) {
    await sendPlatformMail({ ...(existing ? EXISTING_MAIL : codeMail(code)), to: fields.email, ref: id });
    slog("signup_code_sent", { signup: id });
  }
  return { ok: true, browserToken, signup: publicSignup(fields) };
}

// The same keys for a new and an existing email.
const publicSignup = (f) => ({ email: f.email, storeName: f.storeName, address: storeHostFor(f.slug), codeMinutes: CODE_TTL_MS / 60_000 });

// ---- resend ----------------------------------------------------------------

export async function resendCode({ browserToken }) {
  return resendFor(await byBrowser(browserToken));
}

// line 8: an operator's "Resend the email code", by signup id, with the same
// 60 s gap and send limit. The code still works only in the founder's browser.
export async function resendCodeById(id) {
  const r = await platformDb().execute({ sql: "SELECT * FROM signups WHERE id = ?", args: [String(id || "")] });
  return resendFor(r.rows[0] ? { ...r.rows[0] } : null);
}

async function resendFor(row) {
  const t = now();
  if (!row || !["pending", "existing"].includes(row.status) || row.expires_at <= iso(t)) return { error: SIGNUP_GONE, status: 400 };
  if (Number(row.sends) >= MAX_SENDS) return { error: "You've asked for the most codes we can send. Start again in a while.", status: 429 };
  const wait = Date.parse(row.last_sent_at || 0) + RESEND_GAP_MS - t;
  if (wait > 0) return { error: "Wait a minute before asking for another code.", status: 429, retryAfter: Math.ceil(wait / 1000) };
  const capped = await codeFailsCapped(row.email);
  const code = row.status === "pending" && !capped ? newCode() : null;
  // each send is a new code with fresh tries; the guard keeps two clicks to one send
  const r = await platformDb().execute({
    sql: `UPDATE signups SET code_hash = ?, code_expires_at = ?, code_attempts = 0, sends = sends + 1, last_sent_at = ?, updated_at = ?
          WHERE id = ? AND sends = ? AND status = ? RETURNING id`,
    args: [code ? codeHash(row.id, code) : null, iso(t + CODE_TTL_MS), iso(t), iso(t), row.id, row.sends, row.status],
  });
  if (!r.rows.length) return { error: "Wait a minute before asking for another code.", status: 429, retryAfter: 60 };
  if (capped) slog("signup_resend_capped", { signup: row.id });
  else {
    await sendPlatformMail({ ...(code ? codeMail(code) : EXISTING_MAIL), to: row.email, ref: row.id });
    slog("signup_code_sent", { signup: row.id, resend: true });
  }
  return { ok: true, signup: publicSignup({ email: row.email, storeName: row.store_name, slug: row.slug }) };
}

// ---- verify ----------------------------------------------------------------

// Every failure for a known signup counts toward its email's daily cap.
const codeFailed = async (row, reason) => {
  slog("signup_verify_failed", { reason, ...(row ? { signup: row.id } : {}) });
  if (row && reason !== "capped") await loginThrottle(codeFailKey(row.email), LIMITS.codeFailsPerEmail);
  return { error: CODE_FAILED, status: 400 };
};

export async function verifySignup({ browserToken, code, ip = "local", origin }) {
  if ((await loginThrottle(`signup-verify-ip:${ip}`, LIMITS.verifyPerIp)).blocked) return { error: "Too many tries. Wait a few minutes, then try again.", status: 429 };
  const row = await byBrowser(browserToken);
  if (!row) return codeFailed(null, "no_signup");
  const t = iso();
  if (!["pending", "existing"].includes(row.status)) return codeFailed(row, `status_${row.status}`);
  if (await codeFailsCapped(row.email)) return codeFailed(row, "capped");
  if (row.expires_at <= t) {
    await platformDb().execute({ sql: "UPDATE signups SET status = 'expired', password_hash = NULL, code_hash = NULL, updated_at = ? WHERE id = ? AND status IN ('pending','existing')", args: [t, row.id] });
    return codeFailed(row, "expired");
  }
  // claim one try first (atomically): five wrong tries and the code is dead
  const tried = await platformDb().execute({
    sql: "UPDATE signups SET code_attempts = code_attempts + 1, updated_at = ? WHERE id = ? AND status IN ('pending','existing') AND code_attempts < ? RETURNING code_hash, code_expires_at",
    args: [t, row.id, CODE_MAX_TRIES],
  });
  const claim = tried.rows[0];
  if (!claim) return codeFailed(row, "tries");
  if (!claim.code_hash || claim.code_expires_at <= t) return codeFailed(row, claim.code_hash ? "code_expired" : "no_code");
  const given = /^\d{6}$/.test(String(code ?? "").trim()) ? codeHash(row.id, String(code).trim()) : sha256(`${row.id}:invalid`);
  const a = Buffer.from(given, "hex");
  const b = Buffer.from(String(claim.code_hash), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return codeFailed(row, "wrong");
  // single use: only one request flips pending → verified
  const flipped = await platformDb().execute({
    sql: "UPDATE signups SET status = 'verified', verified_at = ?, code_hash = NULL, updated_at = ? WHERE id = ? AND status = 'pending' AND code_hash = ? RETURNING *",
    args: [t, t, row.id, claim.code_hash],
  });
  if (!flipped.rows[0]) return codeFailed(row, "race");
  return queueSignupProvision({ ...flipped.rows[0] }, { origin });
}

// ---- retry -----------------------------------------------------------------

export async function retrySignup({ browserToken, origin }) {
  const row = await byBrowser(browserToken);
  if (!row) return { error: SIGNUP_GONE, status: 400 };
  if (row.status === "done") return { ok: true, status: "done", loginUrl: `${storeOriginFor(row.slug, origin)}/admin/login` };
  if (!["verified", "failed", "provisioning"].includes(row.status)) return { error: SIGNUP_GONE, status: 400 };
  if (lapsed(row) || row.failure_kind === "lapsed") return { error: SIGNUP_LAPSED, status: 400 };
  slog("signup_retry", { signup: row.id });
  return queueSignupProvision(row, { origin });
}

// ---- queue: the provision_store job -------------------------------------------

// Past the lapse window, or the password hash is gone before a user was made.
const lapsed = (row) => row.expires_at <= iso(now() - LAPSE_AFTER_MS) || (!row.user_id && !row.password_hash);

// verified or failed -> provisioning and the signup's one job due now (Try
// again resumes the same job and run). The route runs it in after().
export async function queueSignupProvision(row, { origin } = {}) {
  const { signupDbDriver } = await import("./provisioner.js");
  if (!signupDbDriver()) return { error: SIGNUP_UNAVAILABLE, status: 503 };
  const { claimSignupProvision } = await import("./signup-provision.js");
  const q = await claimSignupProvision(row, { siteUrl: storeOriginFor(row.slug, origin) });
  if (q.already === "done") return { ok: true, status: "done", loginUrl: `${storeOriginFor(row.slug, origin)}/admin/login` };
  return { ok: true, status: "provisioning", jobId: q.jobId || null };
}

// ---- status: what the waiting page shows -----------------------------------------

const stepStates = (row, run) => {
  const recs = new Map((run?.steps || []).map((x) => [x.name, x.status]));
  const groupDone = (g) => (g.steps.length ? g.steps.every((n) => recs.get(n) === "done") : row.status === "done");
  let working = row.status === "provisioning" || row.status === "verified";
  return STATUS_STEPS.map((g) => {
    if (row.status === "done" || groupDone(g)) return { label: g.label, state: "done" };
    if (row.status === "failed") {
      const failedHere = g.steps.some((n) => recs.get(n) === "failed") || (!g.steps.length && (run?.status === "done" || !run));
      return { label: g.label, state: failedHere ? "failed" : "waiting" };
    }
    if (working) {
      working = false;
      return { label: g.label, state: "working" };
    }
    return { label: g.label, state: "waiting" };
  });
};

const inWords = (ms) => {
  const secs = Math.max(1, Math.ceil(ms / 1000));
  if (secs < 60) return `${secs} second${secs === 1 ? "" : "s"}`;
  const mins = Math.ceil(secs / 60);
  return `${mins} minute${mins === 1 ? "" : "s"}`;
};

async function handoffAnswer(row, origin, steps) {
  const storeOrigin = storeOriginFor(row.slug, origin);
  const loginUrl = `${storeOrigin}/admin/login`;
  const db = platformDb();
  const fresh = row.done_at && Date.parse(row.done_at) > now() - HANDOFF_FRESH_MS;
  const used = row.handoff_invite_id ? Boolean((await db.execute({ sql: "SELECT accepted_at FROM invitations WHERE id = ?", args: [row.handoff_invite_id] })).rows[0]?.accepted_at) : false;
  if (!fresh || used) return { ok: true, status: "done", steps, loginUrl };
  // at most one live handoff token: the earlier unused one goes first
  if (row.handoff_invite_id) await db.execute({ sql: "DELETE FROM invitations WHERE id = ? AND accepted_at IS NULL", args: [row.handoff_invite_id] });
  const inv = await createInvite({ email: row.email, tenantId: row.slug, role: "owner", kind: "handoff", ttlMs: HANDOFF_TTL_MS });
  const set = await db.execute({
    sql: "UPDATE signups SET handoff_invite_id = ?, updated_at = ? WHERE id = ? AND handoff_invite_id IS ?",
    args: [inv.id, iso(), row.id, row.handoff_invite_id ?? null],
  });
  if (!Number(set.rowsAffected)) {
    // another poll minted at the same moment: keep only theirs (done with
    // neither redirect nor loginUrl means: poll again)
    await db.execute({ sql: "DELETE FROM invitations WHERE id = ?", args: [inv.id] });
    return { ok: true, status: "done", steps };
  }
  return { ok: true, status: "done", steps, redirect: `${storeOrigin}${HANDOFF_PATH}#t=${inv.token}` };
}

export async function signupStatus({ browserToken, origin }) {
  let row = await byBrowser(browserToken);
  if (!row) return { error: SIGNUP_GONE, status: 400 };
  // a new email and an existing one look the same while the code is out
  if (["pending", "existing"].includes(row.status) && row.expires_at > iso()) return { ok: true, status: "code" };
  if (!["verified", "provisioning", "failed", "done"].includes(row.status)) return { error: SIGNUP_GONE, status: 400 };
  const SP = await import("./signup-provision.js");
  // the founder's own job, when due, runs here (drives retries locally; the
  // every-minute tick is the backstop). A job another runner holds is left alone.
  if (row.status === "provisioning" && row.job_id && (!row.next_attempt_at || Date.parse(row.next_attempt_at) <= SP.signupClock.now())) {
    const { makeJobDue } = await import("./jobs.js");
    const { runJobById } = await import("./worker.js");
    await makeJobDue(row.job_id);
    await runJobById(row.job_id, { budgetMs: 50_000 });
    row = (await byBrowser(browserToken)) || row;
  }
  const { getProvisionRun } = await import("./provision.js");
  const run = row.provision_run_id ? await getProvisionRun(row.provision_run_id) : null;
  const steps = stepStates(row, run);
  if (row.status === "done") return handoffAnswer(row, origin, steps);
  if (row.status === "failed") {
    const kind = row.failure_kind || null;
    const canRetry = kind !== "lapsed" && !lapsed(row);
    return { ok: true, status: "failed", steps, failureKind: kind, error: canRetry ? SP.FAILURE_WORDS[kind] || row.error || SP.EXHAUSTED_WORDS : SIGNUP_LAPSED, canRetry };
  }
  const answer = { ok: true, status: "provisioning", steps };
  const wait = row.next_attempt_at ? Date.parse(row.next_attempt_at) - SP.signupClock.now() : 0;
  if (Number(row.provision_attempts) > 0 && wait > 0) {
    answer.note = `Our hosting provider is slow to answer. Trying again in ${inWords(wait)} (try ${row.provision_attempts} of ${SP.MAX_RETRIES})`;
  }
  return answer;
}

// ---- the routes' shared gate ----------------------------------------------------

// Open only on a marketing host, with a control plane, a store domain, mail
// (in production) and the kill switch on. -> null when open, else { status, body } for the route.
export async function signupClosedAnswer(host) {
  const { isPlatformSiteHost } = await import("../platform-site.js");
  if (!isPlatformSiteHost(host)) return { status: 404, body: { error: "Not found" } };
  const { platformConfigured } = await import("./control.js");
  if (!platformConfigured()) return { status: 503, body: { error: SIGNUP_UNAVAILABLE } };
  const { flagEnabled } = await import("./flags.js");
  // production never mocks mail, so without a provider no code could reach anyone
  const { mailConfigured } = await import("../mail.js");
  const noMail = process.env.NODE_ENV === "production" && !mailConfigured();
  if (noMail || !signupStoreDomain() || !(await flagEnabled(SIGNUP_FLAG, null, { fallback: false }))) {
    return { status: 403, body: { error: "Signups are closed right now. Tell us about your store and we'll be in touch.", code: "SIGNUPS_CLOSED", contact: "/contact" } };
  }
  // line 2: production makes store databases only through the Turso API
  const { signupDbDriver } = await import("./provisioner.js");
  if (!signupDbDriver()) return { status: 503, body: { error: SIGNUP_UNAVAILABLE } };
  return null;
}

export const SIGNUP_COOKIE_OPTS = Object.freeze({
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SIGNUP_TTL_MS / 1000,
});
