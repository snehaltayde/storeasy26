// Phase 1 line 9: an operator creates a store for a founder in one form
// (docs/plans/phase-1.md, Line 9). Node only; every caller has already passed
// platformOperator() (lib/platform/admin-auth.js).
//
// An operator-made store is a signups row with source 'operator', run through
// line 2's provision_store job (lib/platform/signup-provision.js): the same
// steps, retries and failure kinds, and line 8's screen and Resume work on it.
// When the job finishes it emails the owner a 7-day invite instead of making a
// user. The row never lapses (expires_at far in the future, and the lapse rules
// skip source 'operator'); no browser cookie ever matches it.
//
//   validateOperatorStore(input)            -> { fields, errors }
//   checkOperatorStore({ slug, shop, email }) -> the live checks the form shows
//   tenantsUsingShop(shop)                  -> [{ id, name, status }] (any status)
//   createOperatorStore({ input, operator, origin }) -> { ok, signup, jobId } | { errors, status } | { error, status }
//   operatorStoreStatus(signupId, { origin }) -> the progress (and, once done, the facts the done screen shows)
//
// No answer carries a token, an invite link, the app's secret or a database
// address; the secret is stored encrypted (encryptSecret) until the job is done.
import { createHash, randomBytes } from "node:crypto";
import { platformDb } from "./control.js";
import { audit } from "./audit.js";
import { findUserByEmail, loginThrottle } from "./identity.js";
import { encryptSecret } from "./crypto.js";
import { normalizeShopDomain } from "../shopify-origin.js";
import { slog } from "../log.js";
import { slugFor, slugAvailable, slugShapeOk, SLUG_WORDS, EMAIL_RE, signupStoreDomain, storeHostFor, storeOriginFor, stepStates, retryNote } from "./signup.js";

export const CREATE_LIMIT = Object.freeze({ limit: 20, windowMs: 60 * 60 * 1000 });
export const NEVER_EXPIRES = "9999-12-31T23:59:59.999Z";
export const INVITE_STEP_LABEL = "Sending the owner's invite";
// the store's Shopify app sends the founder back here after they approve it
export const CALLBACK_PATH = "/api/admin/shopify/callback";
// statuses that hold a Shopify store for an operator-made row (idx_signups_shop_live)
const LIVE = ["verified", "provisioning", "failed"];

export const WORDS = Object.freeze({
  noDomain: "Stores can't be created here yet: the store address domain (SIGNUP_STORE_DOMAIN) isn't set. Set it, then try again.",
  noDriver: "Stores can't be created here yet: there's no way to make a store database (the Turso API isn't set up). Set it up, then try again.",
  limited: "You've created 20 stores in the last hour. Wait a while, then try again.",
  existingAccount: "They'll accept with their existing Storeasy password.",
  appPair: "Enter both the app's client id and its secret, or leave both empty.",
  slugRace: "Someone just took that address. Choose another.",
  shopRace: "Another store was just created with this Shopify store.",
  gone: "We couldn't find that store setup. Start again from New store.",
});

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

export function validateOperatorStore(input = {}) {
  const storeName = str(input.storeName).trim();
  const email = str(input.email).trim().toLowerCase();
  const founderName = str(input.founderName).trim();
  const slugTyped = str(input.slug).trim().toLowerCase();
  const slug = slugTyped || slugFor(storeName);
  const clientId = str(input.clientId).trim();
  const clientSecret = str(input.clientSecret).trim();
  const errors = {};
  if (storeName.length < 2 || storeName.length > 60) errors.storeName = "The store name needs 2–60 characters.";
  if (!EMAIL_RE.test(email) || email.length > 200) errors.email = "Enter the owner's email address.";
  if (founderName.length > 80) errors.founderName = "Keep the founder's name to 80 characters.";
  const shop = normalizeShopDomain(input.shop);
  if (!shop.ok) errors.shop = shop.words;
  if (!slugShapeOk(slug)) errors.slug = SLUG_WORDS.format;
  if (Boolean(clientId) !== Boolean(clientSecret) || clientId.length > 200 || clientSecret.length > 200) errors.app = WORDS.appPair;
  return { fields: { storeName, email, founderName, slug, shop: shop.ok ? shop.shop : null, clientId: clientId || null, clientSecret: clientSecret || null }, errors };
}

