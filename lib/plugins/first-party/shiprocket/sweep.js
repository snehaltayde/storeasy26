// Phase 9 line 4: Shiprocket's server work. SERVER-ONLY (Node), inside
// withTenant(). Never imported by app/(storefront) or components/.
//
//   shiprocketSweep({ install, now, secrets, log })   the plugin_sweep entry:
//       re-polls up to 50 parcels (undelivered and not fetched for 4 h, then
//       new fulfilments with an AWB) and writes what Shiprocket answers
//   refetchAwb(awb)   the courier_refetch job a webhook queues: the store's
//       enabled, un-killed install, then Shiprocket's own answer for that AWB
//       is what gets written (never the webhook body)
//   courierEstimate(pin, { timeoutMs })   for lib/delivery/estimate-source.js:
//       null unless the founder chose Shiprocket's estimate and the plugin is
//       enabled and not killed; else { serviceable, minDays, maxDays } | null
import { db } from "../../../db.js";
import { decryptJson } from "../../../platform/crypto.js";
import { slog } from "../../../log.js";
import { notMigratedYet } from "../../../schema-shape.js";
import { isKilled } from "../../installs.js";
import { applyTracking, dueShipments, markFetched, orderIdForAwb, PLUGIN_ID, SWEEP_LIMIT } from "../../../couriers/tracking.js";
import { CourierLoginError, serviceability, trackAwb, JOB_TIMEOUT_MS, SHOPPER_TIMEOUT_MS } from "../../../couriers/shiprocket.js";

const parse = (s) => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};
const credsOf = (settings, secrets) => ({ email: settings?.api_email ?? "", api_password: secrets?.api_password ?? "" });

// the enabled, un-killed install with its settings and secrets, or null
async function activeInstall() {
  let row;
  try {
    row = await db.selectFrom("plugin_installs").selectAll().where("plugin_id", "=", PLUGIN_ID).where("status", "=", "enabled").executeTakeFirst();
  } catch (e) {
    if (notMigratedYet(e, { table: "plugin_installs" })) return null;
    throw e;
  }
  if (!row || (await isKilled(PLUGIN_ID))) return null;
  const settings = parse(row.settings);
  delete settings.__secret_keys;
  return { row, settings, secrets: async () => (row.secrets_enc ? decryptJson(row.secrets_enc) : {}) };
}

async function pollOne({ awb, orderId }, creds, now) {
  const parsed = await trackAwb(awb, { creds, timeoutMs: JOB_TIMEOUT_MS });
  if (!parsed) {
    // Shiprocket doesn't know it (yet): mark it fetched, or hold a hidden
    // placeholder row, so the next run moves on to other parcels
    await markFetched(awb, { orderId, now });
    return false;
  }
  await applyTracking(awb, parsed, { orderId, now });
  return true;
}

export async function shiprocketSweep({ install, now, secrets, log = () => {} }) {
  const at = typeof now === "number" ? now : Date.now();
  const creds = credsOf(install?.settings, await secrets());
  if (!creds.email || !creds.api_password) return { polled: 0 };
  const due = await dueShipments({ now: at, limit: SWEEP_LIMIT });
  let polled = 0;
  for (const s of due) {
    try {
      if (await pollOne(s, creds, at)) polled++;
    } catch (e) {
      // a refused login refuses every parcel: stop this run (the next window tries again)
      if (e instanceof CourierLoginError) {
        log("login_failed", { due: due.length, polled });
        return { polled, stopped: "login" };
      }
      throw e;
    }
  }
  log("polled", { due: due.length, polled });
  return { polled };
}

export async function refetchAwb(awb, { now = Date.now() } = {}) {
  const inst = await activeInstall();
  if (!inst) return { skipped: "inactive" };
  const orderId = await orderIdForAwb(awb);
  if (!orderId) {
    slog("courier_unknown_awb", {});
    return { skipped: "unknown" };
  }
  const ok = await pollOne({ awb, orderId }, credsOf(inst.settings, await inst.secrets()), now);
  return { written: ok };
}

export async function courierEstimate(pin, { timeoutMs = SHOPPER_TIMEOUT_MS } = {}) {
  const inst = await activeInstall();
  if (!inst || inst.settings.estimate_source !== "shiprocket") return null;
  const a = await serviceability(pin, {}, { settings: inst.settings, creds: credsOf(inst.settings, await inst.secrets()), timeoutMs });
  return a ? { serviceable: a.serviceable, minDays: a.minDays, maxDays: a.maxDays } : null;
}
