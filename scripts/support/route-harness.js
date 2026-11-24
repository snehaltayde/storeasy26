// Loads real app/api route modules under plain Node so a test can POST to them:
// resolves the "@/" alias and extensionless Next imports, and swaps next/server's
// after() for a queue the test drains (after() needs a live Next request).
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const stub = new URL("./next-server-stub.js", import.meta.url).href;
const requestStub = new URL("./next-request-stub.js", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server" && context.parentURL !== stub) return { url: stub, shortCircuit: true };
    if (
      ["react", "next/headers", "next/navigation"].includes(specifier) &&
      ["/lib/tenant-request.js", "/lib/content/resolve.js", "/lib/storefront-request.js"].some((f) => context.parentURL?.endsWith(f))
    ) {
      return { url: requestStub, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const base = join(root, specifier.slice(2));
      return { url: pathToFileURL(existsSync(`${base}.js`) ? `${base}.js` : base).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// after() keeps the caller's async context (the active tenant), as Next's does.
const queue = (globalThis.__afterQueue ||= []);
globalThis.__afterSchedule = (fn) => queue.push(AsyncLocalStorage.snapshot().bind(null, fn));

export async function drainAfter() {
  while (queue.length) await queue.shift()();
}

// --- Per-role calls (Phase 0 line 1, scripts/test-permissions.js) -------------
// Nothing below runs on import. A suite blanks the outside services, blocks the
// network, then builds a role store and calls real routes as each caller.
// after() work queued by a call is never drained here (it may reach Shopify).

// Every env var through which a route could reach a paid or outside service.
export const OUTSIDE_SERVICE_ENV = Object.freeze([
  "SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_TOKEN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_STOREFRONT_TOKEN", "SHOPIFY_STOREFRONT_PRIVATE_TOKEN",
  "NEXT_PUBLIC_RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",
  "PLATFORM_RAZORPAY_KEY_ID", "PLATFORM_RAZORPAY_KEY_SECRET", "PLATFORM_RAZORPAY_WEBHOOK_SECRET",
  "RESEND_API_KEY", "TYPESENSE_HOST", "TYPESENSE_ADMIN_API_KEY",
  "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT", "R2_PUBLIC_URL",
  "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "ANTHROPIC_API_KEY", "ALERT_WEBHOOK_URL",
  "META_CAPI_TOKEN", "TURSO_API_TOKEN", "TURSO_DB_URL", "TURSO_DB_AUTH_TOKEN",
  "ADMIN_PASSWORD", "PLATFORM_ADMIN_PASSWORD",
]);

// Blank them (and turn rate limits off), then check each one really is blank.
export function blankOutsideServices() {
  for (const k of OUTSIDE_SERVICE_ENV) process.env[k] = "";
  process.env.RATE_LIMIT_DISABLED = "1";
  const set = OUTSIDE_SERVICE_ENV.filter((k) => process.env[k]);
  if (set.length) throw new Error(`route-harness: still set: ${set.join(", ")}`);
}

// Any fetch() from here on throws and is recorded, so a suite can assert none ran.
export function blockNetwork() {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url?.url ?? url).slice(0, 120));
    throw new Error("route-harness: network blocked in this suite");
  };
  return calls;
}

// Every import of lib/admin-auth.js (routes and lib/admin/* handlers alike)
// gets scripts/support/admin-auth-spy.js instead, so call() can report which
// action each requireAdmin call asked for. Call before any route is imported.
const spy = new URL("./admin-auth-spy.js", import.meta.url).href;
let spying = false;
export function spyOnRequireAdmin() {
  if (spying) return;
  spying = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const r = nextResolve(specifier, context);
      return r.url.endsWith("/lib/admin-auth.js") && context.parentURL !== spy ? { ...r, url: spy } : r;
    },
  });
}

const CALLER_ROLES = ["owner", "admin", "staff", "support"];
export const CALLERS = Object.freeze([...CALLER_ROLES, "signed-out", "owner-b", "operator-support"]);

