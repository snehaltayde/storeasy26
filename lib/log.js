// Structured logging (Session 17): one JSON line per operational event, so
// Vercel's log search can trace a flow — every money-path line carries
// order_id, making `BL-XXXXXXXX` a grep-able end-to-end trace key.
// (DB-side, order_events + events tables give the durable timeline —
// scripts/trace-order.js merges both views.)
export function slog(evt, fields = {}) {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), evt, ...fields }));
  } catch {
    console.log(JSON.stringify({ ts: new Date().toISOString(), evt }));
  }
}
