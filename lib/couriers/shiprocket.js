// Phase 9 line 4: Shiprocket, the courier aggregator. SERVER-ONLY (Node),
// tenant-scoped: runs inside withTenant(), its caches live in the store's own
// database. Never imported by app/(storefront) or components/ (test-shiprocket
// walks the imports).
//
//   courierProvider()  the provider this process may use: SHIPROCKET_PROVIDER
//       ("live" | "stub"); outside production the stub is the default; in
//       production only "live" (the stub is never picked there, and refuses).
//   login(creds)       an API token, cached encrypted in courier_auth for 9 days
//       (Shiprocket's last 10)
//   serviceability(pin, { cod, weight }, { settings, secrets, timeoutMs })
//       → { serviceable, cod, minDays, maxDays } | null; cached 12 h per PIN
//   trackAwb(awb, { secrets, timeoutMs }) → parseTrack(…) | null
// Every live call goes through courierFetch (the egress URL rules and DNS
// guard) to EGRESS hosts only. Docs read 2026-11-26 (apidocs.shiprocket.in).
import { db } from "../db.js";
import { encryptSecret, decryptSecret } from "../platform/crypto.js";
import { notMigratedYet } from "../schema-shape.js";
import { slog } from "../log.js";
import { courierFetch } from "./http.js";
import { stub } from "./stub.js";
import { AWB_RE, parseServiceability, parseTrack } from "./normalize.js";

export const EGRESS = Object.freeze(["apiv2.shiprocket.in"]);
const BASE = "https://apiv2.shiprocket.in/v1/external";
export const TOKEN_TTL_MS = 9 * 24 * 60 * 60 * 1000;
export const PIN_CACHE_MS = 12 * 60 * 60 * 1000;
export const SHOPPER_TIMEOUT_MS = 1500;
export const JOB_TIMEOUT_MS = 5000;
export const courierClock = { now: () => Date.now() };

const prod = () => process.env.NODE_ENV === "production";

const live = {
  name: "live",
  login: ({ email, password }, { timeoutMs }) => courierFetch(`${BASE}/auth/login`, { allowHosts: EGRESS, method: "POST", body: JSON.stringify({ email, password }), timeoutMs }),
  serviceability: ({ token, pickup, pin, weightKg, cod }, { timeoutMs }) =>
    courierFetch(`${BASE}/courier/serviceability/?${new URLSearchParams({ pickup_postcode: pickup, delivery_postcode: pin, weight: String(weightKg), cod: cod ? "1" : "0" })}`, { allowHosts: EGRESS, headers: { authorization: `Bearer ${token}` }, timeoutMs }),
  track: ({ token, awb }, { timeoutMs }) => courierFetch(`${BASE}/courier/track/awb/${encodeURIComponent(awb)}`, { allowHosts: EGRESS, headers: { authorization: `Bearer ${token}` }, timeoutMs }),
};

let injected = null;
// Tests swap the provider (never in production).
export function setCourierProvider(p) {
  if (prod()) throw new Error("setCourierProvider: not in production");
  injected = p;
}
export function courierProvider() {
  if (injected) return injected;
  const name = (process.env.SHIPROCKET_PROVIDER || "").trim() || (prod() ? "live" : "stub");
  if (name === "live") return live;
  if (name === "stub" && !prod()) return stub;
  return null;
}

const missing = (e, table) => notMigratedYet(e, { table });
const iso = (ms) => new Date(ms).toISOString();

async function cachedToken(now) {
  try {
    const row = await db.selectFrom("courier_auth").selectAll().where("provider", "=", "shiprocket").executeTakeFirst();
    if (!row || Date.parse(row.expires_at) <= now) return null;
    return await decryptSecret(row.token_enc);
  } catch (e) {
    if (missing(e, "courier_auth")) return null;
    return null; // an undecryptable token is a fresh login
  }
}

