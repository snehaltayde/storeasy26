// Phase 9 line 3: WhatsApp messages. SERVER-ONLY, tenant-scoped (withTenant).
// No node: imports and no network of its own: the Meta provider calls through
// the fetch it is handed (a plugin handler's or sweep's ctx.fetch, safeFetch
// bound to the manifest's egress list, graph.facebook.com only).
//
// Providers (WHATSAPP_PROVIDER):
//   stub  records the message as a notifications row (provider_id
//         whatsapp-stub) and sends nothing. Outside production it is the
//         default; in production it is never chosen and throws if called.
//   meta  the WhatsApp Cloud API (template messages), with the store's own
//         phone-number id (a setting) and access token (a secret).
//   In production with no provider, connection() says "not connected" and
//   nothing sends.
//
// Templates (whatsapp_templates): four kinds, seeded from DEFAULT_TEMPLATES
// as drafts. Only an approved template sends; any edit returns it to draft.
// Vars are fixed: {store} {order} {total} {link} {first_name} {stop}; every
// body must carry {link} and {stop} (the signed opt-out link). For Meta, the
// vars are sent as the body's positional parameters ({{1}}, {{2}} …) in the
// order they first appear in the preview.
//
// sendGated() is the only way a message leaves: it re-reads the consent at
// send time (lib/messaging/consent.js liveConsent), then the template, then
// (marketing only) quiet hours and the caps (lib/messaging/caps.js).
import { db, libsql } from "../db.js";
import { slog } from "../log.js";
import { audit } from "../platform/audit.js";
import { currentTenant } from "../tenant-context.js";
import { liveConsent, phoneProven, stopToken } from "./consent.js";
import { capGuard, inQuietHours, marketingRoom, storeTimeZone } from "./caps.js";
import { DEFAULT_TEMPLATES, KIND_WORDS } from "../plugins/first-party/whatsapp/templates.js";

export const GRAPH_HOST = "graph.facebook.com";
export const GRAPH_VERSION = "v27.0"; // developers.facebook.com, read 2026-11-26
export const KINDS = Object.freeze(["order_confirmed", "order_shipped", "order_delivered", "cart_reminder"]);
export const MARKETING_KINDS = Object.freeze(["cart_reminder"]);
export const VARS = Object.freeze(["store", "order", "total", "link", "first_name", "stop"]);
export const BODY_MAX = 1024;
export { DEFAULT_TEMPLATES, KIND_WORDS };

export class WhatsAppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const prod = () => process.env.NODE_ENV === "production";
const ntfId = () => "ntf_" + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");
const nowIso = (now) => new Date(now ?? Date.now()).toISOString();

// --- templates --------------------------------------------------------------
const VAR_RE = /\{([a-z_]+)\}/g;
export const varsIn = (body) => [...new Set([...String(body).matchAll(VAR_RE)].map((m) => m[1]))];

export function templateProblems({ body, provider_template, language }) {
  const out = [];
  const b = String(body ?? "");
  if (!b.trim() || b.length > BODY_MAX) out.push(`The message needs 1 to ${BODY_MAX} characters.`);
  const unknown = varsIn(b).filter((v) => !VARS.includes(v));
  if (unknown.length) out.push(`Only these fields can be used: ${VARS.map((v) => `{${v}}`).join(" ")}. Remove {${unknown[0]}}.`);
  if (!b.includes("{link}")) out.push("The message needs the {link} field.");
  if (!b.includes("{stop}")) out.push("The message needs the {stop} field, so every shopper can stop messages.");
  if (provider_template != null && provider_template !== "" && !/^[a-z0-9_]{1,512}$/.test(String(provider_template))) out.push("The Meta template name uses lower-case letters, digits and _ only.");
  if (language != null && !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(String(language))) out.push("The language is a code like en or en_US.");
  return out;
}

