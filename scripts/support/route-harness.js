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
    if (["react", "next/headers", "next/navigation"].includes(specifier) && context.parentURL?.endsWith("/lib/tenant-request.js")) {
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
