// Phase 9 step 0: first-party plugins' scheduled work, in code (like
// handlers.js). Node only. One plugin_sweep job per 10-minute window, queued
// from /api/jobs/tick (the idempotency key dedupes repeated ticks, as
// queueOnboardingSweep does); the worker runs sweepPlugins().
//
//   registerSweep(pluginId, fn)  → an undo function. A test seam, and the way
//       a line adds a sweep outside BUILT_IN. A plugin has at most one sweep.
//   sweepPlugins({ deadline, now })  walks every active store; inside
//       withTenant, every enabled install of a plugin with a sweep that
//       Storeasy hasn't turned off (isKilled) gets
//         fn({ install: { id, pluginId, settings }, now, secrets(), fetch(url, opts), log(evt, fields) })
//       now is the job's clock in ms; fetch is safeFetch bound to the
//       manifest's egress list. A throw is logged and counted, never retried
//       here (the next window runs again). Stops before a store once the
//       deadline has passed. -> { stores, ran, failed }
//   queuePluginSweep(now)  one job per window; nothing when no sweep exists.
import { db } from "../db.js";
import { withTenant } from "../tenant-context.js";
import { listTenants, getTenant } from "../platform/control.js";
import { enqueueJob } from "../platform/jobs.js";
import { decryptJson } from "../platform/crypto.js";
import { slog } from "../log.js";
import { safeFetch } from "./egress.js";
import { pluginById } from "./catalog.js";
import { isKilled } from "./installs.js";
import { handlerFetchOptions } from "./deliveries.js";

export const PLUGIN_SWEEP_JOB = "plugin_sweep";
export const PLUGIN_SWEEP_WINDOW_MS = 10 * 60 * 1000;
export const sweepClock = { now: () => Date.now() };

// Phase 9 lines import their sweep above BUILT_IN and add a
// `"<id>": fn` entry at their own anchor (one per line).
// p9: reviews
import { sweepReviews } from "./first-party/reviews/sweep.js";
// p9: subscriptions
// p9: whatsapp
import { sweepCarts as whatsappSweep } from "./first-party/whatsapp/sweep.js";
// p9: shiprocket
import { shiprocketSweep } from "./first-party/shiprocket/sweep.js";
// p9: ai-copilot
const BUILT_IN = Object.freeze({
  // p9: reviews
  reviews: sweepReviews,
  // p9: subscriptions
  // p9: whatsapp
  whatsapp: whatsappSweep,
  // p9: shiprocket
  shiprocket: shiprocketSweep,
  // p9: ai-copilot
});
let extra = {};

export const sweepFor = (pluginId) => (Object.hasOwn(extra, pluginId) ? extra[pluginId] : Object.hasOwn(BUILT_IN, pluginId) ? BUILT_IN[pluginId] : null);
export const sweepPluginIds = () => [...new Set([...Object.keys(BUILT_IN), ...Object.keys(extra)])].filter((id) => typeof sweepFor(id) === "function");

export function registerSweep(pluginId, fn) {
  if (typeof fn !== "function") throw new TypeError("registerSweep needs a function");
  const id = String(pluginId);
  extra = { ...extra, [id]: fn };
  return () => {
    if (extra[id] !== fn) return;
    const { [id]: _gone, ...rest } = extra;
    extra = rest;
  };
}

const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

async function sweepStore(ids, now) {
  const rows = await db.selectFrom("plugin_installs").selectAll().where("status", "=", "enabled").where("plugin_id", "in", ids).orderBy("installed_at", "asc").execute();
  let ran = 0;
  let failed = 0;
  for (const row of rows) {
    const fn = sweepFor(row.plugin_id);
    const m = pluginById(row.plugin_id);
    if (!fn || !m || (await isKilled(row.plugin_id))) continue;
    const settings = parse(row.settings, {});
    delete settings.__secret_keys;
    ran++;
    try {
      await fn({
        install: { id: String(row.id), pluginId: String(row.plugin_id), settings },
        now,
        secrets: async () => (row.secrets_enc ? decryptJson(row.secrets_enc) : {}),
        fetch: (url, opts = {}) => safeFetch(url, { ...handlerFetchOptions(opts), allowHosts: m.egress ?? [] }),
        log: (evt, fields = {}) => slog(`plugin_${m.id}_${String(evt).slice(0, 40)}`, { install: String(row.id), ...fields }),
      });
    } catch (e) {
      failed++;
      slog("plugin_sweep_failed", { plugin: m.id, install: String(row.id), error: String(e?.message || e).slice(0, 200) });
    }
  }
  return { ran, failed };
}

export async function sweepPlugins({ deadline = null, now = sweepClock.now } = {}) {
  const ids = sweepPluginIds();
  const out = { stores: 0, ran: 0, failed: 0 };
  if (!ids.length) return out;
  for (const row of await listTenants()) {
    if (row.status !== "active") continue;
    if (deadline != null && now() >= deadline) break;
    const tenant = await getTenant(row.id, { fresh: true }).catch(() => null);
    if (!tenant || tenant.status !== "active") continue;
    out.stores++;
    try {
      const r = await withTenant(tenant, () => sweepStore(ids, now()));
      out.ran += r.ran;
      out.failed += r.failed;
    } catch (e) {
      // the store's database can't be read (or lacks the table): log, carry on
      out.failed++;
      slog("plugin_sweep_store_failed", { tenant: row.id, error: String(e?.message || e).slice(0, 200) });
    }
  }
  slog("plugin_sweep", out);
  return out;
}

export async function queuePluginSweep(now = sweepClock.now()) {
  if (!sweepPluginIds().length) return null;
  const windowStart = Math.floor(now / PLUGIN_SWEEP_WINDOW_MS);
  return enqueueJob({ type: PLUGIN_SWEEP_JOB, idempotencyKey: `${PLUGIN_SWEEP_JOB}:${windowStart}`, maxAttempts: 1 });
}