// Store A (owner, admin, staff and support members, a legacy admin_password
// secret, an operator support grant) and store B (its own owner), both in
// documents mode on file: databases under one file: control plane.
//   -> { a, b, users, cookies, ids, call(caller, path, method, opts), session(userKey), cleanup() }
// a / b: optional { config, secrets, products } for that store's makeTenant
// (line 2's canaries); a's secrets are merged over the legacy admin_password.
// opts: { body, form, params, query, origin, cookies, host }; query is a
// search string ("product=x") added to the URL. origin null sends none;
// the default is the store's own origin on non-GET calls. Body strings "$owner",
// "$admin", … are swapped for that user's id.
export async function makeRoleStore({ name = "perm", a: aOpts = {}, b: bOpts = {} } = {}) {
  const F = await import("./tenant-fixture.js");
  const platform = await F.makePlatform({ name });
  const a = await F.makeTenant({ ...aOpts, name: `${name}-a`, mode: "documents", secrets: { admin_password: `${name}-a-legacy-pass`, ...aOpts.secrets } });
  const b = await F.makeTenant({ ...bOpts, name: `${name}-b`, mode: "documents" });
  for (const t of [a, b]) F.assertLocalDbUrl(t.tenant.dbUrl);
  const I = await import("../../lib/platform/identity.js");
  const S = await import("../../lib/platform/sessions.js");
  const { createSupportGrant } = await import("../../lib/platform/support.js");

  const users = {};
  for (const role of CALLER_ROLES) {
    users[role] = await I.createUser({ email: `${role}@${a.id}.test`, password: `${role}-pass-${name}` });
    await I.addMembership(users[role].id, a.id, role);
  }
  users["owner-b"] = await I.createUser({ email: `owner@${b.id}.test`, password: `owner-b-pass-${name}` });
  await I.addMembership(users["owner-b"].id, b.id, "owner");
  users.operator = await I.createOperator({ email: `operator@${name}.test`, password: `operator-pass-${name}` });
  await createSupportGrant({ tenantId: a.id, reason: "permission suite support grant", hours: 1, operator: users.operator.id });

  const session = async (userKey, kind = "merchant") => (await S.createSession({ userId: users[userKey].id, kind, ttlMs: 10 * 60_000 })).token;
  const cookies = { "signed-out": {}, "operator-support": { _platform: await session("operator", "operator") } };
  for (const role of [...CALLER_ROLES, "owner-b"]) cookies[role] = { _admin: await session(role) };
  const ids = Object.fromEntries(Object.entries(users).map(([k, u]) => [`$${k}`, u.id]));
  const swap = (v) => JSON.parse(JSON.stringify(v), (_, x) => (typeof x === "string" && Object.hasOwn(ids, x) ? ids[x] : x));

  const { NextRequest } = await import("./next-server-stub.js");
  async function call(caller, path, method, { body, form, params, query, origin, cookies: jar, host = a.tenant.domains[0] } = {}) {
    const file = ["route.js", "route.ts", "route.mjs"].map((f) => join(root, "app/api/admin", path, f)).find((f) => existsSync(f));
    if (!file) throw new Error(`route-harness: no route file for ${path}`);
    const route = await import(pathToFileURL(file).href);
    const handler = route[method];
    if (typeof handler !== "function") throw new Error(`route-harness: ${path} has no ${method}`);
    const concrete = path.replace(/\[(\w+)\]/g, (_, k) => encodeURIComponent(params?.[k] ?? k));
    const headers = { host };
    const o = origin === undefined ? (method === "GET" ? null : `http://${host}`) : origin;
    if (o) headers.origin = o;
    const jarFor = jar ?? cookies[caller] ?? {};
    if (Object.keys(jarFor).length) headers.cookie = Object.entries(jarFor).map(([k, v]) => `${k}=${v}`).join("; ");
    let reqBody;
    if (form) {
      reqBody = new FormData();
      for (const [k, v] of Object.entries(form)) reqBody.append(k, v);
    } else if (body !== undefined && method !== "GET") {
      headers["content-type"] = "application/json";
      reqBody = JSON.stringify(swap(body)); // a null body is sent as JSON null
    }
    const request = new NextRequest(`http://${host}/api/admin/${concrete}${query ? `?${query}` : ""}`, { method, headers, body: reqBody });
    const asked = (globalThis.__requireAdminSink = []);
    let res;
    try {
      res = await handler(request, { params: Promise.resolve(params ?? {}) });
    } finally {
      globalThis.__requireAdminSink = undefined;
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // a redirect or an empty body
    }
    // asked: the actions requireAdmin was called with (only under spyOnRequireAdmin)
    // text: the raw response body (line 2 searches it for canaries)
    return { status: res.status, body: json, text, headers: res.headers, setCookie: res.headers.getSetCookie(), asked: [...asked] };
  }

  return {
    platform,
    a,
    b,
    users,
    cookies,
    ids,
    call,
    session,
    cleanup: async () => {
      for (const t of [a, b]) await t.cleanup();
      await platform.cleanup();
      await F.removeFixtureFiles(name);
    },
  };
}
