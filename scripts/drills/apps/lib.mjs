// drill:apps shared parts (Phase 4): the roles store's origin and members,
// signing in, console-error watching, and the stage list. Each stage file
// (stage-<name>.mjs) calls stage(name, fn) once; run.mjs imports them in order.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../design-harness.js";
import { settle } from "../p3/lib.mjs";

export const port = String(process.env.ROLES_PORT || "").trim();
export const ORIGIN = `http://roles.localhost:${port}`;
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));
export const member = (role) => seed().members.find((x) => x.role === role);

export const consoleErrors = [];
// a refused write is the answer some checks ask for: those 403s are expected
const EXPECTED = [/status of 403 \(Forbidden\)/, /eval\(\) is not supported/];
function watch(page, label) {
  page.on("console", (msg) => {
    if (msg.type() === "error" && !EXPECTED.some((re) => re.test(msg.text()))) consoleErrors.push(`${label}: ${msg.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${label}: ${String(e?.message || e).slice(0, 300)}`));
}

export async function signIn(drill, role) {
  const m = member(role);
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(30_000);
  const res = await ctx.request.post(`${ORIGIN}/api/admin/login`, { data: { email: m.email, password: m.password }, headers: { origin: ORIGIN }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as ${role} answered ${res.status()}`);
  const page = await ctx.newPage();
  watch(page, role);
  return page;
}

export async function open(page, path) {
  const r = await page.goto(ORIGIN + path, { waitUntil: "load" });
  await settle(page);
  return r?.status();
}

export const api = (page, path, init = null) =>
  page.evaluate(
    async ([p, i]) => {
      const r = await fetch(`/api/admin/${p}`, i ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(i) } : { cache: "no-store" });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    [path, init],
  );

// shared between stages: what an earlier stage made (install ids)
export const state = {};

export const STAGES = [];
export const stage = (name, fn) => STAGES.push({ name, fn });
