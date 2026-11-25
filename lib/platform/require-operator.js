// Phase 3 line 0: the one gate every operator API route calls (the operator
// counterpart of requireAdmin). Edge-safe: web crypto and the control-plane
// client only, through lib/platform/admin-auth.js.
//
//   const auth = await requireOperator(request, { write: true });
//   if (auth instanceof Response) return auth;
//   await audit({ actor: auth.operator, ... });
//
// -> { operator: { id, kind: "operator" | "bootstrap", name, email } }, or a
// response: 403 for a cross-origin write (checked before auth), 401 for no
// session, a revoked, expired or non-operator session, a merchant token, or
// the bootstrap token once an operator user exists (platformOperator's rules).
// A mutating method always counts as a write, whatever the caller passes.
import { NextResponse } from "next/server";
import { platformOperator, PLATFORM_COOKIE } from "./admin-auth.js";
import { sameOrigin } from "../origin-check.js";
import { platformDb } from "./control.js";

const json = (body, status) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const BOOTSTRAP_NAME = "Bootstrap operator";

// The signed-in operator for a _platform cookie value, with a name and email
// to show and to audit, or null. Pages (the operator shell) use this too.
export async function operatorFromCookie(cookieValue) {
  const op = await platformOperator(cookieValue);
  if (!op) return null;
  if (op.id === "bootstrap") return { id: "bootstrap", kind: "bootstrap", name: BOOTSTRAP_NAME, email: null };
  let row = null;
  try {
    row = (await platformDb().execute({ sql: "SELECT name, email FROM users WHERE id = ?", args: [op.id] })).rows[0] || null;
  } catch {
    // the session check already passed; a name lookup failure only loses the label
  }
  const email = row?.email ? String(row.email) : null;
  return { id: String(op.id), kind: "operator", name: row?.name ? String(row.name) : email || "Operator", email };
}

const mutating = (request) => !["GET", "HEAD"].includes(String(request.method || "GET").toUpperCase());

export async function requireOperator(request, { write = false } = {}) {
  if ((write || mutating(request)) && !sameOrigin(request)) return json({ error: "Cross-origin request rejected" }, 403);
  const operator = await operatorFromCookie(request.cookies.get(PLATFORM_COOKIE)?.value);
  if (!operator) return json({ error: "Unauthorized" }, 401);
  return { operator };
}
