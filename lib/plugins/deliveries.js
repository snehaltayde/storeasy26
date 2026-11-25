// Phase 4 line 3: sending one delivery (the plugin_delivery job). NODE-ONLY
// (it imports the egress guard): only lib/platform/worker.js (a dynamic
// import) and the admin webhooks route load it.
//
// A delivery keeps its own attempts and schedule (not the job queue's
// backoff, whose dead-letter pages operators): a failed attempt re-queues the
// same job with { requeue, runAfter }. Only a Storeasy infrastructure failure
// (the database, decrypting the secret) throws into the job backoff.
//
//   attempt      skipped when the install is off, uninstalled or turned off by
//                Storeasy, the endpoint is paused, the event was pruned, or the
//                app no longer holds the topic's scope (re-checked now)
//   http         signed (Standard Webhooks; two signatures while a rotation
//                overlaps), sent with safeFetch to the endpoint's approved host
//   internal     the first-party handler (lib/plugins/handlers.js) with a
//                narrow context; its fetch is safeFetch on the manifest's egress
//   outcome      2xx delivered; 410 fails it and pauses the endpoint at once;
//                anything else (3xx, 4xx, 5xx, timeout, refused egress) waits
//                RETRY_WAITS_MS[attempt-1] ±20% and tries again, up to
//                MAX_ATTEMPTS, then Failed. An endpoint failing for
//                AUTO_PAUSE_MS with no success is paused (system audit row,
//                owners and admins emailed, best effort).
//   resend()     a Failed or Skipped delivery goes out again (apps.manage).
import { db } from "../db.js";
import { tenantId } from "../tenant-context.js";
import { decryptSecret, decryptJson } from "../platform/crypto.js";
import { getJobByKey, makeJobDue } from "../platform/jobs.js";
import { platformDb, platformConfigured } from "../platform/control.js";
import { audit } from "../platform/audit.js";
import { slog } from "../log.js";
import { bodyFor } from "./topics.js";
import { webhookHeaders } from "./sign.js";
import { safeFetch } from "./egress.js";
import { handlerFor } from "./handlers.js";
import { pluginById } from "./catalog.js";
import { isKilled, AppError } from "./installs.js";
import { deliveryJobKey, enqueueDelivery, storeHost } from "./events.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
export const RETRY_WAITS_MS = Object.freeze([1 * MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR]);
export const MAX_ATTEMPTS = RETRY_WAITS_MS.length + 1;
export const JITTER = 0.2;
export const AUTO_PAUSE_MS = 72 * HOUR;
export const SYSTEM_ACTOR = Object.freeze({ kind: "system", id: "plugin-webhooks" });

export const PAUSE_REASONS = Object.freeze({
  manual: "Paused by your team",
  gone: "The app's address answered 410 Gone, so sending stopped",
  failing: "The app's address hasn't answered for 3 days, so sending stopped",
});

export const retryWait = (attempt, random = Math.random) => {
  const base = RETRY_WAITS_MS[Math.min(attempt, RETRY_WAITS_MS.length) - 1];
  return Math.round(base * (1 + JITTER * (random() * 2 - 1)));
};

const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

async function finish(d, patch, at) {
  await db
    .updateTable("plugin_deliveries")
    .set({ ...patch, updated_at: at })
    .where("id", "=", d.id)
    .where("status", "=", "pending")
    .execute();
}

const skip = async (d, reason, at) => {
  await finish(d, { status: "skipped", last_error: reason, next_attempt_at: null }, at);
  return { deliveryId: d.id, status: "skipped" };
};

// Pause an endpoint for the system (410 or 3 days failing): audit row and a
// best-effort email to the store's owners and admins.
export async function pauseForSystem(installId, kind, at) {
  const r = await db
    .updateTable("plugin_endpoints")
    .set({ status: "paused", paused_reason: PAUSE_REASONS[kind], paused_at: at, updated_at: at, updated_by: `${SYSTEM_ACTOR.kind}:${SYSTEM_ACTOR.id}` })
    .where("install_id", "=", installId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!Number(r?.numUpdatedRows ?? 0)) return false;
  await audit({ actor: SYSTEM_ACTOR, action: "apps.endpoint_auto_paused", resource: `app:${installId}`, diff: { reason: kind } });
  await emailTeam(installId, kind, at).catch((e) => slog("plugin_pause_email_failed", { error: String(e?.message || e).slice(0, 200) }));
  return true;
}