// Every store (any status) whose Shopify store is this one, case-insensitively.
export async function tenantsUsingShop(shop) {
  const s = str(shop).trim().toLowerCase();
  if (!s) return [];
  const r = await platformDb().execute({
    sql: `SELECT id, name, status FROM tenants
          WHERE json_valid(config) AND lower(json_extract(config, '$.shopify_store_domain')) = ? LIMIT 5`,
    args: [s],
  });
  return r.rows.map((t) => ({ id: t.id, name: t.name, status: t.status }));
}

// -> words when the Shopify store is taken, else null
async function shopTaken(shop) {
  const used = await tenantsUsingShop(shop);
  if (used.length) return `${used[0].name} already uses this Shopify store.`;
  const r = await platformDb().execute({
    sql: `SELECT store_name FROM signups WHERE shop_domain = ? AND status IN (${LIVE.map(() => "?").join(",")}) LIMIT 1`,
    args: [shop, ...LIVE],
  });
  return r.rows[0] ? `${r.rows[0].store_name} already uses this Shopify store.` : null;
}

// The form's live checks; each part only when asked for.
//   slug  -> { ok, words?, host }     shop -> { ok, shop?, words? }
//   email -> { existingAccount, words? }
export async function checkOperatorStore({ slug, shop, email } = {}) {
  const out = {};
  if (slug != null && str(slug).trim()) {
    const s = str(slug).trim().toLowerCase();
    const a = await slugAvailable(s);
    out.slug = a.ok ? { ok: true, host: storeHostFor(s) } : { ok: false, words: SLUG_WORDS[a.reason], host: storeHostFor(s) };
  }
  if (shop != null && str(shop).trim()) {
    const n = normalizeShopDomain(shop);
    if (!n.ok) out.shop = { ok: false, words: n.words };
    else {
      const taken = await shopTaken(n.shop);
      out.shop = taken ? { ok: false, shop: n.shop, words: taken } : { ok: true, shop: n.shop };
    }
  }
  if (email != null && EMAIL_RE.test(str(email).trim().toLowerCase())) {
    const existing = Boolean(await findUserByEmail(str(email).trim().toLowerCase()));
    out.email = existing ? { existingAccount: true, words: WORDS.existingAccount } : { existingAccount: false };
  }
  return out;
}

