// Runs a console page (app/(console)/admin/(authed)/**/page.js) or a storefront
// page (app/(storefront)/**/page.js) under plain Node and records the props it
// hands its components (Phase 0 line 2's prop sweep; line 3's shopper sweep).
// A helper, not a suite: nothing runs on import. Import route-harness.js first
// (its hooks resolve "@/" inside lib/).
//
//   makePageHarness({ tenant, stubs })  tenant: async () => the store the page runs in;
//     stubs (optional): { "<import id>": module } given to the page in place of that import
//     -> { load(rel), run(rel, { cookies, params, searchParams }) }
//   run() -> { redirect, notFound, error, unresolved, props: [{ component, props }], text }
//     unresolved: every import the page asked for that the harness could not
//     give it, even one the page caught (a sweep fails on any)
//
// The page is compiled with Next's own SWC (the pattern of test-design-doc.js).
// Every component import (components/**, lucide-react, next/link) becomes a stub
// that renders nothing; every lib/ import is the real module. next/headers
// answers from the cookies given to run(); next/navigation's redirect() and
// notFound() throw, as Next's do. tfetch runs the callback in the store, read
// fresh each time, as the console's tfetch does; a layout's CSS and next/font
// imports are empty stand-ins; lib/tenant-request resolves to the harness's
// store; the storefront's tfetch
// (lib/storefront-request) does the same with no maintenance curtain, and
// next/server's after() is dropped (nothing after the response runs in a
// sweep). Components the page defines
// itself are called, so the data they load is swept too.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import { FONT_MODULE_IDS, fontModule } from "./font-stub.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);

class Redirect extends Error {}
class NotFound extends Error {}

const STUB = Symbol("page-harness stub");
function stubComponent(name) {
  const C = () => null;
  C[STUB] = name;
  Object.defineProperty(C, "name", { value: name });
  return C;
}
// a module whose every export is a stub component named after it
function stubModule(id) {
  const cache = new Map();
  return new Proxy(
    {},
    {
      get(_, key) {
        if (key === "__esModule") return true;
        if (typeof key !== "string") return undefined;
        if (!cache.has(key)) cache.set(key, stubComponent(`${id}#${key}`));
        return cache.get(key);
      },
      has: () => true,
    },
  );
}

const isComponentImport = (id) =>
  id === "next/link" || id === "next/image" || id === "lucide-react" || id.startsWith("@/components/") || /(^|\/)components\//.test(id);

