// Turso Platform API client (Phase 1 line 2, docs/plans/phase-1.md §1 items 3–5,
// 9, 10). Node-only. Used by provisioning for self-serve signup; never the
// `turso` CLI.
//
//   tursoApi(env) -> { createDatabase(name), getDatabase(name),
//                      mintToken(name, { expiration }), deleteDatabase(name),
//                      dbUrlFor(database) }
//   POST /v1/organizations/{org}/databases {name, group} -> {database:{DbId,Hostname,Name}}
//   GET  /v1/organizations/{org}/databases/{name}        -> {database:{…}}
//   POST /v1/organizations/{org}/databases/{name}/auth/tokens?expiration=&authorization=full-access -> {jwt}
//   DELETE /v1/organizations/{org}/databases/{name}
//
// Every failure is a TursoApiError with a kind:
//   retry           network errors, timeouts (15 s per call), 429 and 5xx
//                   (retryAfterMs from Retry-After, capped at 10 minutes)
//   needs_operator  400 (bad group or name), 401, 402, 403, any other 4xx
//   conflict        409;  not_found  404
// Turso documents 400/401/402/403/404/409 and no quota or rate-limit answer,
// so a 402, a 403 or a 400 mentioning a limit all need an operator.
//
// Address (item 9): TURSO_API_URL, default https://api.turso.tech. Production
// refuses any other value; elsewhere a non-default value must be loopback (the
// local fake). On a loopback API address the database address is the fake's
// test-only loopback `localUrl`, and a reply without one throws (never a
// libsql:// fallback); on the default address it is libsql://<Hostname>.
// Secrets (item 10): no message carries the API token, a Bearer value or a
// JWT-looking string; scrubSecrets() is also used for run and job errors.
export const DEFAULT_TURSO_API_URL = "https://api.turso.tech";
// A seam for the suites (a short timeout instead of 15 s); nothing else changes it.
export const tursoApiTiming = { timeoutMs: 15_000 };
export const RETRY_AFTER_CAP_MS = 10 * 60 * 1000;

