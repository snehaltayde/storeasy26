// A per-request stand-in for React's cache(), for unit tests (P2-VGATE).
//
// Outside a React Server Components render, react's own cache() memoizes
// nothing, so a unit test that calls the storefront getters cannot see what a
// real request costs. Importing this file installs a module hook
// (node:module registerHooks) that hands every `import … from "react"` in the
// app's own code (lib/, app/, components/, scripts/) a copy of react whose
// cache() memoizes per simulated request. Only ES module imports are swapped;
// a CommonJS require("react") gets the real react:
//
//   import { runRequest, watchStatements } from "./support/request-cache.js";
//   await runRequest(async () => { … getters share one memo here … });
//
// Rules, matching React's cache() inside a render:
//   · inside runRequest(fn), a cached function called again with the same
//     arguments (primitives by value, objects by identity) returns the first
//     call's result, a rejected promise included;
//   · each runRequest call starts with an empty memo;
//   · outside runRequest, nothing is memoized (each call runs).
//
// Import this file BEFORE any app module that imports react. Code inside
// node_modules keeps the real react. Later phase-2 items reuse this file as it
// is; it is shared test support, so change it only with every user in view.
import { registerHooks, createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, sep } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NODE_MODULES = join(ROOT, "node_modules") + sep;
const KEY = Symbol.for("storeasy.test.requestCache");
const LEAF = Symbol("value");

const state = (globalThis[KEY] ??= { als: new AsyncLocalStorage(), installed: false });

// React's cache() semantics, scoped to the current runRequest store.
export function cache(fn) {
  return function cached(...args) {
    const store = state.als.getStore();
    if (!store) return fn.apply(this, args);
    let node = store.get(fn);
    if (!node) store.set(fn, (node = new Map()));
    for (const a of args) {
      let next = node.get(a);
      if (!next) node.set(a, (next = new Map()));
      node = next;
    }
    if (node.has(LEAF)) {
      const hit = node.get(LEAF);
      if (hit.threw) throw hit.error;
      return hit.value;
    }
    try {
      const value = fn.apply(this, args);
      node.set(LEAF, { value });
      return value;
    } catch (error) {
      node.set(LEAF, { threw: true, error });
      throw error;
    }
  };
}

// Run fn as one simulated request: every cache()d function shares one memo
// for the duration of fn (and anything it awaits), and no longer.
export function runRequest(fn) {
  return state.als.run(new Map(), fn);
}

export const inRequest = () => state.als.getStore() !== undefined;

// Count the SQL statements a libSQL client runs while fn runs. `client` is
// the client to watch, e.g. currentDatabase().libsql inside withTenant(). The
// returned `statements` holds each statement's SQL text in the order sent (a
// batch adds one entry per statement). One watcher per client at a time.
export async function watchStatements(client, fn) {
  const statements = [];
  const execute = client.execute;
  const batch = client.batch;
  const sqlOf = (s) => (typeof s === "string" ? s : String(s?.sql ?? ""));
  if (execute?.__watched) throw new Error("watchStatements: this client is already being watched");
  const counted = (...args) => {
    statements.push(sqlOf(args[0]));
    return execute(...args);
  };
  counted.__watched = true;
  client.execute = counted;
  if (typeof batch === "function") {
    client.batch = (stmts, ...rest) => {
      for (const s of stmts || []) statements.push(sqlOf(s));
      return batch(stmts, ...rest);
    };
  }
  try {
    const result = await fn();
    return { result, statements };
  } finally {
    delete client.execute;
    delete client.batch;
  }
}

// ---- the module hook ------------------------------------------------------------

function install() {
  if (state.installed) return;
  state.installed = true;
  // The real react, required from inside node_modules so the hook below
  // passes it through untouched.
  const realRequire = createRequire(join(NODE_MODULES, "react", "package.json"));
  const names = Object.keys(realRequire("react")).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== "default" && k !== "cache");
  const reactJson = JSON.stringify(join(NODE_MODULES, "react", "package.json"));
  const source = `
import { createRequire } from "node:module";
import { cache } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};
const React = createRequire(${reactJson})("react");
const patched = { ...React, cache };
export default patched;
export { cache };
export const { ${names.join(", ")} } = patched;
`;
  const url = "data:text/javascript," + encodeURIComponent(source);
  registerHooks({
    resolve(spec, ctx, next) {
      if (spec !== "react") return next(spec, ctx);
      // require("react") keeps the real one (CommonJS cannot load the data:
      // module). App code imports react as an ES module.
      if (ctx.conditions?.includes("require")) return next(spec, ctx);
      const parent = ctx.parentURL || "";
      if (!parent.startsWith("file:")) return next(spec, ctx);
      const file = fileURLToPath(parent);
      if (!file.startsWith(ROOT + sep) || file.startsWith(NODE_MODULES)) return next(spec, ctx);
      return { url, format: "module", shortCircuit: true };
    },
  });
}

install();
