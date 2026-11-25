// Phase 4 line 4: the only gate for /api/apps/v1/* (requireAppToken) and the
// wrapper every v1 route uses (appApiRoute). SERVER-ONLY, Node runtime.
//
// - The token comes from `Authorization: Bearer` only. Cookies are never read
//   here, and requireAdmin never reads a Bearer header.
// - v1 is GET only and sends no CORS headers (server to server).
// - Effective scopes are the token's ∩ the app's current approval (tokens.js).
// - Every attributable call (allowed, scope-denied, rate-limited, or a revoked,
//   expired or switched-off token whose secret matched) writes an audit row
//   with audit({ strict: true }) BEFORE anything is answered; when that row
//   can't be written the answer is 503 with no data.
// - An unknown or malformed token can't be attributed: it is slog'd and
//   rate-limited by IP.
import { NextResponse } from "next/server";
import { tenantHandler } from "../tenant-request.js";
import { currentTenant } from "../tenant-context.js";
import { rateLimitAsync } from "../rate-limit.js";
import { audit } from "../platform/audit.js";
import { APP_PERMISSIONS } from "../platform/authz.js";
import { slog } from "../log.js";
import { API_CALL_ACTION, touchToken, verifyToken } from "./tokens.js";

export const TOKEN_RATE_LIMIT = 120; // per minute per token (per server instance without Upstash)
export const APP_RATE_LIMIT = 120; // per minute per app across its tokens (same caveat)
export const UNKNOWN_RATE_LIMIT = 30; // per minute per IP for tokens that don't resolve

export const INVALID_TOKEN = "This token isn't valid for this store.";
export const AUDIT_UNAVAILABLE = "Storeasy can't record this call right now, so nothing was returned. Try again in a minute.";
export const forbiddenWords = (scope) => `This app wasn't given permission to ${String(APP_PERMISSIONS[scope] ?? scope).replace(/^./, (c) => c.toLowerCase())}.`;

const NO_STORE = { "cache-control": "no-store" };
const json = (body, status, headers = {}) => NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });

function pathOf(request) {
  try {
    return request.nextUrl?.pathname ?? new URL(request.url).pathname;
  } catch {
    return "/api/apps/v1";
  }
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

// One audit row per attributable call, strict: a throw here means no answer.
async function record(gate, request, status) {
  await audit({
    actor: { kind: "app", id: gate.token.installId },
    action: API_CALL_ACTION,
    resource: `${String(request.method || "GET").toUpperCase()} ${pathOf(request)}`,
    // never a key named like a secret: redactDiff would blank it
    diff: { via: gate.token.id, scope: gate.action ?? null, status },
    strict: true,
  });
}

// Answer an attributable call: audit first, then the body; 503 and no data
// when the row can't be written.
async function answer(gate, request, status, body, headers = {}) {
  try {
    await record(gate, request, status);
  } catch {
    slog("app_token_audit_failed", { tok: gate.token.id, status });
    return json({ error: AUDIT_UNAVAILABLE, code: "AUDIT_UNAVAILABLE" }, 503);
  }
  return json(body, status, headers);
}

async function refuseUnattributed(request, reason) {
  slog("app_token_refused", { reason, path: pathOf(request) });
  const limited = await rateLimitAsync(request, { name: "apps-api-unknown", limit: UNKNOWN_RATE_LIMIT });
  if (limited) return { ok: false, response: json({ error: "Too many requests. Wait a minute and try again.", code: "RATE_LIMITED" }, 429, { "Retry-After": limited.headers.get("Retry-After") || "60" }) };
  return { ok: false, response: json({ error: INVALID_TOKEN, code: "INVALID_TOKEN" }, 401) };
}

// requireAppToken(request, action) → { ok: true, app, answer(status, body) }
//                                  | { ok: false, response }
// action: an APP_PERMISSIONS key, or null for a call that needs no scope (me).
export async function requireAppToken(request, action) {
  const raw = bearer(request);
  if (!raw) return refuseUnattributed(request, "missing");
  const v = await verifyToken(raw);
  if (!v.token) return refuseUnattributed(request, v.reason);
  const gate = { token: v.token, action };
  // the token's own budget comes first, so a revoked, expired or switched-off
  // token can't write audit rows faster than a live one; one budget per token
  // whatever address calls (scope "tenant")
  // and one budget per app across all its tokens (P4-E), so minting more
  // tokens buys no more calls; both are per store, never per address
  const limited =
    (await rateLimitAsync(request, { name: `apps-api-${v.token.id}`, limit: TOKEN_RATE_LIMIT, scope: "tenant" })) ||
    (await rateLimitAsync(request, { name: `apps-api-app-${v.token.installId}`, limit: APP_RATE_LIMIT, scope: "tenant" }));
  if (limited) {
    const retry = limited.headers.get("Retry-After") || "60";
    return { ok: false, response: await answer(gate, request, 429, { error: "Too many requests. Wait a minute and try again.", code: "RATE_LIMITED" }, { "Retry-After": retry }) };
  }
  if (!v.ok) {
    slog("app_token_refused", { reason: v.reason, tok: v.token.id });
    return { ok: false, response: await answer(gate, request, 401, { error: INVALID_TOKEN, code: "INVALID_TOKEN" }) };
  }
  if (action && !v.scopes.includes(action)) {
    return { ok: false, response: await answer(gate, request, 403, { error: forbiddenWords(action), code: "FORBIDDEN" }) };
  }
  await touchToken(v.token);
  const app = { id: String(v.install.id), name: String(v.install.name || "Custom app"), scopes: v.scopes, tokenId: v.token.id, store: currentTenant()?.domains?.[0] ?? request.headers.get("host") ?? null };
  return { ok: true, app, answer: (status, body, headers) => answer(gate, request, status, body, headers) };
}

// A v1 read: GET only, through tenantHandler (a suspended or unknown store
// answers as every other tenant route does), the gate, then read(request,
// { params, app }) → { status?, body }. A read that throws is a plain 500,
// still audited.
export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function appApiRoute(action, read) {
  return tenantHandler(async (request, ctx) => {
    const gate = await requireAppToken(request, action);
    if (!gate.ok) return gate.response;
    let status = 200;
    let body;
    try {
      body = await read(request, { params: (await ctx?.params) ?? {}, app: gate.app });
      if (body == null) {
        status = 404;
        body = { error: "We couldn't find that.", code: "NOT_FOUND" };
      }
    } catch (e) {
      if (e instanceof ApiError) {
        status = e.status;
        body = { error: e.message, code: e.code };
      } else {
        slog("apps_api_failed", { path: pathOf(request), error: String(e?.name || "Error") });
        status = 500;
        body = { error: "Something went wrong reading this. Try again.", code: "FAILED" };
      }
    }
    return gate.answer(status, body);
  });
}
