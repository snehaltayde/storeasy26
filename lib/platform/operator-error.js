// Operator route errors (Phase 3 audit P3-G, docs/cms-reviews/PHASE-3-AUDIT.md).
// A library's own refusal carries a 4xx status (lib/platform/refuse.js) and
// keeps its words; any other error (a driver's or an outside service's, which
// can name a store's database) becomes fixed words in the answer and goes to
// the log through scrubSecrets, with the store's address and token when the
// route knows them. Every catch under app/api/platform answers through
// operatorError (a static guard in test:platform-permissions).
import { NextResponse } from "next/server";
import { scrubSecrets } from "./turso-api.js";
import { slog } from "../log.js";

export { refuse } from "./refuse.js";

const isRefusal = (e) => Number.isInteger(e?.status) && e.status >= 400 && e.status < 500;

//   tenant  the store the route acted on: its address and token are scrubbed
//   words   the fixed words for any error that isn't a refusal
//   status  that answer's status
//   keep    true when the error's words are the route's own (e.g. billing's
//           PROVIDER_ERROR): they go back as they are, with `status`
//   fields  more JSON fields for either answer
export function operatorError(e, { tenant = null, words = "That didn't work just now. Try again.", status = 422, event = "operator_action_failed", headers, fields = {}, keep = false } = {}) {
  if (keep || isRefusal(e)) return NextResponse.json({ ...fields, error: String(e?.message ?? e).slice(0, 300) }, { status: keep ? status : e.status, headers });
  slog(event, { error: scrubSecrets(e?.message || e, [tenant?.dbUrl, tenant?.dbToken]).slice(0, 300) });
  return NextResponse.json({ ...fields, error: words }, { status, headers });
}
