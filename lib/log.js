// Structured logging (Session 17): one JSON line per operational event, so
// Vercel's log search can trace a flow — every money-path line carries
// order_id, making `BL-XXXXXXXX` a grep-able end-to-end trace key.
// Session 24: every line also carries the ACTIVE tenant id, so one shared
// log stream stays filterable per store ("_default" = env-fallback tenant).
// (DB-side, order_events + events tables give the durable timeline —
// scripts/trace-order.js merges both views.)
import { tenantId } from "./tenant-context.js";

export function slog(evt, fields = {}) {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), evt, tenant: tenantId(), ...fields }));
  } catch {
    console.log(JSON.stringify({ ts: new Date().toISOString(), evt }));
  }
}