export async function makePageHarness({ tenant, stubs = {} }) {
  const swc = require("next/dist/build/swc/index.js");
  await swc.loadBindings();
  const React = require("react");
  const { withTenant } = await import("../../lib/tenant-context.js");

  let request = null; // { cookies: { name: value } }
  const headersStub = {
    cookies: async () => {
      const jar = request?.cookies ?? {};
      return { get: (n) => (Object.hasOwn(jar, n) ? { name: n, value: jar[n] } : undefined), has: (n) => Object.hasOwn(jar, n), getAll: () => Object.entries(jar).map(([name, value]) => ({ name, value })) };
    },
    headers: async () => ({ get: () => null }),
  };
  const navigationStub = {
    redirect: (to) => {
      throw Object.assign(new Redirect(`redirect ${to}`), { to });
    },
    permanentRedirect: (to) => {
      throw Object.assign(new Redirect(`redirect ${to}`), { to });
    },
    notFound: () => {
      throw new NotFound("notFound");
    },
  };
  const consoleRequestStub = { tfetch: async (fn) => withTenant(await tenant(), fn) };
  // the storefront layout's own resolution: the harness's store, resolved
  const tenantRequestStub = {
    tfetch: async (fn) => withTenant(await tenant(), fn),
    requestResolution: async () => ({ outcome: "resolved", tenant: await tenant(), name: null }),
    requestTenant: async () => tenant(),
  };
  const storefrontRequestStub = { tfetch: async (fn) => withTenant(await tenant(), fn), storeCurtain: async () => null };
  // after() dropped; the rest read on use (a require at setup can cycle with
  // route-harness's own next/server stub)
  const nextServerStub = new Proxy({}, { get: (_, k) => (k === "after" ? () => {} : k === "__esModule" ? false : require("next/server")[k]) });

  const loaded = new Map();
  const unresolved = [];
  async function load(rel) {
    const file = join(ROOT, rel);
    if (loaded.has(file)) return loaded.get(file);
    const code = (
      await swc.transform(await readFile(file, "utf8"), {
        filename: file,
        jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
        module: { type: "commonjs" },
      })
    ).code;
    const deps = new Map();
    // require("x"), require(`x`), and SWC's dynamic import:
    // Promise.resolve(`@/lib/x`).then((p) => require(p))
    const ids = [
      ...[...code.matchAll(/require\((["'`])([^"'`$]+)\1\)/g)].map((m) => m[2]),
      ...[...code.matchAll(/Promise\.resolve\((["'`])([^"'`$]+)\1\)\.then\(/g)].map((m) => m[2]),
    ];
    for (const id of ids) {
      if (deps.has(id)) continue;
      if (Object.hasOwn(stubs, id)) deps.set(id, stubs[id]);
      else if (id === "react" || id === "react/jsx-runtime") deps.set(id, require(id));
      else if (id === "next/headers") deps.set(id, headersStub);
      else if (id === "next/navigation") deps.set(id, navigationStub);
      else if (id === "@/lib/console-request") deps.set(id, consoleRequestStub);
      else if (id === "@/lib/storefront-request") deps.set(id, storefrontRequestStub);
      else if (id === "@/lib/tenant-request") deps.set(id, tenantRequestStub);
      else if (id === "next/server") deps.set(id, nextServerStub);
      else if (/\.css$/.test(id)) deps.set(id, {}); // a layout's stylesheet
      else if (FONT_MODULE_IDS.includes(id)) deps.set(id, fontModule); // next/font and app/fonts/fonts.js
      else if (isComponentImport(id)) deps.set(id, stubModule(id));
      else if (id.startsWith("@/") || id.startsWith(".")) {
        const base = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolvePath(dirname(file), id);
        const target = /\.\w+$/.test(base) && existsSync(base) ? base : `${base}.js`;
        deps.set(id, await import(pathToFileURL(target).href));
      } else deps.set(id, require(id));
    }
    const mod = { exports: {} };
    const req = (id) => {
      if (deps.has(id)) return deps.get(id);
      const msg = `page-harness: unresolved import "${id}" in ${relative(ROOT, file)}`;
      unresolved.push(msg);
      throw new Error(msg);
    };
    new Function("require", "module", "exports", code)(req, mod, mod.exports);
    loaded.set(file, mod.exports);
    return mod.exports;
  }

  // Every element's props, depth first; the page's own components are called.
  async function collect(node, out, depth = 0) {
    if (depth > 60 || node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) await collect(n, out, depth + 1);
      return;
    }
    if (typeof node.then === "function") return collect(await node, out, depth + 1);
    if (!React.isValidElement(node)) return;
    const { type, props } = node;
    const component = typeof type === "string" ? type : type?.[STUB] ?? type?.name ?? String(type?.$$typeof?.description ?? "element");
    out.push({ component, props });
    for (const v of Object.values(props ?? {})) await collect(v, out, depth + 1);
    if (typeof type === "function" && !type[STUB]) await collect(await type(props), out, depth + 1);
  }

  // Plain text of every prop value (functions and symbols dropped)
  function textOf(value, seen = new Set()) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    if (typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    if (value instanceof Date) return value.toISOString();
    if (React.isValidElement(value)) return textOf(value.props, seen);
    const parts = [];
    const entries = value instanceof Map ? [...value.entries()].flat() : value instanceof Set ? [...value] : Array.isArray(value) ? value : Object.entries(value).flat();
    for (const v of entries) parts.push(textOf(v, seen));
    return parts.join(" ");
  }

  async function run(rel, { cookies = {}, params = {}, searchParams = {} } = {}) {
    const out = { redirect: null, notFound: false, error: null, unresolved: [], props: [], text: "" };
    const mark = unresolved.length;
    request = { cookies };
    try {
      const mod = await load(rel);
      const el = await mod.default({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) });
      await collect(el, out.props);
    } catch (e) {
      if (e instanceof Redirect) out.redirect = e.to;
      else if (e instanceof NotFound) out.notFound = true;
      else out.error = e;
    } finally {
      request = null;
    }
    out.unresolved = unresolved.slice(mark);
    out.text = out.props.map((p) => `${p.component} ${textOf(p.props)}`).join("\n");
    return out;
  }

  return { load, run };
}