async function emailTeam(installId, kind, at) {
  if (!platformConfigured()) return;
  const { notify } = await import("../notifications.js");
  const install = await db.selectFrom("plugin_installs").select(["name"]).where("id", "=", installId).executeTakeFirst();
  const members = await platformDb().execute({
    sql: "SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND m.role IN ('owner', 'admin') AND u.status = 'active'",
    args: [tenantId()],
  });
  const name = install?.name || "An app";
  for (const m of members.rows) {
    await notify({
      type: "app_webhook_paused",
      to: String(m.email),
      subject: `${name}: webhooks paused`,
      text: `${PAUSE_REASONS[kind]}.\n\nStore events for ${name} are not being sent. Open Apps in your Storeasy console, check the app's address, then choose Resume. Events from while it was paused can be sent again with Resend.`,
      idempotencyKey: `app_webhook_paused:${installId}:${at}:${m.email}`,
    });
  }
}

async function sendHttp(d, install, event, now) {
  const ep = await db.selectFrom("plugin_endpoints").selectAll().where("install_id", "=", install.id).executeTakeFirst();
  if (!ep) return { skip: "The app has no webhook address." };
  if (ep.status === "paused") return { skip: "The webhook is paused, so this wasn't sent. Resend it after you resume." };
  const body = bodyFor(event, parse(install.granted_scopes, []), storeHost());
  if (body === null) return { skip: "The app no longer has permission to see this event." };
  const secrets = [await decryptSecret(ep.secret_enc)];
  if (ep.prev_secret_enc && ep.prev_secret_until && ep.prev_secret_until > new Date(now).toISOString()) secrets.push(await decryptSecret(ep.prev_secret_enc));
  const headers = await webhookHeaders({ id: d.id, timestamp: Math.floor(now / 1000), body, secrets });
  return { result: await safeFetch(ep.url, { allowHosts: [ep.host], body, headers }), endpoint: ep };
}

async function sendInternal(d, install, event, now) {
  const m = pluginById(install.plugin_id);
  const handler = m ? handlerFor(m.id, event.topic) : null;
  if (!handler || !m.events?.includes(event.topic)) return { skip: "This app no longer handles this event." };
  const body = bodyFor(event, parse(install.granted_scopes, []), storeHost());
  if (body === null) return { skip: "The app no longer has permission to see this event." };
  const settings = parse(install.settings, {});
  delete settings.__secret_keys;
  const started = Date.now();
  try {
    const out = await handler({
      event: JSON.parse(body),
      install: { id: String(install.id), settings },
      secrets: async () => (install.secrets_enc ? decryptJson(install.secrets_enc) : {}),
      fetch: (url, opts = {}) => safeFetch(url, { ...opts, allowHosts: m.egress ?? [] }),
      log: (evt, fields = {}) => slog(`plugin_${m.id}_${String(evt).slice(0, 40)}`, { delivery: d.id, ...fields }),
    });
    if (out && out.ok === false) return { result: { ok: false, status: out.status ?? null, error: String(out.error || "The app's call failed").slice(0, 200), ms: Date.now() - started } };
    return { result: { ok: true, status: null, ms: Date.now() - started } };
  } catch (e) {
    slog("plugin_handler_failed", { plugin: m.id, delivery: d.id, error: String(e?.message || e).slice(0, 200) });
    return { result: { ok: false, status: null, error: "The app's handler failed", ms: Date.now() - started } };
  }
}

