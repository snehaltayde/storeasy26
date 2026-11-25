// The support stray-control pass (moved out of scripts/drills/shell/run.mjs by
// Phase 3 line 5, docs/plans/phase-3.md "Line 5"), so drill:shell and
// drill:support-access run the same pass: drill:shell as the support member,
// drill:support-access as an operator under support access across hosts.
// strayPass({ origin, controls, nextLog }) returns the pass bound to one
// store's origin, the shell controls a page may show (data-shell-control
// values) and that store's Next dev log (the server-side witness).
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { settle } from "../p3/lib.mjs";
import { readPost } from "../../support/read-post-match.js";

// the drill's own self-test pages live under this path (drill:shell)
export const SELFTEST = "/__shell-drill-selftest";

export function strayPass({ origin, controls, nextLog = null }) {
  const ORIGIN = origin;
  const CONTROLS = controls;
  // In the page: interactive elements (contenteditable regions and ARIA
  // switches, checkboxes, tabs and options count, native buttons or not) that
  // are not nav links or allowlisted shell controls, anywhere on the page (the
  // rule covers the whole of main). A control also passes when it carries data-read-control itself
  // (never through an ancestor), is natively disabled, or is RoleGate's
  // (aria-disabled="true" with data-role-gate="disabled"). Radix's focus
  // guards (an empty span[data-radix-focus-guard] with tabindex="0" around a
  // sheet, select or dialog) are not controls; anything else in a portal is.
  function strayControls([allowed]) {
    const q = 'a[href], button, input, select, textarea, summary, label[for], [contenteditable]:not([contenteditable="false"]), [role="button"], [role="menuitem"], [role="link"], [role="switch"], [role="checkbox"], [role="tab"], [role="option"], [onclick], [tabindex]:not([tabindex="-1"])';
    const own = (el) => (el.hasAttribute("data-read-control") || el.disabled === true || (el.getAttribute("aria-disabled") === "true" && el.getAttribute("data-role-gate") === "disabled"));
    // Phase 2 line 6: a label[for] does what its control does: it passes when that control passes (a disabled field, a marked read)
    const passes = (el) => own(el) || (el.matches("label[for]") && Boolean(document.getElementById(el.htmlFor)) && own(document.getElementById(el.htmlFor)));
    const focusGuard = (el) => el.matches("span[data-radix-focus-guard]") && el.getAttribute("tabindex") === "0" && el.textContent === "" && el.children.length === 0;
    return [...document.querySelectorAll(q)]
      .filter((el) => !el.closest("[data-nav-item]") && !allowed.some((c) => el.closest(`[data-shell-control="${c}"]`)) && !passes(el) && !focusGuard(el))
      .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""} "${(el.innerText || "").trim().slice(0, 40)}"`);
  }
  // In the page (a new-UI route): marked reads that could still write: a
  // submit or image button, a form= or formaction override, or one inside a
  // form without an explicit method="get".
  function unsafeReads() {
    const formOk = (f) => !f || (f.getAttribute("method") || "").toLowerCase() === "get";
    return [...document.querySelectorAll("[data-read-control]")]
      .filter((el) => {
        const type = (el.getAttribute("type") || "").toLowerCase();
        return type === "submit" || type === "image" || el.hasAttribute("form") || el.hasAttribute("formaction") || (el.tagName === "BUTTON" && el.closest("form") && !el.hasAttribute("type")) || !formOk(el.closest("form"));
      })
      .map((el) => `${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute("aria-label") || el.getAttribute("alt") || "").trim().slice(0, 40)}"`);
  }
  // In the page: forms a support user could submit with Enter. A form with a
  // text field submits implicitly unless its default (first) submit button is
  // natively disabled or RoleGate's; an explicit method="get" form only
  // navigates (a search), so it passes.
  function implicitSubmits() {
    const TEXT = new Set(["", "text", "search", "email", "number", "password", "tel", "url", "date", "datetime-local", "month", "time", "week"]);
    const gated = (b) => b.disabled || (b.getAttribute("aria-disabled") === "true" && b.getAttribute("data-role-gate") === "disabled");
    return [...document.querySelectorAll("form")]
      .filter((f) => (f.getAttribute("method") || "").toLowerCase() !== "get")
      .filter((f) => [...f.elements].some((e) => e.tagName === "INPUT" && TEXT.has((e.getAttribute("type") || "").toLowerCase()) && !e.disabled && !e.readOnly))
      .filter((f) => {
        const submit = [...f.elements].find((e) => (e.tagName === "BUTTON" && (e.getAttribute("type") || "submit").toLowerCase() === "submit") || (e.tagName === "INPUT" && ["submit", "image"].includes((e.getAttribute("type") || "").toLowerCase())));
        return !submit || !gated(submit);
      })
      .map((f) => `form${f.id ? `#${f.id}` : ""} (${f.elements.length} fields)`);
  }

  // Support on a new-UI route (and the drill's self-test pages):
  //   - the page under test is page.url() after loading href, and must be href
  //   - each marked read: click it; when the path is unchanged (a new query
  //     string included) the whole document (portals, menus, popovers) may
  //     hold no stray control
  //   - each RoleGate-disabled control: mouse-click it and press Enter and Space
  //     on it: no non-GET request, no navigation
  //   - each enabled text field: press Enter in it: no non-GET request
  //   - every non-GET request any page of the context sends counts (workers,
  //     popups and new tabs included; no Referer is trusted) while the tab's
  //     document is the page under test: from that document's first request
  //     until the next document's first request. A same-document pushState or
  //     replaceState never ends it. When a click (or Enter) leaves the tab, once
  //     it settles, on another path in the same document, it was a soft
  //     navigation (a Next <Link>: /admin/onboarding and /admin/releases write
  //     when they open, and those pages' passes are their own): the writes sent
  //     since that click, and until the next document, go to the destination
  //     (found.softNav), not this page. A control that pushStates away, POSTs
  //     and pushStates back is still on the page when it settles, so its write
  //     counts. (The event order can't decide this: Chromium reports a soft
  //     navigation's history change after the destination's first requests.)
  //     The limit: a raw pushState that stays away looks the same as a soft
  //     navigation, so its writes go to that path too. Each
  //     document's first request is the drill's sentinel (an init script's GET
  //     /__shell-drill-doc?p=<path>, answered by page.route, never by Next), so a
  //     write the old document sends while it unloads still counts. A read link
  //     that loads another document gets its own pass. Skipped only: a
  //     READ_POSTS row for this page (scripts/support/read-controls.js, a read
  //     sent as POST: { page (a route pattern), method, path, reason, body? }; a
  //     row with a body rule lets through only a request whose JSON body holds
  //     those fields), and
  //     Next's dev error overlay (POST /__nextjs_*) when the server is a dev
  //     server (its page opened the HMR socket), never against a production build.
  //   - and, as a second witness, the server's own request log (the roles
  //     store's Next log in DRILL_LOG_DIR; drill:shell refuses to run without
  //     it): every non-GET line written during the pass that the browser did
  //     not see sent counts too. It sees what the browser events miss: a
  //     sendBeacon or keepalive fetch sent from pagehide (Chromium reports
  //     neither, and they bypass page.route), a request from a dedicated
  //     worker, or from a popup before Playwright attaches to it. Before the
  //     pass reads the log it waits until no request is pending and the log
  //     has stopped growing, and the pass must find its own GET <target> line
  //     there (a log format drift or a missing log fails loudly).
  // Returns what it found; the caller checks.
  const NEXT_LOG = nextLog;
  const logSize = () => {
    try {
      return NEXT_LOG ? statSync(NEXT_LOG).size : 0;
    } catch {
      return 0;
    }
  };
  // The self-test pages never reach Next: the drill's own route answers them,
  // so it is their server and keeps their log here ({ method, path }), written
  // when the response is sent, as Next writes its line.
  const SELFTEST_SERVER_LOG = [];
  const serverMark = () => ({ next: logSize(), own: SELFTEST_SERVER_LOG.length });
  // next dev's request lines (colour codes stripped): [{ method, path, status }]
  // (Phase 2 line 6: the status, so a READ_POSTS row with ops passes only a 2xx)
  const LOG_LINE = /^\s*(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/\S*) (\d{3}) in \d/gm;
  function parseNextLog(text) {
    return [...text.replace(/\u001b\[[0-9;]*m/g, "").matchAll(LOG_LINE)].map((m) => ({ method: m[1], path: m[2].split("?")[0], status: Number(m[3]) }));
  }
  // Lines from a real Next 16.2.9 dev log (a drill:shell run's server.log,
  // 2026-11-24), byte for byte: parseNextLog must read each.
  const CAPTURED_NEXT_LOG = [
    " GET /admin/dashboard 200 in 674ms (next.js: 40ms, application-code: 635ms)",
    " POST /api/admin/login 200 in 39ms (next.js: 833µs, application-code: 38ms)",
    " PUT /api/admin/documents 200 in 9ms (next.js: 785µs, application-code: 9ms)",
  ].join("\n");
  const CAPTURED_PARSED = [{ method: "GET", path: "/admin/dashboard", status: 200 }, { method: "POST", path: "/api/admin/login", status: 200 }, { method: "PUT", path: "/api/admin/documents", status: 200 }];
  function nextLogLines(from, to) {
    if (!NEXT_LOG || to <= from) return [];
    const buf = Buffer.alloc(to - from);
    const fd = openSync(NEXT_LOG, "r");
    try {
      readSync(fd, buf, 0, buf.length, from);
    } finally {
      closeSync(fd);
    }
    return parseNextLog(buf.toString("utf8"));
  }
  // the server's request lines between two marks: [{ method, path }]
  const loggedRequests = (from, to) => [...nextLogLines(from.next, to.next), ...SELFTEST_SERVER_LOG.slice(from.own, to.own)];
  const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  // readPost (scripts/support/read-post-match.js, tested in test-drills): a row
  // with ops passes the browser's body only as one of its ops (never
  // saveDraft), and a server line only with a 2xx (a 400, 403, 0 or missing
  // status is a write)
  // Each document's first request: an init script on the tab under test asks
  // for DOC_SENTINEL with its path; page.route answers it (it never reaches the
  // server). Once per tab.
  const DOC_SENTINEL = "/__shell-drill-doc";
  const sentinelled = new WeakSet();
  async function addDocSentinel(page) {
    if (sentinelled.has(page)) return;
    sentinelled.add(page);
    await page.route((u) => u.pathname === DOC_SENTINEL, (route) => route.fulfill({ status: 204, body: "" }));
    await page.addInitScript((path) => {
      if (window.top === window && location.protocol.startsWith("http")) fetch(`${path}?p=${encodeURIComponent(location.pathname)}`, { cache: "no-store" }).catch(() => {});
    }, DOC_SENTINEL);
  }
  async function untilQuiet(page, pending) {
    for (let t = 0; pending.size && t < 100; t++) await page.waitForTimeout(100);
    let size = logSize();
    for (let t = 0; t < 50; t++) {
      await page.waitForTimeout(250);
      const now = logSize();
      if (now === size && t >= 1) break;
      size = now;
    }
  }
  async function supportNewUiControls(page, href) {
    const writes = [];
    const target = new URL(ORIGIN + href).pathname;
    const ctx = page.context();
    await addDocSentinel(page);
    let counting = false; // the tab's current document is the page under test
    let devServer = false;
    const popups = [];
    const seen = []; // every non-GET request the browser reported during the pass: { method, path }
    const pending = new Set();
    const passFrom = serverMark();
    let away = false; // a click moved the target document (same document) to another path
    let docs = 0; // documents started in the tab during the pass
    // after a click or Enter has settled (mark: taken just before it)
    const mark = () => ({ writes: writes.length, docs });
    const softNavCheck = (m) => {
      if (!counting || docs !== m.docs || new URL(page.url()).pathname === target) return;
      found.softNav.push(...writes.splice(m.writes));
      away = true;
    };
    // a new document: the old one's requests will never report finishing (a keepalive)
    const newDocument = () => {
      for (const r of pending) {
        try {
          if (r.frame() === page.mainFrame()) pending.delete(r);
        } catch {}
      }
    };
    const skip = (method, path, body, status) => (devServer && path.startsWith("/__nextjs")) || readPost(target, method, path, body, status);
    const onSocket = (ws) => {
      if (/\/_next\/webpack-hmr/.test(ws.url())) devServer = true;
    };
    const onRequest = (req) => {
      const url = new URL(req.url());
      if (url.pathname === DOC_SENTINEL) {
        let main = false;
        try {
          main = req.frame() === page.mainFrame();
        } catch {}
        if (main) {
          docs++;
          away = false;
          newDocument();
          counting = url.searchParams.get("p") === target;
        }
        return;
      }
      // Next's dev overlay posts stack frames on its own schedule (an HMR dev
      // server only); it is no request of the page under test, so never wait on it
      if (!(devServer && url.pathname.startsWith("/__nextjs"))) pending.add(req);
      if (req.method() === "GET" || req.method() === "HEAD") return;
      seen.push({ method: req.method(), path: url.pathname });
      let body;
      try {
        body = req.postData() ?? undefined;
      } catch {}
      if (!counting || skip(req.method(), url.pathname, body)) return;
      (away ? found.softNav : writes).push(`${req.method()} ${url.pathname}`);
    };
    const onDone = (req) => pending.delete(req);
    const onPage = (p) => {
      if (p !== page) popups.push(p);
    };
    const found = { at: [], unsafe: [], implicit: [], revealed: [], moved: [], writes, reads: 0, dialogReads: 0, gated: 0, fields: 0, logged: [], logSeen: false, pending: [], softNav: [] };
    const fresh = async () => {
      await page.goto(ORIGIN + href, { waitUntil: "load" });
      await settle(page);
      if (page.url() !== ORIGIN + href) found.at.push(page.url());
    };
    page.on("websocket", onSocket);
    ctx.on("request", onRequest);
    ctx.on("requestfinished", onDone);
    ctx.on("requestfailed", onDone);
    ctx.on("page", onPage);
    try {
      await fresh();
      found.unsafe = await page.evaluate(unsafeReads);
      found.implicit = await page.evaluate(implicitSubmits);
      found.reads = await page.locator("main [data-read-control]").count();
      for (let i = 0; i < found.reads; i++) {
        await fresh();
        const el = page.locator("main [data-read-control]").nth(i);
        if (!(await el.isVisible().catch(() => false)) || (await el.isDisabled().catch(() => true))) continue;
        const m = mark();
        await el.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        await settle(page);
        softNavCheck(m);
        // a link to another path: that page gets its own pass; the same path
        // (a menu, a popover, or a new ?query) is checked again here
        if (new URL(page.url()).pathname === target) for (const x of await page.evaluate(strayControls, [CONTROLS])) found.revealed.push(`after read #${i} (${page.url().slice(ORIGIN.length)}): ${x}`);
        // a read that opened a dialog (a sheet, a details panel): each marked
        // read inside it is clicked once, from a fresh open, and the document
        // checked again (Phase 2 line 5)
        const inDialog = new URL(page.url()).pathname === target ? await page.locator('[role="dialog"] [data-read-control]').count() : 0;
        for (let j = 0; j < inDialog; j++) {
          await fresh();
          await page.locator("main [data-read-control]").nth(i).click({ timeout: 5000 }).catch(() => {});
          await page.locator('[role="dialog"]').first().waitFor({ timeout: 5000 }).catch(() => {});
          const inner = page.locator('[role="dialog"] [data-read-control]').nth(j);
          if (!(await inner.isVisible().catch(() => false)) || (await inner.isDisabled().catch(() => true))) continue;
          const mi = mark();
          await inner.click({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(500);
          await settle(page);
          softNavCheck(mi);
          found.dialogReads++;
          if (new URL(page.url()).pathname === target) for (const x of await page.evaluate(strayControls, [CONTROLS])) found.revealed.push(`after read #${i}, dialog read #${j} (${page.url().slice(ORIGIN.length)}): ${x}`);
        }
      }
      await fresh();
      found.gated = await page.locator('main [data-role-gate="disabled"]').count();
      for (let i = 0; i < found.gated; i++) {
        for (const how of ["click", "Enter", "Space"]) {
          const el = page.locator('main [data-role-gate="disabled"]').nth(i);
          const before = page.url();
          if (how === "click") await el.click({ timeout: 5000, force: true }).catch(() => {});
          else {
            await el.focus().catch(() => {});
            await page.keyboard.press(how);
          }
          await page.waitForTimeout(300);
          if (page.url() !== before) {
            found.moved.push(`${how} on gated #${i} → ${page.url()}`);
            await fresh();
          }
        }
      }
      await fresh();
      const fieldSel = 'main input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly])';
      found.fields = await page.locator(fieldSel).count();
      for (let i = 0; i < found.fields; i++) {
        await fresh();
        const el = page.locator(fieldSel).nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        await el.focus().catch(() => {});
        const mf = mark();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(500);
        await settle(page);
        softNavCheck(mf);
      }
      // the pass's window closes once nothing is in flight and the log is still;
      // leaving for about:blank first lets the page's own pagehide writes land
      // in this pass, not the next one's
      await untilQuiet(page, pending);
      await page.goto("about:blank");
      away = false;
      newDocument();
      await untilQuiet(page, pending);
      found.pending = [...pending].map((r) => `${r.method()} ${new URL(r.url()).pathname}`);
      const own = target.startsWith(SELFTEST);
      found.logged = own ? SELFTEST_SERVER_LOG.slice(passFrom.own) : nextLogLines(passFrom.next, logSize());
      found.logSeen = found.logged.some((l) => l.method === "GET" && l.path === target);
      // a server line the browser saw sent was counted (or excused) above; the rest are writes it could not see
      const unmatched = [...seen];
      for (const l of loggedRequests(passFrom, serverMark())) {
        if (!WRITE.has(l.method)) continue;
        const i = unmatched.findIndex((x) => x.method === l.method && x.path === l.path);
        if (i >= 0) unmatched.splice(i, 1);
        else if (!skip(l.method, l.path, null, l.status ?? 0)) writes.push(`${l.method} ${l.path} (server log, not seen by the browser)`);
      }
    } finally {
      page.off("websocket", onSocket);
      ctx.off("request", onRequest);
      ctx.off("requestfinished", onDone);
      ctx.off("requestfailed", onDone);
      ctx.off("page", onPage);
      for (const p of popups) await p.close().catch(() => {});
    }
    return found;
  }
  const checkNewUi = (check, href, f) => {
    check(f.at.length === 0, `${href}: the page under test is ${href} after loading it`, f.at);
    check(f.unsafe.length === 0, `${href}: no marked read control submits a form (submit, image, form=, formaction, a non-GET form)`, f.unsafe);
    check(f.implicit.length === 0, `${href}: no form support can submit with Enter (a text field needs a gated or disabled default submit, or method="get")`, f.implicit);
    check(f.revealed.length === 0, `${href}: clicking support's ${f.reads} marked read(s) and ${f.dialogReads} read(s) inside the dialogs they open reveals no write control anywhere (menus and popovers included)`, f.revealed);
    check(f.writes.length === 0, `${href}: support's reads, ${f.gated} gated control(s) (click, Enter, Space) and ${f.fields} field(s) (Enter) send no non-GET request`, f.writes);
    check(f.moved.length === 0, `${href}: support's gated controls do not navigate`, f.moved);
    check(f.logSeen, `${href}: the pass found its own GET ${new URL(ORIGIN + href).pathname} line in the Next log (${NEXT_LOG})`, f.logged.slice(0, 20));
    check(f.pending.length === 0, `${href}: no request was still pending when the pass closed`, f.pending);
  };

  return { strayControls, unsafeReads, implicitSubmits, parseNextLog, CAPTURED_NEXT_LOG, CAPTURED_PARSED, SELFTEST_SERVER_LOG, supportNewUiControls, checkNewUi, NEXT_LOG };
}
