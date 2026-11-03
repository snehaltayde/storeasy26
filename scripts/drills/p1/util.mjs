// Shared helpers for the P1-DRILLS journeys (desktop Chrome on the design harness).
import { settle } from "../../drill.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Text of the main page (not iframes).
export const text = (page) => page.evaluate(() => document.body?.innerText || "");

// Wait for some text to show on the page; true/false, never throws.
export async function seen(page, needle, timeout = 20_000) {
  return page
    .getByText(needle, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
}

// Requests whose path starts with `prefix`, as they happen.
export function watch(page, prefix) {
  const seenReqs = [];
  page.on("request", (r) => {
    try {
      const u = new URL(r.url());
      if (u.pathname.startsWith(prefix)) seenReqs.push({ at: Date.now(), method: r.method(), path: u.pathname + u.search });
    } catch {}
  });
  page.on("response", (r) => {
    try {
      const u = new URL(r.url());
      if (u.pathname.startsWith(prefix)) {
        const hit = [...seenReqs].reverse().find((x) => x.path === u.pathname + u.search && x.status === undefined);
        if (hit) hit.status = r.status();
      }
    } catch {}
  });
  return seenReqs;
}

// Console errors and page errors on a page.
export function errorsOn(page) {
  const out = { console: [], page: [] };
  page.on("console", (m) => m.type() === "error" && out.console.push(m.text().slice(0, 300)));
  page.on("pageerror", (e) => out.page.push(String(e?.message || e).slice(0, 300)));
  return out;
}

// Operator console sign-in, then a support grant for the design store, so the
// operator's _platform cookie opens /admin as the read-only support role.
export async function supportContext(drill, { width = 1440 } = {}) {
  const ctx = await drill.context({ width });
  const op = await drill.signInOperator(ctx);
  const grant = await op.evaluate(async () => {
    const r = await fetch("/api/platform/support", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "grant", tenant: "design", reason: "P1 drill support check", hours: 1 }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  });
  return { ctx, page: op, grant };
}

export async function revokeGrant(page, id) {
  return page.evaluate(async (gid) => {
    const r = await fetch("/api/platform/support", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "revoke", id: gid }) });
    return r.status;
  }, id);
}

// The colour family of the nearest banner around some text: danger/warning/info/success.
export async function bannerTone(page, needle) {
  return page.evaluate((n) => {
    const el = [...document.querySelectorAll("p,div,span")].find((e) => e.children.length === 0 && e.textContent.includes(n));
    let b = el;
    while (b && !/(danger|warning|success|info)-bg/.test(b.className || "")) b = b.parentElement;
    if (!b) return null;
    const m = /(danger|warning|success|info)-bg/.exec(b.className);
    return { tone: m[1], color: getComputedStyle(b).backgroundColor, border: getComputedStyle(b).borderColor };
  }, needle);
}

export async function scrollWidth(page) {
  return page.evaluate(() => ({ vw: window.innerWidth, sw: document.documentElement.scrollWidth }));
}

export { settle };