export class TursoApiError extends Error {
  constructor(message, { kind, status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = "TursoApiError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export function isLoopbackUrl(value, { schemes = ["http:", "https:"] } = {}) {
  let u;
  try {
    u = new URL(String(value || ""));
  } catch {
    return false;
  }
  return schemes.includes(u.protocol) && LOOPBACK.has(u.hostname.toLowerCase()) && !u.username && !u.password;
}

const isProduction = (env) => env.NODE_ENV === "production" || Boolean(env.VERCEL);

export function tursoApiBase(env = process.env) {
  const raw = String(env.TURSO_API_URL || "").trim().replace(/\/+$/, "");
  if (!raw || raw === DEFAULT_TURSO_API_URL) return DEFAULT_TURSO_API_URL;
  if (isProduction(env)) throw new TursoApiError("TURSO_API_URL must be the default Turso address in production (or on Vercel); unset it.", { kind: "needs_operator" });
  if (!isLoopbackUrl(raw)) throw new TursoApiError("TURSO_API_URL may only point at a loopback address (the local fake) outside production; unset it to use Turso.", { kind: "needs_operator" });
  return raw;
}

export const tursoApiConfigured = (env = process.env) => Boolean(String(env.TURSO_API_TOKEN || "").trim() && String(env.TURSO_ORG || "").trim());

export function classifyStatus(status) {
  if (status === 409) return "conflict";
  if (status === 404) return "not_found";
  if (status === 429 || status >= 500) return "retry";
  return "needs_operator";
}

// Retry-After: seconds or an HTTP date -> ms (capped), or null.
export function retryAfterMs(header, now = Date.now()) {
  if (header == null || String(header).trim() === "") return null;
  const s = String(header).trim();
  let ms = null;
  if (/^\d+$/.test(s)) ms = Number(s) * 1000;
  else {
    const at = Date.parse(s);
    if (!Number.isNaN(at)) ms = Math.max(0, at - now);
  }
  return ms == null ? null : Math.min(ms, RETRY_AFTER_CAP_MS);
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g;
export function scrubSecrets(text, extra = []) {
  let s = String(text ?? "");
  // a file: url is also stripped as the bare path a driver error prints
  const values = extra.flatMap((v) => (typeof v === "string" && /^file:/i.test(v) ? [v, v.replace(/^file:(\/\/)?/i, "")] : [v]));
  for (const secret of values) if (secret && String(secret).length >= 6) s = s.split(String(secret)).join("[redacted]");
  return s
    .replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
    .replace(JWT_RE, "[redacted]")
    .replace(/(authToken|auth_token|token|jwt)=([^&\s"']+)/gi, "$1=[redacted]")
    // a database address (Phase 3 line 1): libsql://, file: and Turso https hosts
    .replace(/\blibsql:\/\/[^\s"',;)]+/gi, "[database address]")
    .replace(/\bfile:[^\s"',;)]+/gi, "[database address]")
    .replace(/\bhttps:\/\/[a-z0-9.-]+\.turso\.io[^\s"',;)]*/gi, "[database address]");
}

export function tursoApi(env = process.env) {
  const base = tursoApiBase(env);
  const org = String(env.TURSO_ORG || "").trim();
  const apiToken = String(env.TURSO_API_TOKEN || "").trim();
  const group = String(env.TURSO_GROUP || "").trim() || "default";
  const scrub = (s) => scrubSecrets(s, [apiToken]);

  async function call(what, method, path, body) {
    const url = `${base}/v1/organizations/${encodeURIComponent(org)}${path}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${apiToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(tursoApiTiming.timeoutMs),
      });
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      throw new TursoApiError(timedOut ? `Turso ${what} timed out after ${tursoApiTiming.timeoutMs} ms` : `Turso ${what} could not be reached (${scrub(e?.cause?.code || e?.message || e).slice(0, 120)})`, { kind: "retry" });
    }
    if (res.ok) return res.json().catch(() => ({}));
    const text = scrub(await res.text().catch(() => "")).slice(0, 200);
    let kind = classifyStatus(res.status);
    if (res.status === 400 && /limit|quota/i.test(text)) kind = "needs_operator";
    throw new TursoApiError(`Turso ${what} failed (${res.status})${text ? `: ${text}` : ""}`, { kind, status: res.status, retryAfterMs: kind === "retry" ? retryAfterMs(res.headers.get("retry-after")) : null });
  }

  const loopbackApi = base !== DEFAULT_TURSO_API_URL;
  return {
    async createDatabase(name) {
      return (await call("create", "POST", "/databases", { name, group })).database;
    },
    async getDatabase(name) {
      return (await call("retrieve", "GET", `/databases/${encodeURIComponent(name)}`)).database;
    },
    async mintToken(name, { expiration = "never" } = {}) {
      const r = await call("token", "POST", `/databases/${encodeURIComponent(name)}/auth/tokens?expiration=${encodeURIComponent(expiration)}&authorization=full-access`);
      if (!r?.jwt) throw new TursoApiError("Turso token answer had no token", { kind: "retry" });
      return r.jwt;
    },
    async deleteDatabase(name) {
      return call("delete", "DELETE", `/databases/${encodeURIComponent(name)}`);
    },
    dbUrlFor(database) {
      // a loopback API is the local fake: its database must be local too, never
      // a libsql:// address on the real service
      if (loopbackApi) {
        if (database?.localUrl && isLoopbackUrl(database.localUrl)) return database.localUrl;
        throw new TursoApiError("the local Turso stand-in answered without a loopback database address", { kind: "needs_operator" });
      }
      if (!database?.Hostname) throw new TursoApiError("Turso's database answer had no Hostname", { kind: "needs_operator" });
      return `libsql://${database.Hostname}`;
    },
  };
}
