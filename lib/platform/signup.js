// Self-serve signup (Phase 1 line 1, docs/plans/phase-1.md). Node-only.
//
// A founder fills the form on the marketing host; a 6-digit code goes to the
// email; only a verified code creates anything. Then the store is provisioned
// (file database until line 2), the user and the owner membership are made
// from the signup row, and a 2-minute single-use handoff token signs the
// founder in on the new store's own host.
//
//   validateSignup(input)                 -> { fields, errors }
//   slugFor(storeName)                    -> "my-store" ("" when nothing is left)
//   slugAvailable(slug)                   -> { ok, reason? } reason: format | reserved | taken
//   startSignup({ input, ip })            -> { ok, browserToken, signup } | { errors } | { limited }
//   resendCode({ browserToken })          -> { ok } | { error, status, retryAfter? }
//   verifySignup({ browserToken, code, ip, origin }) -> finishSignup's answer | { error, status }
//   retrySignup({ browserToken, origin }) -> finishSignup's answer | { error, status }
//   finishSignup(row, { origin })         -> { ok, status: "done", redirect } | { ok: false, status: "failed", error }
//   storeHostFor(slug), storeOriginFor(slug, origin)
//
// Rules held here: the code is stored as sha256(signupId:code) and compared in
// constant time; verify, resend and retry act only on the signup whose
// browser_hash matches the se_signup cookie (another browser's signup is never
// read, so its tries are never spent); an email that already has an account
// gets the same answers, the same scrypt work and an email with no code; every
// failed code gets the same words. Nothing here trusts an id from the body.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { platformDb } from "./control.js";
import { findUserByEmail, createUser, addMembership, createInvite, hashPassword, passwordProblem, loginThrottle } from "./identity.js";
import { sendPlatformMail } from "./platform-mail.js";
import { audit } from "./audit.js";
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
export const STUCK_PROVISION_MS = 2 * 60 * 1000;
export const LIMITS = Object.freeze({
  startPerIp: { limit: 5, windowMs: 60 * 60 * 1000 },
  startPerEmail: { limit: 3, windowMs: 60 * 60 * 1000 },
  verifyPerIp: { limit: 20, windowMs: 15 * 60 * 1000 },
});

export const RESERVED_SLUGS = Object.freeze(["www", "admin", "api", "app", "platform", "storeasy", "mail", "help", "status", "signup"]);
// Statuses that hold their slug (the partial unique index) and can still go on.
const LIVE = ["pending", "verified", "provisioning", "failed"];

export const CODE_FAILED = "That code didn't work. Check the newest email we sent, or ask for a new code.";
export const SIGNUP_GONE = "We couldn't find your signup in this browser. Start again.";
export const STUCK_WORDS = "Your store is still being set up. Wait a minute, then try again.";

const now = () => Date.now();
const iso = (ms = now()) => new Date(ms).toISOString();
const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const normEmail = (e) => String(e ?? "").trim().toLowerCase();
const signupId = () => `sgn_${randomBytes(8).toString("hex")}`;
export const codeHash = (id, code) => sha256(`${id}:${code}`);
export const browserHash = (token) => sha256(token);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;
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
  if (!SLUG_RE.test(s)) return { ok: false, reason: "format" };
  if (reservedSlugs().has(s)) return { ok: false, reason: "reserved" };
  const host = storeHostFor(s);
  const tenants = await platformDb().execute("SELECT id, domains FROM tenants");
  for (const row of tenants.rows) {
    if (row.id === s) return { ok: false, reason: "taken" };
    let domains = [];
    try {
      domains = JSON.parse(row.domains || "[]");
    } catch {
      // a broken row holds nothing
    }
    if (domains.some((d) => String(d).toLowerCase().split(":")[0] === host)) return { ok: false, reason: "taken" };
  }
  const held = await platformDb().execute({
    sql: `SELECT 1 FROM signups WHERE slug = ? AND status IN (${LIVE.map(() => "?").join(",")})
            AND NOT (status = 'pending' AND expires_at <= ?) LIMIT 1`,
    args: [s, ...LIVE, iso()],
  });
  return held.rows.length ? { ok: false, reason: "taken" } : { ok: true };
}

