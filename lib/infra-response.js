// DOC-04 for the rest of the console API. Most /api/admin routes end in a
// catch-all that answers ANY error with a 4xx (usually 422) and the raw
// message, so a database that didn't answer, went read-only or missed a
// migration reached the founder as if they had typed something wrong, often
// with SQLite's own words in it.
//
// infraResponse(e) answers those properly, through the same mapping the CMS
// uses (lib/cms/issues.js): 5xx with a code and a plain message, or 409 for a
// uniqueness race, and the raw text goes to the log. It returns null for
// anything that isn't infrastructure, so each route keeps its own 4xx
// handling for its own validation errors.
//   } catch (e) {
//     const infra = infraResponse(e, { route: "admin/offers" });
//     if (infra) return NextResponse.json(infra.body, { status: infra.status });
//     …the route's existing answer…
import { infraKind, isValidationError, INFRA_CODES, infraMessage } from "./cms/issues.js";
import { slog } from "./log.js";

export function infraResponse(e, { route = "unknown", doing = "save" } = {}) {
  if (!e || isValidationError(e)) return null;
  const kind = infraKind(e);
  if (!kind) return null;
  const { status, code } = INFRA_CODES[kind];
  slog("api_infra_failure", { route, status, code, error: String(e?.message || e).slice(0, 300) });
  return { status, body: { error: infraMessage(kind, doing), code, retryable: kind !== "schema" } };
}
