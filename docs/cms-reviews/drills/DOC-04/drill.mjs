// DOC-04 browser drills (P1-DOC-04.md): headless desktop Chrome over the
// DevTools protocol, against the design harness on a private port. Kept with
// the screenshots so the drill can be re-run; not part of `pnpm test`.
// Reads the local test password from the gitignored .design-env and never
// prints it. Scenarios: page | designer | publish | dbdown (needs lock.mjs),
// and from fix round 1: media | warnings.
//   node scripts/dev-design.js seed
//   node docs/cms-reviews/drills/DOC-04/serve.mjs "$PWD" 3164 &
//   node docs/cms-reviews/drills/DOC-04/drill.mjs "$PWD" 3164 9333 docs/cms-reviews/drills/DOC-04 page
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [root, appPort, cdpPort, outDir, scenario = "all"] = process.argv.slice(2);
const BASE = `http://localhost:${appPort}`;
const env = Object.fromEntries(
  readFileSync(join(root, ".design-env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const PW = env.DESIGN_ADMIN_PASSWORD; // never printed
mkdirSync(outDir, { recursive: true });
const profile = join(process.env.TMPDIR || "/tmp", `doc04-chrome-${Date.now()}`);
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new",
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1280,900",
  "about:blank",
], { stdio: "ignore" });
console.log("chrome pid", chrome.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 50 && !targets; i++) {
  await sleep(200);
  try {
    targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  } catch {}
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method) for (const l of listeners) l(msg);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  return r.result.value;
};
const waitFor = async (expression, label, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await evaluate(expression)) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const nav = async (path, readyExpr, label) => {
  await send("Page.navigate", { url: `${BASE}${path}` });
  await waitFor(readyExpr, label, 90000);
  await sleep(600);
};
const shots = [];
const shot = async (name, { y = 0, height = 900, scale = 0.7 } = {}) => {
  const r = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y, width: 1280, height, scale } });
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  shots.push([name, statSync(file).size]);
  console.log("shot", name, statSync(file).size);
};
// click a button by its visible text (exact), optionally the n-th match
const clickText = (text, n = 0, sel = "button") =>
  evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b[${n}]) throw new Error("no ${text}"); b[${n}].click(); return b.length; })()`);
const clickLabel = (label, n = 0) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('[aria-label=${JSON.stringify(label)}]')]; if (!b[${n}]) throw new Error("no ${label}"); b[${n}].click(); return b.length; })()`);
const typeInto = (selector, n, value) =>
  evaluate(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${n}]; if (!el) throw new Error("no field"); const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const bannerLines = (title) =>
  evaluate(`(() => { const t = [...document.querySelectorAll('[role="alert"]')].find((b) => b.textContent.includes(${JSON.stringify(title)})); return t ? [...t.querySelectorAll("li, p")].map((x) => x.textContent.trim()).filter(Boolean) : null; })()`);