export const SLUG_WORDS = {
  format: "Use 2–40 lower-case letters, numbers and hyphens, starting and ending with a letter or number.",
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
  if (!SLUG_RE.test(slug)) errors.slug = SLUG_WORDS.format;
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
  await db.execute({ sql: "DELETE FROM signups WHERE created_at < ?", args: [iso(t - PRUNE_AFTER_MS)] });
  await db.execute({ sql: "UPDATE signups SET status = 'expired', password_hash = NULL, code_hash = NULL, updated_at = ? WHERE status IN ('pending','existing') AND expires_at <= ?", args: [iso(t), iso(t)] });
  await db.execute({ sql: "UPDATE signups SET status = 'superseded', password_hash = NULL, code_hash = NULL, updated_at = ? WHERE email = ? AND status IN ('pending','existing')", args: [iso(t), fields.email] });

  // the scrypt work runs for every email, so an existing account takes as long
  const passwordHash = await hashPassword(fields.password);
  const existing = await findUserByEmail(fields.email);
  const id = signupId();
  const browserToken = randomBytes(32).toString("hex");
  const code = existing ? null : newCode();
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
  slog("signup_started", { signup: id });
  const mail = existing ? EXISTING_MAIL : codeMail(code);
  await sendPlatformMail({ ...mail, to: fields.email, ref: id });
  slog("signup_code_sent", { signup: id });
  return { ok: true, browserToken, signup: publicSignup(fields) };
}

// The same keys for a new and an existing email.
const publicSignup = (f) => ({ email: f.email, storeName: f.storeName, address: storeHostFor(f.slug), codeMinutes: CODE_TTL_MS / 60_000 });

// ---- resend ----------------------------------------------------------------

export async function resendCode({ browserToken }) {
  const row = await byBrowser(browserToken);
  const t = now();
  if (!row || !["pending", "existing"].includes(row.status) || row.expires_at <= iso(t)) return { error: SIGNUP_GONE, status: 400 };
  if (Number(row.sends) >= MAX_SENDS) return { error: "You've asked for the most codes we can send. Start again in a while.", status: 429 };
  const wait = Date.parse(row.last_sent_at || 0) + RESEND_GAP_MS - t;
  if (wait > 0) return { error: "Wait a minute before asking for another code.", status: 429, retryAfter: Math.ceil(wait / 1000) };
  const code = row.status === "pending" ? newCode() : null;
  // each send is a new code with fresh tries; the guard keeps two clicks to one send
  const r = await platformDb().execute({
    sql: `UPDATE signups SET code_hash = ?, code_expires_at = ?, code_attempts = 0, sends = sends + 1, last_sent_at = ?, updated_at = ?
          WHERE id = ? AND sends = ? AND status = ? RETURNING id`,
    args: [code ? codeHash(row.id, code) : null, iso(t + CODE_TTL_MS), iso(t), iso(t), row.id, row.sends, row.status],
  });
  if (!r.rows.length) return { error: "Wait a minute before asking for another code.", status: 429, retryAfter: 60 };
  await sendPlatformMail({ ...(code ? codeMail(code) : EXISTING_MAIL), to: row.email, ref: row.id });
  slog("signup_code_sent", { signup: row.id, resend: true });
  return { ok: true, signup: publicSignup({ email: row.email, storeName: row.store_name, slug: row.slug }) };
}

// ---- verify ----------------------------------------------------------------

const codeFailed = (signup, reason) => {
  slog("signup_verify_failed", { reason, ...(signup ? { signup } : {}) });
  return { error: CODE_FAILED, status: 400 };
};