export async function ensureTemplates({ now } = {}) {
  const at = nowIso(now);
  for (const kind of KINDS) {
    await db
      .insertInto("whatsapp_templates")
      .values({ kind, provider_template: kind, language: "en", body: DEFAULT_TEMPLATES[kind], status: "draft", approved_by: null, approved_at: null, updated_by: null, updated_at: at })
      .onConflict((oc) => oc.column("kind").doNothing())
      .execute();
  }
}

export async function listTemplates() {
  await ensureTemplates();
  const rows = await db.selectFrom("whatsapp_templates").selectAll().execute();
  return KINDS.map((k) => rows.find((r) => r.kind === k)).map((r) => ({ kind: r.kind, words: KIND_WORDS[r.kind], marketing: MARKETING_KINDS.includes(r.kind), providerTemplate: r.provider_template ?? "", language: r.language, body: r.body, status: r.status, approvedAt: r.approved_at ?? null, updatedAt: r.updated_at }));
}

const actorRef = (actor) => `${actor.kind}:${actor.id}`;

export async function saveTemplate(kind, input = {}, { actor, installId = null, now } = {}) {
  if (!KINDS.includes(kind)) throw new WhatsAppError(404, "NOT_FOUND", "That message isn't offered.");
  await ensureTemplates();
  const cur = await db.selectFrom("whatsapp_templates").selectAll().where("kind", "=", kind).executeTakeFirstOrThrow();
  const next = {
    body: input.body !== undefined ? String(input.body) : cur.body,
    provider_template: input.provider_template !== undefined ? String(input.provider_template ?? "").trim() : cur.provider_template,
    language: input.language !== undefined ? String(input.language ?? "").trim() : cur.language,
  };
  const problems = templateProblems(next);
  if (problems.length) throw new WhatsAppError(422, "TEMPLATE_INVALID", problems[0]);
  const changed = next.body !== cur.body || next.provider_template !== cur.provider_template || next.language !== cur.language;
  if (!changed) return (await listTemplates()).find((t) => t.kind === kind);
  // any edit returns it to draft: the founder approves the words that will send
  await db.updateTable("whatsapp_templates").set({ ...next, status: "draft", approved_by: null, approved_at: null, updated_by: actorRef(actor), updated_at: nowIso(now) }).where("kind", "=", kind).execute();
  await audit({ actor, action: "apps.whatsapp_template_save", resource: installId ? `app:${installId}` : "app:whatsapp", diff: { template: kind, status: { from: cur.status, to: "draft" } } });
  return (await listTemplates()).find((t) => t.kind === kind);
}

export async function approveTemplate(kind, { actor, installId = null, now } = {}) {
  if (!KINDS.includes(kind)) throw new WhatsAppError(404, "NOT_FOUND", "That message isn't offered.");
  await ensureTemplates();
  const cur = await db.selectFrom("whatsapp_templates").selectAll().where("kind", "=", kind).executeTakeFirstOrThrow();
  const problems = templateProblems(cur);
  if (!cur.provider_template) problems.push("Add the Meta template name first.");
  if (problems.length) throw new WhatsAppError(422, "TEMPLATE_INVALID", problems[0]);
  if (cur.status !== "approved") {
    await db.updateTable("whatsapp_templates").set({ status: "approved", approved_by: actorRef(actor), approved_at: nowIso(now) }).where("kind", "=", kind).where("updated_at", "=", cur.updated_at).execute();
    await audit({ actor, action: "apps.whatsapp_template_approve", resource: installId ? `app:${installId}` : "app:whatsapp", diff: { template: kind, status: { from: cur.status, to: "approved" } } });
  }
  return (await listTemplates()).find((t) => t.kind === kind);
}

export const render = (body, vars) => String(body).replace(VAR_RE, (m, k) => (VARS.includes(k) ? String(vars?.[k] ?? "") : m));

// --- providers --------------------------------------------------------------
export const stub = {
  name: "stub",
  providerId: "whatsapp-stub",
  async send() {
    if (prod()) throw new Error("The WhatsApp stub never runs in production");
    return { ok: true };
  },
};