const api = (method, url, body) =>
  evaluate(`fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json" }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ""} }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);

const log = [];
const note = (k, v) => {
  log.push([k, v]);
  console.log(k, typeof v === "string" ? v : JSON.stringify(v));
};

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await nav("/admin/login", "document.readyState === 'complete'", "login page");
  const login = await evaluate(`fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "", password: ${JSON.stringify(PW)} }) }).then((r) => r.status)`);
  note("login status", login);

  if (scenario === "all" || scenario === "page") {
    // D1: a page with three problems, two in sections never saved
    const made = await api("PUT", "/api/admin/storefront", { page: { slug: "drill-doc04", title: "DOC-04 drill", sections: [{ kind: "text", heading: "About us", body: ["We make things by hand."] }] }, revision: null });
    note("page create", made.status);
    await nav("/admin/storefront/pages/drill-doc04", "!!document.querySelector('[aria-label=\"Section heading\"]')", "page editor");
    await clickText("Text");
    await clickText("Image");
    await clickText("Rich HTML");
    await sleep(300);
    await typeInto('[aria-label="Section HTML"]', 0, "Free on orders <500 and >100 rupees.");
    await sleep(300);
    await clickText("Save");
    await waitFor(`[...document.querySelectorAll('[role="alert"]')].some((b) => b.textContent.includes("Couldn't save"))`, "page refusal banner");
    note("D1 page banner", await bannerLines("Couldn't save"));
    await evaluate("window.scrollTo(0, 0)");
    await sleep(300);
    await shot("D1-page-editor-three-issues");
    // D2: clicking a line scrolls to its section
    await evaluate(`(() => { const t = [...document.querySelectorAll('[role="alert"]')].find((b) => b.textContent.includes("Couldn't save")); t.querySelectorAll("li button")[1].click(); })()`);
    await sleep(1200);
    note("D2 scrolled to", await evaluate(`(() => { const el = [...document.querySelectorAll('[id^="pe-sec-"]')].find((c) => { const r = c.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2 + 200 && c.textContent.includes("Choose from library"); }); return el ? el.id : null; })()`));
    note("D2 scrollY", await evaluate("Math.round(scrollY)"));
    await shot("D2-page-editor-line-scrolls-to-image");
    // D3: move the image up; the banner renumbers with no new request
    await clickLabel("Move section up", 2);
    await sleep(500);
    await evaluate("window.scrollTo(0, 0)");
    await sleep(300);
    note("D3 banner after move", await bannerLines("Couldn't save"));
    await shot("D3-page-editor-renumbered-after-move");
  }

  if (scenario === "all" || scenario === "designer") {
    await nav("/admin/storefront/designer", "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Add section')", "designer");
    await clickText("Add section");
    await sleep(300);
    await clickText("Banner / CTA");
    await sleep(400);
    await clickText("Save");
    await waitFor(`[...document.querySelectorAll('[role="alert"]')].some((b) => b.textContent.includes("Couldn't save the homepage sections"))`, "designer refusal");
    note("D4 designer banner", await bannerLines("Couldn't save the homepage sections"));
    await evaluate("window.scrollTo(0, 0)");
    await shot("D4-designer-refusal");
    // select something else, then click the line: the new banner is selected
    await clickText("Hero");
    await sleep(300);
    await evaluate(`(() => { const t = [...document.querySelectorAll('[role="alert"]')].find((b) => b.textContent.includes("Couldn't save the homepage sections")); t.querySelector("button").click(); })()`);
    await sleep(500);
    note("D5 selected", await evaluate(`(() => { const b = document.querySelector('[aria-current="true"]'); return b ? b.textContent.trim() : null; })()`));
    await shot("D5-designer-line-selects-section");
  }

  if (scenario === "all" || scenario === "publish") {
    const view = await api("GET", "/api/admin/storefront");
    const sections = view.body.blocks.home_sections.filter((s) => s.kind !== "banner" || s.title);
    const next = [...sections, { id: "sec_drill1", kind: "banner", title: "Monsoon sale", text: "Up to 30% off", label: "Shop now", href: "/collections/not-a-collection", enabled: true }];
    const saved = await api("PUT", "/api/admin/storefront", { block: "home_sections", value: next, revision: view.body.revisions.home_sections ?? null });
    note("D6 save banner with dead link", saved.status);
    await nav("/admin/releases", "!!document.querySelector('main')", "releases");
    await waitFor(`document.body.textContent.includes("Fix before publishing")`, "publish issues", 30000);
    note("D6 publish issues", await evaluate(`(() => { const b = [...document.querySelectorAll('[role="alert"]')].find((x) => x.textContent.includes("Fix before publishing")); return b ? [...b.querySelectorAll("li")].map((l) => l.textContent.trim()) : null; })()`));
    await shot("D6-publish-panel-issue-from-id");
  }

  // Fix round 1, D8: an image used on a page whose slug says "network". The
  // Media screen's Delete must reach the "still referenced" guard (the only
  // way to force-delete), not "We couldn't reach your store's data".
  if (scenario === "media") {
    const up = await evaluate(`(async () => {
      const c = document.createElement("canvas"); c.width = 8; c.height = 8;
      const g = c.getContext("2d"); g.fillStyle = "#2f6f4f"; g.fillRect(0, 0, 8, 8);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const fd = new FormData(); fd.append("file", blob, "partners-doc04.png"); fd.append("alt", "Our partners");
      const r = await fetch("/api/admin/media", { method: "POST", body: fd });
      return { status: r.status, body: await r.json().catch(() => null) };
    })()`);
    note("D8 upload", { status: up.status, id: up.body?.media?.id || null, error: up.body?.error || null });
    const url = up.body?.media?.url;
    const made = await api("PUT", "/api/admin/storefront", { page: { slug: "partner-network", title: "Partner network", sections: [{ kind: "image", src: url, alt: "Our partners" }] }, revision: null });
    note("D8 page partner-network", made.status);
    await nav("/admin/media", "!!document.querySelector('[aria-label=\"Delete partners-doc04.png\"]')", "media library");
    await clickLabel("Delete partners-doc04.png");
    await sleep(400);
    await clickText("Delete");
    await waitFor(`document.body.textContent.includes("Still referenced") || document.body.textContent.includes("couldn't reach")`, "delete answer", 30000);
    await sleep(400);
    note("D8 dialog", await evaluate(`(() => { const d = [...document.querySelectorAll('[role="dialog"], dialog')].map((x) => x.textContent.replace(/\\s+/g, " ").trim()).filter(Boolean); return d; })()`));
    note("D8 shows the store-data message", await evaluate(`document.body.textContent.includes("couldn't reach your store's data")`));
    await shot("D8-media-delete-still-referenced");
  }

  // Fix round 1, D9: after Publish now, the warnings banner at the top says
  // where each warning is (announcement, hero, menu, banner section).
  if (scenario === "warnings") {
    const view = await api("GET", "/api/admin/storefront");
    const rev = view.body.revisions;
    const put = async (block, value) => note(`D9 save ${block}`, (await api("PUT", "/api/admin/storefront", { block, value, revision: rev[block] ?? null })).status);
    await put("announcement", { ...view.body.blocks.announcement, enabled: true, text: view.body.blocks.announcement.text || "Monsoon sale", href: "/another-odd" });
    await put("hero", { ...view.body.blocks.hero, primary: { label: view.body.blocks.hero.primary?.label || "Shop", href: "/x-odd" } });
    const sections = view.body.blocks.home_sections.filter((s) => s.kind !== "banner" || s.title);
    await put("home_sections", [...sections, { id: "sec_drill9", kind: "banner", title: "Partner week", text: "", label: "See partners", href: "/odd-route", enabled: true }]);
    note("D9 banner section number", sections.length + 1);
    await nav("/admin/releases", "!!document.querySelector('main')", "releases");
    await waitFor(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Publish now" && !b.disabled)`, "publish enabled", 30000);
    note("D9 card warnings before publishing", await evaluate(`[...document.querySelectorAll("li")].map((l) => l.textContent.trim()).filter((t) => t.includes("isn't a storefront route"))`));
    await clickText("Publish now", 0);
    await sleep(500);
    await clickText("Publish now", 1); // the dialog's confirm
    await waitFor(`[...document.querySelectorAll("p")].some((p) => p.textContent.includes("isn't a storefront route"))`, "result warnings", 30000);
    await sleep(500);
    note("D9 banner after Publish now", await evaluate(`[...document.querySelectorAll("p")].map((p) => p.textContent.trim()).filter((t) => t.includes("isn't a storefront route"))`));
    await evaluate("window.scrollTo(0, 0)");
    await sleep(300);
    await shot("D9-publish-result-warnings-located");
  }

  if (scenario === "dbdown") {
    await nav("/admin/storefront/pages/drill-doc04", "!!document.querySelector('[aria-label=\"Section heading\"]')", "page editor");
    await typeInto('[aria-label="Section heading"]', 0, "About us (edited while the database is locked)");
    await sleep(300);
    // the editor is loaded; now another process holds the tenant database
    const locker = spawn("node", [join(process.argv[1], "..", "lock.mjs"), join(root, ".design-tenant.db"), "40"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
    console.log("lock pid", locker.pid);
    await new Promise((r) => locker.stdout.on("data", (d) => String(d).includes("locked") && r()));
    note("D7 lock held by pid", locker.pid);
    process.on("exit", () => locker.kill("SIGTERM"));
    await clickText("Save");
    await waitFor(`[...document.querySelectorAll('[role="alert"]')].some((b) => b.textContent.includes("Couldn't save"))`, "db failure banner", 60000);
    note("D7 banner", await bannerLines("Couldn't save"));
    note("D7 still unsaved", await evaluate(`document.body.textContent.includes("Unsaved")`));
    await evaluate("window.scrollTo(0, 0)");
    await shot("D7-page-editor-database-locked");
  }
} catch (e) {
  note("ERROR", String(e.message || e));
  try {
    await shot(`error-${scenario}`);
  } catch {}
} finally {
  writeFileSync(join(outDir, `drill-log-${scenario}.json`), JSON.stringify({ when: new Date().toISOString(), base: BASE, log, shots }, null, 2));
  ws.close();
  chrome.kill("SIGTERM");
  console.log("chrome stopped");
}