export async function verifySignup({ browserToken, code, ip = "local", origin }) {
  if ((await loginThrottle(`signup-verify-ip:${ip}`, LIMITS.verifyPerIp)).blocked) return { error: "Too many tries. Wait a few minutes, then try again.", status: 429 };
  const row = await byBrowser(browserToken);
  if (!row) return codeFailed(null, "no_signup");
  const t = iso();
  if (!["pending", "existing"].includes(row.status)) return codeFailed(row.id, `status_${row.status}`);
  if (row.expires_at <= t) {
    await platformDb().execute({ sql: "UPDATE signups SET status = 'expired', password_hash = NULL, code_hash = NULL, updated_at = ? WHERE id = ? AND status IN ('pending','existing')", args: [t, row.id] });
    return codeFailed(row.id, "expired");
  }
  // claim one try first (atomically): five wrong tries and the code is dead
  const tried = await platformDb().execute({
    sql: "UPDATE signups SET code_attempts = code_attempts + 1, updated_at = ? WHERE id = ? AND status IN ('pending','existing') AND code_attempts < ? RETURNING code_hash, code_expires_at",
    args: [t, row.id, CODE_MAX_TRIES],
  });
  const claim = tried.rows[0];
  if (!claim) return codeFailed(row.id, "tries");
  if (!claim.code_hash || claim.code_expires_at <= t) return codeFailed(row.id, claim.code_hash ? "code_expired" : "no_code");
  const given = /^\d{6}$/.test(String(code ?? "").trim()) ? codeHash(row.id, String(code).trim()) : sha256(`${row.id}:invalid`);
  const a = Buffer.from(given, "hex");
  const b = Buffer.from(String(claim.code_hash), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return codeFailed(row.id, "wrong");
  // single use: only one request flips pending → verified
  const flipped = await platformDb().execute({
    sql: "UPDATE signups SET status = 'verified', verified_at = ?, code_hash = NULL, updated_at = ? WHERE id = ? AND status = 'pending' AND code_hash = ? RETURNING *",
    args: [t, t, row.id, claim.code_hash],
  });
  if (!flipped.rows[0]) return codeFailed(row.id, "race");
  return finishSignup({ ...flipped.rows[0] }, { origin });
}

// ---- retry -----------------------------------------------------------------

export async function retrySignup({ browserToken, origin }) {
  const row = await byBrowser(browserToken);
  if (!row) return { error: SIGNUP_GONE, status: 400 };
  if (row.status === "done") return { ok: true, status: "done", loginUrl: `${storeOriginFor(row.slug, origin)}/admin/login` };
  if (!["verified", "failed", "provisioning"].includes(row.status)) return { error: SIGNUP_GONE, status: 400 };
  return finishSignup(row, { origin });
}

// ---- finish: store, user, owner, handoff -------------------------------------

const failWords = (step) =>
  `We couldn't finish setting up your store${step ? ` (the "${step.replace(/_/g, " ")}" step)` : ""}. Nothing you entered is lost: press Try again.`;

export async function finishSignup(row, { origin } = {}) {
  const db = platformDb();
  // claim the row: verified or failed (or a run stuck for a while) → provisioning
  const claimed = await db.execute({
    sql: `UPDATE signups SET status = 'provisioning', error = NULL, updated_at = ?
          WHERE id = ? AND (status IN ('verified','failed') OR (status = 'provisioning' AND updated_at <= ?)) RETURNING *`,
    args: [iso(), row.id, iso(now() - STUCK_PROVISION_MS)],
  });
  const s = claimed.rows[0] ? { ...claimed.rows[0] } : null;
  if (!s) return { ok: false, status: "provisioning", error: STUCK_WORDS };
  const fail = async (step, runId = s.provision_run_id) => {
    await setRow(s.id, { status: "failed", error: failWords(step), provision_run_id: runId || null });
    slog("signup_provision_failed", { signup: s.id, run: runId || null, step: step || null });
    return { ok: false, status: "failed", error: failWords(step), canRetry: true };
  };

  const storeOrigin = storeOriginFor(s.slug, origin);
  let runId = s.provision_run_id;
  try {
    const { runProvision } = await import("./provision.js");
    if (!runId) {
      // a run started before a crash, before its id was saved here
      const earlier = await db.execute({ sql: "SELECT id, params FROM provision_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1", args: [s.slug] });
      const p = earlier.rows[0] ? JSON.parse(earlier.rows[0].params || "{}") : null;
      if (p?.source === "signup" && p?.supportEmail === s.email) runId = earlier.rows[0].id;
    }
    const r = runId
      ? await runProvision({}, { resumeRunId: runId })
      : await runProvision({
          id: s.slug,
          name: s.store_name,
          domains: [storeHostFor(s.slug)],
          siteName: s.store_name,
          supportEmail: s.email,
          contentMode: "documents",
          dbDriver: "file",
          source: "signup",
          siteUrl: storeOrigin,
        });
    runId = r.run.id;
    await setRow(s.id, { provision_run_id: runId, tenant_id: s.slug });
    if (r.failedStep) return fail(r.failedStep, runId);
    if (!r.resumedNoop) await audit({ actor: { kind: "system", id: "signup" }, action: "tenant.provisioned", tenantId: s.slug, diff: { source: "signup", run: runId } });
  } catch (e) {
    slog("signup_provision_error", { signup: s.id, error: String(e?.message || e).slice(0, 200) });
    return fail(null, runId);
  }

  let userId = s.user_id;
  try {
    if (!userId) {
      // the email was proved just now; an account made for it since the
      // signup started is the same person's, and keeps its own password
      const user = (await findUserByEmail(s.email)) || (await createUser({ email: s.email, name: s.name, passwordHash: s.password_hash, emailVerifiedAt: s.verified_at || iso() }));
      userId = user.id;
      await setRow(s.id, { user_id: userId });
    }
    await addMembership(userId, s.slug, "owner");
  } catch (e) {
    slog("signup_user_error", { signup: s.id, error: String(e?.message || e).slice(0, 200) });
    return fail("create_account", runId);
  }
  await setRow(s.id, { status: "done", password_hash: null, code_hash: null });
  await audit({ actor: { kind: "merchant", id: userId, role: "owner" }, action: "signup.verified", tenantId: s.slug, resource: s.id });
  const { token } = await createInvite({ email: s.email, tenantId: s.slug, role: "owner", kind: "handoff", ttlMs: HANDOFF_TTL_MS });
  slog("signup_done", { signup: s.id, tenant: s.slug, run: runId });
  return { ok: true, status: "done", redirect: `${storeOrigin}${HANDOFF_PATH}#t=${token}` };
}

// ---- the routes' shared gate ----------------------------------------------------

// Open only on a marketing host, with a control plane, a store domain and the
// kill switch on. -> null when open, else { status, body } for the route.
export async function signupClosedAnswer(host) {
  const { isPlatformSiteHost } = await import("../platform-site.js");
  if (!isPlatformSiteHost(host)) return { status: 404, body: { error: "Not found" } };
  const { platformConfigured } = await import("./control.js");
  if (!platformConfigured()) return { status: 503, body: { error: "Signups are unavailable right now. Try again soon." } };
  const { flagEnabled } = await import("./flags.js");
  if (!signupStoreDomain() || !(await flagEnabled(SIGNUP_FLAG, null, { fallback: false }))) {
    return { status: 403, body: { error: "Signups are closed right now. Tell us about your store and we'll be in touch.", code: "SIGNUPS_CLOSED", contact: "/contact" } };
  }
  return null;
}

export const SIGNUP_COOKIE_OPTS = Object.freeze({
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SIGNUP_TTL_MS / 1000,
});