export async function createOperatorStore({ input, operator, origin = null }) {
  if (!signupStoreDomain()) return { error: WORDS.noDomain, status: 503 };
  const { signupDbDriver } = await import("./provisioner.js");
  if (!signupDbDriver()) return { error: WORDS.noDriver, status: 503 };
  const { fields, errors } = validateOperatorStore(input);
  if (Object.keys(errors).length) return { errors, status: 400 };
  const avail = await slugAvailable(fields.slug);
  if (!avail.ok) errors.slug = SLUG_WORDS[avail.reason];
  const taken = await shopTaken(fields.shop);
  if (taken) errors.shop = taken;
  if (Object.keys(errors).length) return { errors, status: 409 };
  // only a create that would go ahead counts toward the hourly limit
  if ((await loginThrottle(`operator-create:${operator.id}`, CREATE_LIMIT)).blocked) return { error: WORDS.limited, status: 429 };

  const id = `sgn_${randomBytes(8).toString("hex")}`;
  const t = iso();
  const secretEnc = fields.clientSecret ? await encryptSecret(fields.clientSecret) : null;
  try {
    await platformDb().execute({
      sql: `INSERT INTO signups (id, email, name, store_name, slug, password_hash, browser_hash, code_attempts, sends, status, ip,
              created_at, updated_at, verified_at, expires_at, source, created_by, shop_domain, shopify_client_id, shopify_secret_enc)
            VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, 'verified', NULL, ?, ?, ?, ?, 'operator', ?, ?, ?, ?)`,
      // no cookie ever matches: the browser hash is of 32 random bytes nobody keeps
      args: [id, fields.email, fields.founderName, fields.storeName, fields.slug, sha256(randomBytes(32)), t, t, t, NEVER_EXPIRES, String(operator.id), fields.shop, fields.clientId, secretEnc],
    });
  } catch (e) {
    const m = String(e?.message || e);
    if (/UNIQUE/i.test(m) && /shop_domain/.test(m)) return { errors: { shop: WORDS.shopRace }, status: 409 };
    if (/UNIQUE/i.test(m) && /slug/.test(m)) return { errors: { slug: WORDS.slugRace }, status: 409 };
    throw e;
  }
  const row = (await platformDb().execute({ sql: "SELECT * FROM signups WHERE id = ?", args: [id] })).rows[0];
  const { claimSignupProvision } = await import("./signup-provision.js");
  const q = await claimSignupProvision({ ...row }, { siteUrl: storeOriginFor(fields.slug, origin) });
  await audit({
    actor: { kind: "operator", id: String(operator.id) },
    action: "tenant.provision",
    tenantId: fields.slug,
    resource: `signup:${id}`,
    diff: { via: "operator-form", signup: id, slug: fields.slug, shop: fields.shop, appReady: Boolean(fields.clientId) },
  });
  slog("operator_store_queued", { signup: id, job: q.jobId || null });
  return { ok: true, signup: id, jobId: q.jobId || null };
}

async function operatorRow(signupId) {
  if (!/^sgn_[0-9a-f]{16}$/.test(str(signupId))) return null;
  const r = await platformDb().execute({ sql: "SELECT * FROM signups WHERE id = ? AND source = 'operator'", args: [signupId] });
  return r.rows[0] ? { ...r.rows[0] } : null;
}

// What the progress and done screens show. A job that is due runs here (as
// signupStatus does for a founder; the every-minute tick is the backstop).
// -> { ok, status: provisioning | failed | done, steps, note?, failureKind?, canRetry?, done? } | { error, status }
export async function operatorStoreStatus(signupId, { origin = null } = {}) {
  let row = await operatorRow(signupId);
  if (!row) return { error: WORDS.gone, status: 404 };
  const SP = await import("./signup-provision.js");
  if (row.status === "provisioning" && row.job_id && (!row.next_attempt_at || Date.parse(row.next_attempt_at) <= SP.signupClock.now())) {
    const { makeJobDue } = await import("./jobs.js");
    const { runJobById } = await import("./worker.js");
    await makeJobDue(row.job_id);
    await runJobById(row.job_id, { budgetMs: 50_000 });
    row = (await operatorRow(signupId)) || row;
  }
  const { getProvisionRun } = await import("./provision.js");
  const run = row.provision_run_id ? await getProvisionRun(row.provision_run_id) : null;
  const steps = stepStates(row, run, { lastLabel: INVITE_STEP_LABEL });
  const base = { ok: true, signup: row.id, storeName: row.store_name, address: storeHostFor(row.slug), subject: `tenant:${row.slug}` };
  if (row.status === "done") {
    return {
      ...base,
      status: "done",
      steps,
      done: {
        inviteTo: row.email,
        invite: row.invite_status || "failed",
        appReady: Boolean(row.shopify_client_id),
        shop: row.shop_domain,
        redirectUrl: `${storeOriginFor(row.slug, origin)}${CALLBACK_PATH}`,
      },
    };
  }
  if (row.status === "failed") return { ...base, status: "failed", steps, failureKind: row.failure_kind || "needs_operator", canRetry: true };
  const answer = { ...base, status: "provisioning", steps };
  const note = retryNote(row, SP.signupClock.now(), SP.MAX_RETRIES);
  if (note) answer.note = note;
  return answer;
}