export const meta = {
  name: "meta",
  providerId: "whatsapp-meta",
  // POST /<version>/<phone-number-id>/messages, a template message
  async send({ to, template, vars, settings, secrets, fetch }) {
    const phoneId = String(settings?.phone_number_id ?? "").trim();
    if (!/^\d{5,20}$/.test(phoneId) || !secrets?.access_token) return { ok: false, error: "not_connected" };
    const parameters = varsIn(template.body).map((k) => ({ type: "text", text: String(vars?.[k] ?? "") }));
    const body = JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/^\+/, ""),
      type: "template",
      template: { name: template.provider_template, language: { code: template.language || "en" }, components: [{ type: "body", parameters }] },
    });
    const r = await fetch(`https://${GRAPH_HOST}/${GRAPH_VERSION}/${phoneId}/messages`, { body, headers: { "content-type": "application/json", authorization: `Bearer ${secrets.access_token}` } });
    return r?.ok ? { ok: true } : { ok: false, status: r?.status ?? null, error: "provider_refused" };
  },
};

const PROVIDERS = { stub, meta };

export function whatsappProvider(env = process.env) {
  const name = String(env.WHATSAPP_PROVIDER || "").trim() || (env.NODE_ENV === "production" ? "" : "stub");
  if (!name || (name === "stub" && env.NODE_ENV === "production")) return null;
  return Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : null;
}

// secretsSet: { access_token: bool, app_secret: bool, … } (lib/plugins/installs.js view)
export function connection({ settings = {}, secretsSet = {} } = {}, env = process.env) {
  const p = whatsappProvider(env);
  if (!p) return { provider: null, connected: false, words: "Not connected: no WhatsApp provider is set up for this store, so nothing is sent." };
  if (p.name === "stub") return { provider: "stub", connected: true, words: "Test mode: messages are recorded here and not sent to anyone." };
  const ready = /^\d{5,20}$/.test(String(settings.phone_number_id ?? "")) && secretsSet.access_token && secretsSet.app_secret;
  return ready
    ? { provider: "meta", connected: true, words: "Connected to the WhatsApp Cloud API." }
    : { provider: "meta", connected: false, words: "Not connected: add the phone number ID, access token and app secret in Settings." };
}