// The plugin_delivery job. → { deliveryId, status } or { requeue, runAfter }
export async function deliver(deliveryId, { now = Date.now(), random = Math.random } = {}) {
  const at = new Date(now).toISOString();
  const d = await db.selectFrom("plugin_deliveries").selectAll().where("id", "=", String(deliveryId)).executeTakeFirst();
  if (!d) return { deliveryId, missing: true };
  if (d.status !== "pending") return { deliveryId: d.id, already: d.status };
  if (d.next_attempt_at && d.next_attempt_at > at) return { deliveryId: d.id, requeue: true, runAfter: d.next_attempt_at };
  const install = await db.selectFrom("plugin_installs").selectAll().where("id", "=", d.install_id).executeTakeFirst();
  if (!install || install.status !== "enabled" || (install.kind !== "custom" && (await isKilled(install.plugin_id)))) return skip(d, "The app was off, so this wasn't sent.", at);
  const event = await db.selectFrom("plugin_events").selectAll().where("id", "=", d.event_id).executeTakeFirst();
  if (!event) return skip(d, "This event is no longer kept.", at);

  const sent = d.target === "http" ? await sendHttp(d, install, event, now) : await sendInternal(d, install, event, now);
  if (sent.skip) return skip(d, sent.skip, at);
  const r = sent.result;
  const attempts = Number(d.attempts) + 1;
  const common = { attempts, last_attempt_at: at, last_status: r.status ?? null, last_ms: Math.round(r.ms ?? 0) };
  slog("plugin_delivery_attempt", { delivery: d.id, install: d.install_id, attempt: attempts, ok: r.ok, status: r.status ?? null });

  if (r.ok) {
    await finish(d, { ...common, status: "delivered", delivered_at: at, last_error: null, next_attempt_at: null }, at);
    if (sent.endpoint?.failing_since) await db.updateTable("plugin_endpoints").set({ failing_since: null }).where("install_id", "=", install.id).execute();
    return { deliveryId: d.id, status: "delivered" };
  }
  const error = String(r.error || (r.status ? `The app answered ${r.status}` : "Couldn't connect")).slice(0, 200);
  if (sent.endpoint && r.status === 410) {
    await finish(d, { ...common, status: "failed", last_error: error, next_attempt_at: null }, at);
    await pauseForSystem(install.id, "gone", at);
    return { deliveryId: d.id, status: "failed", paused: "gone" };
  }
  let failingSince = sent.endpoint?.failing_since ?? null;
  if (sent.endpoint && !failingSince) {
    failingSince = at;
    await db.updateTable("plugin_endpoints").set({ failing_since: at }).where("install_id", "=", install.id).where("failing_since", "is", null).execute();
  }
  if (sent.endpoint && now - Date.parse(failingSince) >= AUTO_PAUSE_MS) {
    await finish(d, { ...common, status: "failed", last_error: error, next_attempt_at: null }, at);
    await pauseForSystem(install.id, "failing", at);
    return { deliveryId: d.id, status: "failed", paused: "failing" };
  }
  if (attempts >= MAX_ATTEMPTS) {
    await finish(d, { ...common, status: "failed", last_error: error, next_attempt_at: null }, at);
    return { deliveryId: d.id, status: "failed" };
  }
  const runAfter = new Date(now + retryWait(attempts, random)).toISOString();
  await finish(d, { ...common, last_error: error, next_attempt_at: runAfter }, at);
  return { deliveryId: d.id, requeue: true, runAfter };
}

// Queue a delivery's job again (its key is kept: the done job comes back).
export async function requeueDelivery(deliveryId) {
  const job = await getJobByKey(deliveryJobKey(deliveryId));
  if (job) await makeJobDue(job.id);
  else await enqueueDelivery(deliveryId);
}

// Resend a Failed or Skipped delivery: a fresh set of attempts, same webhook-id.
export async function resend(installId, deliveryId, { actor }) {
  const d = await db.selectFrom("plugin_deliveries").selectAll().where("id", "=", String(deliveryId)).where("install_id", "=", installId).executeTakeFirst();
  if (!d) throw new AppError(404, "NOT_FOUND", "We couldn't find that delivery. It may be older than 30 days.");
  if (d.status !== "failed" && d.status !== "skipped") throw new AppError(409, "NOT_RESENDABLE", "Only failed or skipped deliveries can be sent again.");
  if (d.target === "http") {
    const ep = await db.selectFrom("plugin_endpoints").select(["status"]).where("install_id", "=", installId).executeTakeFirst();
    if (ep?.status === "paused") throw new AppError(409, "PAUSED", "The webhook is paused. Resume it, then send this again.");
  }
  const event = await db.selectFrom("plugin_events").select("id").where("id", "=", d.event_id).executeTakeFirst();
  if (!event) throw new AppError(409, "EVENT_GONE", "This event is no longer kept, so it can't be sent again.");
  const at = new Date().toISOString();
  const r = await db
    .updateTable("plugin_deliveries")
    .set({ status: "pending", attempts: 0, next_attempt_at: at, last_error: null, updated_at: at })
    .where("id", "=", d.id)
    .where("status", "=", d.status)
    .executeTakeFirst();
  if (!Number(r?.numUpdatedRows ?? 0)) throw new AppError(409, "CHANGED", "This delivery changed. Reload the page to see it.");
  await requeueDelivery(d.id);
  await audit({ actor, action: "apps.delivery_resent", resource: `app:${installId}`, diff: { delivery: d.id, from: d.status } });
  return { id: d.id, status: "pending" };
}