async function storeToken(token, now) {
  try {
    const enc = await encryptSecret(token);
    const expires = iso(now + TOKEN_TTL_MS);
    await db.insertInto("courier_auth").values({ provider: "shiprocket", token_enc: enc, expires_at: expires }).onConflict((oc) => oc.column("provider").doUpdateSet({ token_enc: enc, expires_at: expires })).execute();
  } catch (e) {
    slog("courier_token_not_cached", { error: String(e?.name || "Error") });
  }
}

export async function forgetToken() {
  await db.deleteFrom("courier_auth").where("provider", "=", "shiprocket").execute().catch(() => {});
}

// → a token, or null (no credentials, refused, or no provider)
export async function login(secrets, { timeoutMs = JOB_TIMEOUT_MS, provider = courierProvider(), fresh = false } = {}) {
  if (!provider) return null;
  const email = typeof secrets?.email === "string" ? secrets.email.trim() : "";
  const password = typeof secrets?.api_password === "string" ? secrets.api_password : "";
  if (!email || !password) return null;
  const now = courierClock.now();
  if (!fresh) {
    const t = await cachedToken(now);
    if (t) return t;
  }
  const r = await provider.login({ email, password }, { timeoutMs });
  const token = r?.ok && typeof r.json?.token === "string" && r.json.token ? r.json.token : null;
  if (!token) {
    slog("courier_login_failed", { status: r?.status ?? null, error: r?.error ?? null });
    return null;
  }
  await storeToken(token, now);
  return token;
}

// A call with the cached token; one fresh login when Shiprocket says 401.
async function authed(call, creds, opts) {
  let token = await login(creds, opts);
  if (!token) return null;
  let r = await call(token);
  if (r?.status === 401) {
    await forgetToken();
    token = await login(creds, { ...opts, fresh: true });
    if (!token) return null;
    r = await call(token);
  }
  return r;
}

async function cachedPin(pin, now) {
  try {
    const row = await db.selectFrom("courier_pin_cache").selectAll().where("pin", "=", pin).executeTakeFirst();
    if (!row || Date.parse(row.fetched_at) + PIN_CACHE_MS <= now) return null;
    return { serviceable: Boolean(row.serviceable), cod: Boolean(row.cod), minDays: row.min_days ?? null, maxDays: row.max_days ?? null };
  } catch {
    return null;
  }
}

async function storePin(pin, a, now) {
  const v = { serviceable: a.serviceable ? 1 : 0, cod: a.cod ? 1 : 0, min_days: a.minDays, max_days: a.maxDays, fetched_at: iso(now) };
  await db.insertInto("courier_pin_cache").values({ pin, ...v }).onConflict((oc) => oc.column("pin").doUpdateSet(v)).execute().catch(() => {});
}

// creds: { email (settings), api_password (secret) }; settings: pickup_pin, default_weight_g
export async function serviceability(pin, { cod = false, weight = null } = {}, { settings = {}, creds = {}, timeoutMs = SHOPPER_TIMEOUT_MS, provider = courierProvider() } = {}) {
  const p = String(pin ?? "").trim();
  const pickup = String(settings.pickup_pin ?? "").trim();
  if (!/^[1-9]\d{5}$/.test(p) || !/^[1-9]\d{5}$/.test(pickup) || !provider) return null;
  const now = courierClock.now();
  const hit = await cachedPin(p, now);
  if (hit) return hit;
  const grams = Number.isInteger(weight) ? weight : Number.isInteger(settings.default_weight_g) ? settings.default_weight_g : 500;
  const r = await authed((token) => provider.serviceability({ token, pickup, pin: p, weightKg: Math.max(0.1, Math.min(30, grams / 1000)), cod }, { timeoutMs }), creds, { timeoutMs, provider });
  const a = r ? parseServiceability(r.json) : null;
  if (!a) return null;
  await storePin(p, a, now);
  return a;
}

export async function trackAwb(awb, { creds = {}, timeoutMs = JOB_TIMEOUT_MS, provider = courierProvider() } = {}) {
  if (!AWB_RE.test(String(awb ?? "")) || !provider) return null;
  const r = await authed((token) => provider.track({ token, awb }, { timeoutMs }), creds, { timeoutMs, provider });
  if (!r?.ok) return null;
  return parseTrack(r.json);
}