// --- the send ---------------------------------------------------------------
// One message, once: the idempotency key's row is the claim. A marketing row
// is written only while the caps allow it, counted in the same statement
// (dailyCap: the store's). → { id } | { duplicate: true } | { capped: true }
const COLS = ["id", "type", "recipient", "subject", "body", "status", "error", "provider_id", "consent_class", "consent_ref", "idempotency_key", "created_at", "sent_at"];
export async function sendWhatsApp({ to, template, vars, consentClass, consentRef, idempotencyKey, provider, settings, secrets, fetch, now, dailyCap }) {
  if (!template || template.status !== "approved") throw new WhatsAppError(409, "TEMPLATE_UNAPPROVED", "Only an approved template sends.");
  if (consentClass === "marketing" && !consentRef) throw new WhatsAppError(409, "NO_CONSENT", "A marketing message needs the shopper's consent.");
  if (!idempotencyKey) throw new WhatsAppError(500, "NO_KEY", "A WhatsApp send needs an idempotency key.");
  if (provider === stub && prod()) throw new Error("The WhatsApp stub never runs in production");
  const at = nowIso(now);
  const id = ntfId();
  const values = [id, `whatsapp_${template.kind}`, to, "WhatsApp", render(template.body, vars), "queued", null, provider.providerId, consentClass, consentRef ?? null, idempotencyKey, at, null];
  const guard = consentClass === "marketing" ? capGuard({ phone: to, now: now ?? Date.now(), dailyCap }) : { where: "1 = 1", args: [] };
  const r = await libsql.execute({
    sql: `INSERT OR IGNORE INTO notifications (${COLS.join(", ")}) SELECT ${COLS.map(() => "?").join(", ")} WHERE ${guard.where}`,
    args: [...values, ...guard.args],
  });
  if (!Number(r?.rowsAffected ?? 0)) {
    const held = await db.selectFrom("notifications").select("id").where("idempotency_key", "=", idempotencyKey).executeTakeFirst();
    return held ? { duplicate: true } : { capped: true };
  }
  let out;
  try {
    out = await provider.send({ to, template, vars, settings, secrets, fetch });
  } catch (e) {
    out = { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
  await db.updateTable("notifications").set(out.ok ? { status: "sent", sent_at: nowIso(now) } : { status: "failed", error: String(out.error || "failed").slice(0, 120) }).where("id", "=", id).execute();
  return out.ok ? { id } : { id, failed: true, status: out.status ?? null };
}

const isLocal = (host) => /^(localhost|127\.|\[::1\])|\.localhost(:\d+)?$|\.test(:\d+)?$/.test(host);
export function storeUrl(path) {
  const host = currentTenant()?.domains?.[0] ?? "";
  return host ? `${isLocal(host) ? "http" : "https"}://${host}${path}` : path;
}

// kind, purpose ("updates" | "marketing"), phone (E.164), the binding the
// consent must match (cartId and/or customerId), key, vars; install { settings },
// secrets() and fetch from the plugin ctx. → { sent: id } | { skipped: reason }
export async function sendGated({ kind, purpose, phone, cartId = null, customerId = null, key, vars = {}, install, secrets, fetch, now = Date.now(), log = slog }) {
  const skip = (reason) => {
    log("wa_skipped", { reason, kind });
    return { skipped: reason };
  };
  const provider = whatsappProvider();
  if (!provider) return skip("not_connected");
  if (!phone) return skip("no_phone");
  // re-checked here, at send time: a revocation since the event stops this send
  const consent = await liveConsent({ purpose, phone, cartId, customerId });
  if (!consent) return skip("no_consent");
  await ensureTemplates();
  const template = await db.selectFrom("whatsapp_templates").selectAll().where("kind", "=", kind).executeTakeFirst();
  if (!template || template.status !== "approved") return skip("template_unapproved");
  const marketing = purpose === "marketing";
  if (marketing) {
    if (inQuietHours(now, storeTimeZone())) return skip("quiet_hours");
    // offers only to a number that was on a placed order here (consent.js phoneProven)
    if (!(await phoneProven(consent.phone_e164))) return skip("phone_unproven");
    const full = await marketingRoom({ phone: consent.phone_e164, now, dailyCap: Number(install?.settings?.daily_cap) });
    if (full) return skip(full);
  }
  const allSecrets = provider === meta ? await secrets?.() : {};
  const r = await sendWhatsApp({
    to: consent.phone_e164,
    template,
    vars: { store: "", order: "", total: "", first_name: "there", ...vars, stop: storeUrl(`/m/stop?t=${await stopToken(consent.id, { now })}`) },
    consentClass: marketing ? "marketing" : "transactional",
    consentRef: consent.id,
    idempotencyKey: key,
    provider,
    settings: install?.settings ?? {},
    secrets: allSecrets,
    fetch,
    now,
    dailyCap: Number(install?.settings?.daily_cap),
  });
  if (r.duplicate) return skip("already_sent");
  if (r.capped) return skip("capped");
  if (r.failed) return { skipped: "provider_failed", id: r.id, status: r.status };
  log("wa_sent", { kind, provider: provider.name });
  return { sent: r.id, consentId: consent.id };
}

// --- inbound (app/api/whatsapp/webhook) -------------------------------------
// Meta's X-Hub-Signature-256: "sha256=" + hex HMAC-SHA256 of the raw body,
// keyed with the app secret (developers.facebook.com, read 2026-11-26).
export const STOP_WORDS = Object.freeze(["STOP", "STOP ALL", "UNSUBSCRIBE", "CANCEL"]);
const hexOf = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
export async function hubSignature(appSecret, rawBody) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(appSecret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sha256=${hexOf(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)))}`;
}
