// P3-STORE (ED-02, ED-03, PV-01, PV-02, PUB-04, PUB-09): the editor's store
// (components/admin/editor/store.js) and the preview label machine
// (components/admin/editor/previewMachine.js). Both are plain JS; node drives
// them with a stand-in clock and storage.
//   Part 1  the store against a scripted server: timing, single flight,
//           retries, the keepalive limit, the local backup, publish.
//   Part 2  the store against the REAL documents API (lib/admin/documents-api.js
//           on file databases with every migration, real sessions), through
//           the real documentsApi client with fetch routed in-process: the
//           four server-replace operations, the 409 choice, 422 and the web
//           address.
//   Part 3  previewMachine, every input.
//   pnpm test:editor-store
import { readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const started = Date.now();

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-editor-store-default.db";
process.env.PLATFORM_DB_URL = "file:.test-editor-store-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-editor-store-default.db", ".test-editor-store-platform.db", ".test-editor-store-docs.db"];
const cleanup = async () => {
  for (const f of dbs) await rm(join(ROOT, f), { force: true });
};
await cleanup();

const St = await import("../components/admin/editor/store.js");
const PM = await import("../components/admin/editor/previewMachine.js");
const { createDocumentsApi, KEEPALIVE_MAX_BYTES } = await import("../components/admin/editor/documentsApi.js");

let pass = 0;
let fail = 0;
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
async function t(name, fn) {
  if (only && !only.test(name)) return;
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.stack?.split("\n").slice(0, 5).join("\n   ") || e.message}`);
  }
}
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};
async function until(cond, label, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// A clock the test moves by hand.
function fakeClock() {
  let now = 0;
  let next = 0;
  const q = [];
  return {
    setTimeout(fn, ms) {
      const h = ++next;
      q.push({ h, at: now + Math.max(0, Number(ms) || 0), fn });
      return h;
    },
    clearTimeout(h) {
      const i = q.findIndex((x) => x.h === h);
      if (i >= 0) q.splice(i, 1);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        q.sort((a, b) => a.at - b.at || a.h - b.h);
        const n = q[0];
        if (!n || n.at > end) break;
        q.shift();
        now = n.at;
        n.fn();
      }
      now = end;
      await settle();
    },
    now: () => now,
    pending: () => q.length,
  };
}

// A scripted server for one document. saveDraft checks the revision like the
// real one; keepAsEarlierDraft keeps; any op can be answered by hand
// (api.on[op]) or held until released (api.holdNext(op)).
function fakeApi(doc) {
  const server = { revision: doc.revision, body: clone(doc.body), draftHash: doc.draftHash, kept: [] };
  const calls = [];
  const keepalives = [];
  const holds = [];
  const waiting = [];
  let active = 0;
  let maxActive = 0;
  const on = {};
  const documentOf = () => ({ ...doc, body: clone(server.body), revision: server.revision, draftHash: server.draftHash });
  function answer(op, args, extra) {
    if (on[op]) return on[op](args, extra, server, documentOf);
    if (op === "saveDraft") {
      if (extra?.revision !== server.revision) return { conflict: true, code: "DOCUMENT_CHANGED", message: "changed", current: { ...documentOf(), updatedByName: "Asha" } };
      server.body = clone(args.body);
      server.revision++;
      server.draftHash = `h${server.revision}`;
      return { ok: true, data: { ok: true, document: documentOf(), issues: [] } };
    }
    if (op === "keepAsEarlierDraft") {
      server.kept.push(clone(args.body));
      return { ok: true, data: { ok: true, savedVersion: { id: `ver_k${server.kept.length}`, note: St.KEPT_NOTE } } };
    }
    if (op === "getDocument") return { ok: true, data: { ok: true, document: documentOf() } };
    return { error: true, code: "NOT_SCRIPTED", message: `not scripted: ${op}` };
  }
  const api = {
    server,
    calls,
    keepalives,
    on,
    get maxActive() {
      return maxActive;
    },
    get waiting() {
      return waiting.length;
    },
    holdNext(op) {
      holds.push(op);
    },
    release() {
      const w = waiting.shift();
      if (w) w();
    },
    call(op, args, extra) {
      calls.push({ op, args: clone(args), extra: clone(extra) });
      const isSave = op === "saveDraft";
      if (isSave) maxActive = Math.max(maxActive, ++active);
      const done = (r) => {
        if (isSave) active--;
        return r;
      };
      const i = holds.indexOf(op);
      if (i >= 0) {
        holds.splice(i, 1);
        return new Promise((res) => waiting.push(() => res(done(answer(op, args, extra)))));
      }
      return Promise.resolve().then(() => done(answer(op, args, extra)));
    },
    sendKeepalive(op, args, extra) {
      keepalives.push({ op, args: clone(args), extra: clone(extra) });
      return true;
    },
  };
  return api;
}

const textSec = (id, title, body = ["Some words."]) => ({ id, kind: "text", v: 1, enabled: true, settings: { title, body }, blocks: [] });
const pageBody = (slug, sections) => ({ schema: 1, type: "page", meta: { slug, title: `Page ${slug}`, description: "", enabled: true, effective_at: null, window_start: null, window_end: null, redirect_from: [] }, sections });
const fakeDoc = (over = {}) => ({ id: "doc_p1", type: "page", slug: "p1", label: "Page p1", body: pageBody("p1", [textSec("sec_t1", "One")]), draftHash: "h3", revision: 3, ...over });
const saves = (api) => api.calls.filter((c) => c.op === "saveDraft");
const titleOf = (body, id = "sec_t1") => body.sections.find((s) => s.id === id)?.settings?.title;

// A Map-backed stand-in for localStorage.
function memoryStorage() {
  const m = new Map();
  return {
    m,
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}
const throwingStorage = () => ({
  get length() {
    throw new Error("blocked");
  },
  key() {
    throw new Error("blocked");
  },
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
  removeItem() {
    throw new Error("blocked");
  },
});

const P = St.AUTOSAVE_PAUSE_MS;
const T1 = "sections.sec_t1.settings.title";

// =====================================================================================
console.log("— Part 1: the store against a scripted server");

await t("unit: typing during an in-flight save is kept and saved next; only one save is in flight at a time", async () => {
  const clock = fakeClock();
  const api = fakeApi(fakeDoc());
  const s = St.createDocumentStore({ api, document: fakeDoc(), timers: clock, now: clock.now });
  api.holdNext("saveDraft");
  s.setField(T1, "a");
  await clock.advance(P);
  eq(saves(api).length, 1, "the first save went out:");
  eq(s.getState().status, "saving", "status:");
  eq(s.getState().statusWords, "Saving", "words:");
  s.setField(T1, "ab");
  await clock.advance(P); // the pause ends while the first is in flight
  eq(saves(api).length, 1, "no second save while the first is in flight:");
  s.setField(T1, "abc");
  api.holdNext("saveDraft");
  api.release(); // the first answers
  await settle();
  eq(titleOf(s.getState().body), "abc", "the text typed since is kept, not replaced by the answer:");
  eq(s.getState().revision, 4, "the answer's revision is taken:");
  eq(s.getState().draftHash, "h4", "and its draftHash:");
  eq(saves(api).length, 2, "the next save went out at once:");
  eq(titleOf(saves(api)[1].args.body), "abc", "with the newest text:");
  eq(saves(api)[1].extra, { revision: 4 }, "on the acknowledged revision:");
  api.release();
  await clock.advance(P * 3);
  eq(saves(api).length, 2, "nothing more to save:");
  eq(api.maxActive, 1, "never two saves in flight:");
  eq(titleOf(api.server.body), "abc", "the server has the newest text:");
  eq([s.getState().status, s.getState().statusWords, s.getState().unacknowledged], ["saved", "Saved", false], "saved:");
});

await t("unit: a burst of typing within the pause gives one save, with the last text", async () => {
  const clock = fakeClock();
  const api = fakeApi(fakeDoc());
  const s = St.createDocumentStore({ api, document: fakeDoc(), timers: clock, now: clock.now });
  for (const ch of ["H", "He", "Hel", "Hell", "Hello"]) {
    s.setField(T1, ch);
    await clock.advance(P - 100);
  }
  eq(saves(api).length, 0, "none while typing:");
  eq(s.getState().statusWords, "Saving", "a pending edit never says Saved:");
  await clock.advance(100);
  eq(saves(api).length, 1, "one save:");
  eq(titleOf(saves(api)[0].args.body), "Hello", "the last text:");
  await clock.advance(P * 4);
  eq(saves(api).length, 1, "still one:");
});

await t("unit: a save that may be retried is retried by itself; one that may not keeps the text and waits; a network failure is retried", async () => {
  const clock = fakeClock();
  const api = fakeApi(fakeDoc());
  let answers = [
    { error: true, code: "DATABASE_UNAVAILABLE", message: "We couldn't reach your store's data just now, so nothing was saved.", retryable: true },
    { error: true, code: "NETWORK_ERROR", message: "We couldn't reach Storeasy, so nothing was saved." },
  ];
  api.on.saveDraft = (args, extra, server, documentOf) => {
    const a = answers.shift();
    if (a) return a;
    server.body = clone(args.body);
    server.revision++;
    server.draftHash = `h${server.revision}`;
    return { ok: true, data: { ok: true, document: documentOf(), issues: [] } };
  };
  const s = St.createDocumentStore({ api, document: fakeDoc(), timers: clock, now: clock.now });
  s.setField(T1, "Kept");
  await clock.advance(P);
  eq(s.getState().status, "error", "status:");
  ok(s.getState().statusWords.startsWith("Could not save: We couldn't reach your store's data"), `words: ${s.getState().statusWords}`);
  eq(titleOf(s.getState().body), "Kept", "the text is kept:");
  await clock.advance(St.RETRY_DELAYS_MS[0]);
  eq(saves(api).length, 2, "retried once (retryable: true):");
  await clock.advance(St.RETRY_DELAYS_MS[1]);
  eq(saves(api).length, 3, "retried after the network failure:");
  eq(s.getState().status, "saved", "then saved:");

  // retryable: false is not retried by itself
  const api2 = fakeApi(fakeDoc());
  api2.on.saveDraft = () => ({ error: true, code: "DATABASE_NOT_READY", message: "Your store needs an update on our side first, so nothing was saved.", retryable: false });
  const s2 = St.createDocumentStore({ api: api2, document: fakeDoc(), timers: clock, now: clock.now });
  s2.setField(T1, "Waits");
  await clock.advance(P);
  await clock.advance(60_000);
  eq(saves(api2).length, 1, "not retried:");
  eq([s2.getState().status, titleOf(s2.getState().body), s2.getState().unacknowledged], ["error", "Waits", true], "kept and visible:");
});

await t("unit: an edit typed during a server-replace operation onto a section the answer no longer has is not lost: the founder's body is kept as an earlier draft first", async () => {
  const clock = fakeClock();
  const api = fakeApi(fakeDoc());
  api.on.keepLiveSection = (args, extra, server, documentOf) => {
    server.body = pageBody("p1", [textSec("sec_t1", "One")]); // the added section is gone
    server.revision++;
    server.draftHash = `h${server.revision}`;
    return { ok: true, data: { ok: true, document: documentOf() } };
  };
  const s = St.createDocumentStore({ api, document: fakeDoc(), timers: clock, now: clock.now });
  s.insertSection(textSec("sec_new1", "Half done"), 1);
  await clock.advance(P);
  api.holdNext("keepLiveSection");
  const p = s.keepLiveSection("sec_new1");
  await settle();
  s.setField("sections.sec_new1.settings.title", "Still typing here");
  api.release();
  const r = await p;
  ok(r.ok, "keepLiveSection ok");
  eq(api.server.kept.length, 1, "kept one earlier draft:");
  eq(titleOf(api.server.kept[0], "sec_new1"), "Still typing here", "with the edit typed during the hold:");
  eq(s.getState().notice, St.WORDS.replayKept, "and says so:");
  eq(s.getState().body.sections.map((x) => x.id), ["sec_t1"], "the answer's body is shown:");
});

await t("unit: 409 stops autosave; the choice is offered with the other person's name", async () => {
  const clock = fakeClock();
  const api = fakeApi(fakeDoc());
  api.server.revision = 4; // another tab saved
  const s = St.createDocumentStore({ api, document: fakeDoc(), timers: clock, now: clock.now });
  s.setField(T1, "Mine");
  await clock.advance(P);
  const st = s.getState();
  eq(st.status, "conflict", "status:");
  eq(st.conflict.words, "This page was changed in another tab or by Asha.", "words:");
  eq(st.conflict.choices, ["useNewer", "keepMine"], "choices:");
  eq(St.conflictWords({ updatedByName: "another tab" }), "This page was changed in another tab.", "same person:");
  s.setField(T1, "Mine, more");
  await clock.advance(P * 10);
  await clock.advance(60_000);
  eq(saves(api).length, 1, "no save after the 409:");
  eq(titleOf(s.getState().body), "Mine, more", "typing still shows:");
  ok(s.beforeUnload(), "leaving warns while in conflict");
  eq(api.keepalives.length, 0, "and sends no keepalive that would be refused:");
});

await t("unit: beforeNavigate flushes the pending edit and answers once it is saved", async () => {
  const clock = fakeClock();
  const api = fakeApi(fakeDoc());
  const s = St.createDocumentStore({ api, document: fakeDoc(), timers: clock, now: clock.now });
  s.setField(T1, "Typed, then a link");
  const r = await s.beforeNavigate();
  eq(r.ok, true, "ok:");
  eq(saves(api).length, 1, "saved without waiting for the pause:");
  eq(titleOf(api.server.body), "Typed, then a link", "the server has it:");
  eq(s.getState().unacknowledged, false, "nothing unacknowledged:");
  await clock.advance(P * 2);
  eq(saves(api).length, 1, "the cancelled pause sends nothing more:");
});

await t("unit: beforeUnload warns while anything is unacknowledged and fires keepalive only when the request is at most 60,000 bytes", async () => {
  const clock = fakeClock();
  const sent = [];
  const real = createDocumentsApi({ fetch: async (url, init) => (sent.push(init), { status: 200, json: async () => ({}) }) });
  const api = fakeApi(fakeDoc());
  api.sendKeepalive = real.sendKeepalive;
  const s = St.createDocumentStore({ api, document: fakeDoc(), timers: clock, now: clock.now });
  eq(s.beforeUnload(), false, "nothing unsaved: no warning");
  eq(sent.length, 0, "and nothing sent:");

  // pad the title so the whole keepalive request is exactly N bytes
  const requestBytes = (title) => {
    const b = s.getState().body;
    const body = { ...b, sections: b.sections.map((x) => (x.id === "sec_t1" ? { ...x, settings: { ...x.settings, title } } : x)) };
    return new TextEncoder().encode(JSON.stringify({ revision: 3, saveDraft: { id: "doc_p1", body } })).length;
  };
  const padTo = (n) => {
    let title = "";
    title = "x".repeat(n - requestBytes(""));
    eq(requestBytes(title), n, "padding:");
    return title;
  };
  s.setField(T1, padTo(KEEPALIVE_MAX_BYTES));
  eq(s.beforeUnload(), true, "unsaved: warns");
  eq(sent.length, 1, "at exactly 60,000 bytes it is sent:");
  eq(sent[0].keepalive, true, "with fetch keepalive:");
  eq(JSON.parse(sent[0].body).revision, 3, "on the acknowledged revision:");
  eq(titleOf(JSON.parse(sent[0].body).saveDraft.body).length, s.getState().body.sections[0].settings.title.length, "with the newest text:");
  s.setField(T1, padTo(KEEPALIVE_MAX_BYTES + 1));
  eq(s.beforeUnload(), true, "over the limit: still warns");
  eq(sent.length, 1, "and is not sent:");
  // a multi-byte character counts as its UTF-8 bytes
  s.setField(T1, padTo(KEEPALIVE_MAX_BYTES - 1).slice(1) + "é");
  eq(requestBytes(s.getState().body.sections[0].settings.title), KEEPALIVE_MAX_BYTES, "é is two bytes:");
  eq(s.beforeUnload(), true, "warns");
  eq(sent.length, 2, "sent at 60,000 bytes with a two-byte character:");

  // a save in flight is not acknowledged yet
  const api2 = fakeApi(fakeDoc());
  const s2 = St.createDocumentStore({ api: api2, document: fakeDoc(), timers: clock, now: clock.now });
  api2.holdNext("saveDraft");
  s2.setField(T1, "in flight");
  await clock.advance(P);
  eq(s2.beforeUnload(), true, "in flight: warns");
  eq(api2.keepalives.length, 1, "and sends it again with keepalive (the page's own fetch may be cut off):");
  api2.release();
  await settle();
  eq(s2.beforeUnload(), false, "acknowledged: no warning");
});

await t("unit: every unacknowledged body is kept in storage, cleared on ack; on the next open a backup from an older revision is offered and kept as an earlier draft", async () => {
  const clock = fakeClock();
  const storage = memoryStorage();
  const api = fakeApi(fakeDoc());
  const s = St.createDocumentStore({ api, document: fakeDoc(), tenant: "t1", storage, timers: clock, now: clock.now });
  await s.open();
  eq(s.getState().backupOffer, null, "nothing to offer at first:");
  s.setField(T1, "Not saved yet");
  const key = `${St.BACKUP_PREFIX}t1:doc_p1:3`;
  eq([...storage.m.keys()], [key], "the key is tenant, document, base revision:");
  eq(titleOf(JSON.parse(storage.getItem(key)).body), "Not saved yet", "with the body:");
  eq(JSON.parse(storage.getItem(key)).baseRevision, 3, "and its base revision:");
  await clock.advance(P);
  eq(storage.m.size, 0, "cleared on ack:");

  // the tab closes with an edit the keepalive never delivered
  s.setField(T1, "Lost with the tab");
  ok(storage.getItem(key.replace(/3$/, "4")), "kept under the new base revision");
  s.dispose();
  // someone else saves meanwhile: the server is at revision 6
  const later = fakeDoc({ revision: 6, draftHash: "h6", body: pageBody("p1", [textSec("sec_t1", "Someone else")]) });
  const api2 = fakeApi(later);
  const s2 = St.createDocumentStore({ api: api2, document: later, tenant: "t1", storage, timers: clock, now: clock.now });
  await s2.open();
  const offer = s2.getState().backupOffer;
  ok(offer, "offered");
  eq(offer.words, "We found edits that weren't saved. Keep them as an earlier draft?", "words:");
  eq(titleOf(offer.body), "Lost with the tab", "the lost text:");
  eq(offer.baseRevision, 4, "its base:");
  const r = await s2.acceptBackup();
  ok(r.ok, "kept");
  eq(titleOf(api2.server.kept[0]), "Lost with the tab", "as an earlier draft on the server:");
  eq(storage.m.size, 0, "and cleared:");
  eq(s2.getState().backupOffer, null, "no longer offered:");
  eq(titleOf(s2.getState().body), "Someone else", "the draft is untouched:");

  // another tab's backup for another store or document is never offered
  storage.setItem(`${St.BACKUP_PREFIX}t2:doc_p1:1`, JSON.stringify({ v: 1, baseRevision: 1, savedAt: 1, body: pageBody("p1", []) }));
  storage.setItem(`${St.BACKUP_PREFIX}t1:doc_other:1`, JSON.stringify({ v: 1, baseRevision: 1, savedAt: 1, body: pageBody("p1", []) }));
  const s3 = St.createDocumentStore({ api: fakeApi(later), document: later, tenant: "t1", storage, timers: clock, now: clock.now });
  await s3.open();
  eq(s3.getState().backupOffer, null, "other store or document:");
});

await t("unit: an offered backup stays in storage until the founder answers: two reloads without answering still offer it, leaving warns, a failed keep keeps it, and typing at the same revision does not overwrite it", async () => {
  const clock = fakeClock();
  const storage = memoryStorage();
  const api = fakeApi(fakeDoc());
  const s1 = St.createDocumentStore({ api, document: fakeDoc(), tenant: "t1", storage, timers: clock, now: clock.now });
  await s1.open();
  api.holdNext("saveDraft"); // the save never answers: the tab is closed
  s1.setField(T1, "Typed, then the tab closed");
  await clock.advance(P);
  const key = `${St.BACKUP_PREFIX}t1:doc_p1:3`;
  eq([...storage.m.keys()], [key], "the backup is in storage:");
  s1.dispose();
  // the server is still at revision 3 (the keepalive was lost)
  const openTab = async () => {
    const s = St.createDocumentStore({ api: fakeApi(fakeDoc()), document: fakeDoc(), tenant: "t1", storage, timers: fakeClock(), now: clock.now });
    s.subscribe(() => {});
    await s.open();
    return s;
  };
  const s2 = await openTab();
  eq(titleOf(s2.getState().backupOffer?.body), "Typed, then the tab closed", "offered on the next open:");
  eq([...storage.m.keys()], [key], "and still in storage while not answered:");
  ok(s2.beforeUnload(), "leaving warns while the offer is not answered");
  s2.dispose();
  const s3 = await openTab(); // reload without answering
  s3.dispose();
  const s4 = await openTab(); // and again
  eq(titleOf(s4.getState().backupOffer?.body), "Typed, then the tab closed", "offered after two reloads:");
  // offline: the keep fails, and the backup stays
  const api5 = fakeApi(fakeDoc());
  api5.on.keepAsEarlierDraft = () => ({ error: true, code: "NETWORK_ERROR", message: "We couldn't reach Storeasy, so nothing was saved." });
  const s5 = St.createDocumentStore({ api: api5, document: fakeDoc(), tenant: "t1", storage, timers: clock, now: clock.now });
  await s5.open();
  const r5 = await s5.acceptBackup();
  eq(r5.ok, undefined, "the keep failed:");
  ok(s5.getState().backupOffer, "still offered");
  eq(storage.m.size, 1, "still in storage:");
  // typing in this tab, at the offered backup's own revision, keeps both
  api5.holdNext("saveDraft");
  s5.setField(T1, "New typing in this tab");
  await clock.advance(P);
  const bodies = [...storage.m.values()].map((v) => titleOf(JSON.parse(v).body)).sort();
  eq(bodies, ["New typing in this tab", "Typed, then the tab closed"], "both bodies are in storage:");
  api5.release();
  await settle();
  eq([...storage.m.values()].map((v) => titleOf(JSON.parse(v).body)), ["Typed, then the tab closed"], "on ack only this tab's own backup is cleared:");
  delete api5.on.keepAsEarlierDraft;
  const r6 = await s5.acceptBackup();
  ok(r6.ok, "kept once online");
  eq(titleOf(api5.server.kept[0]), "Typed, then the tab closed", "the offered body was kept:");
  eq(storage.m.size, 0, "and cleared on ack:");
  eq(s5.beforeUnload(), false, "nothing left to warn about:");
  s5.dispose();
  const s7 = await openTab();
  eq(s7.getState().backupOffer, null, "not offered again:");
});

await t("unit: 'Use the newer version' keeps text typed while its keep is in flight: the newest body is kept too", async () => {
  const clock = fakeClock();
  const api = fakeApi(fakeDoc());
  api.server.revision = 4; // another tab saved
  api.server.body = pageBody("p1", [textSec("sec_t1", "Theirs")]);
  const s = St.createDocumentStore({ api, document: fakeDoc(), timers: clock, now: clock.now });
  s.setField(T1, "Mine");
  await clock.advance(P);
  eq(s.getState().status, "conflict", "the 409:");
  api.holdNext("keepAsEarlierDraft");
  const p = s.useNewer();
  await settle();
  s.setField(T1, "Mine plus more typed during the choice");
  eq((await s.keepMine()).code, "BUSY", "a second choice while one runs is refused:");
  api.release();
  const r = await p;
  ok(r.ok, "useNewer ok");
  eq(api.server.kept.map((b) => titleOf(b)), ["Mine", "Mine plus more typed during the choice"], "the newest body is kept as well:");
  eq(titleOf(s.getState().body), "Theirs", "then the newer version is shown:");
  eq([s.getState().status, s.getState().notice], ["saved", St.WORDS.backupKept], "and it says the edits were kept:");
});

await t("unit: a throwing storage changes nothing else (the same saves, the same state)", async () => {
  async function script(storage) {
    const clock = fakeClock();
    const api = fakeApi(fakeDoc());
    const s = St.createDocumentStore({ api, document: fakeDoc(), tenant: "t1", storage, timers: clock, now: clock.now });
    await s.open();
    s.setField(T1, "One");
    await clock.advance(P);
    api.holdNext("saveDraft");
    s.setField(T1, "Two");
    await clock.advance(P);
    s.setField(T1, "Three");
    const unload = s.beforeUnload();
    api.release();
    await clock.advance(P * 3);
    const nav = await s.beforeNavigate();
    const st = s.getState();
    return { calls: api.calls, keepalives: api.keepalives, unload, nav, state: { body: st.body, revision: st.revision, draftHash: st.draftHash, status: st.status, offer: st.backupOffer } };
  }
  const none = await script(null);
  const memory = await script(memoryStorage());
  const throwing = await script(throwingStorage());
  eq(throwing, none, "throwing storage = no storage:");
  eq(memory, none, "memory storage = no storage:");
  eq(none.calls.filter((c) => c.op === "saveDraft").length, 3, "three saves:");
});

await t("unit: publish flushes, holds autosave, and publishes with the acknowledged draftHash; PUBLISH_UNKNOWN says check what went live, never a failure", async () => {
  const clock = fakeClock();
  const api = fakeApi(fakeDoc());
  api.on.publish = (args, extra, server) => ({ ok: true, data: { ok: true, release: { id: "rel_1" }, setId: "set_1", published: [{ id: "doc_p1", versionId: "ver_2", hash: server.draftHash, liveUrl: "/api/preview?exit=1&to=%2Fp1", undo: { id: "doc_p1", revision: server.revision, logId: "log_1" } }], skipped: [], issues: [] } });
  const s = St.createDocumentStore({ api, document: fakeDoc(), timers: clock, now: clock.now });
  s.setField(T1, "Ship this");
  api.holdNext("publish");
  const p = s.publish();
  await settle();
  eq(api.calls.map((c) => c.op), ["saveDraft", "publish"], "saved first, then published:");
  eq(api.calls[1].args, { id: "doc_p1", draftHash: "h4" }, "with the acknowledged draftHash:");
  eq(api.calls[1].extra, { revision: 4 }, "and revision:");
  s.setField(T1, "Typed while publishing");
  await clock.advance(P * 3);
  eq(saves(api).length, 1, "autosave waits for the publish:");
  api.release();
  const r = await p;
  ok(r.ok, "published");
  await settle();
  eq(saves(api).length, 2, "then the typing is saved:");
  eq(titleOf(api.server.body), "Typed while publishing", "on the server:");
  eq(s.getState().document.publishedHash, "h4", "the published hash is the one shipped:");

  api.on.publish = () => ({ error: true, code: "PUBLISH_UNKNOWN", message: "Your publish may have gone live. Reload to check.", release: { id: "rel_9" } });
  const u = await s.publish();
  eq([u.checkLive, u.error, u.release], [true, true, { id: "rel_9" }], "check what went live, with the release:");
  ok(s.getState().status !== "error", "the store does not show it as a failed save");

  // publishSet: this document's entry is always the acknowledged one
  api.on.publishSet = () => ({ ok: true, data: { ok: true, release: { id: "rel_2" }, setId: "set_2", published: [], skipped: [], issues: [] } });
  await s.publishSet([{ id: "doc_p1", revision: 1, draftHash: "stale", label: "Page p1" }, { id: "doc_other", revision: 7, draftHash: "h_o", label: "Other" }]);
  const ps = api.calls.at(-1);
  eq(ps.args, [{ id: "doc_p1", revision: 5, draftHash: "h5" }, { id: "doc_other", revision: 7, draftHash: "h_o" }], "publishSet args:");
  eq(ps.extra, undefined, "no top-level revision:");
});

await t("unit: a server-replace operation is not run while an edit can't be saved, so nothing typed is lost", async () => {
  const clock = fakeClock();
  const api = fakeApi(fakeDoc());
  api.on.saveDraft = () => ({ error: true, code: "NETWORK_ERROR", message: "We couldn't reach Storeasy, so nothing was saved." });
  const s = St.createDocumentStore({ api, document: fakeDoc(), timers: clock, now: clock.now });
  s.setField(T1, "Offline text");
  const r = await s.discardDraft();
  eq([r.ok, r.notDone, r.message], [false, true, St.WORDS.notSavedFirst], "refused in plain words:");
  eq(api.calls.filter((c) => c.op === "discardDraft").length, 0, "discardDraft never sent:");
  eq(titleOf(s.getState().body), "Offline text", "the text is still here:");
});

// =====================================================================================
console.log("— Part 2: the store against the real documents API");

const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const { handleDocumentsPut } = await import("../lib/admin/documents-api.js");
const R = await import("../lib/registry/index.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
const raw = createClient({ url: "file:.test-editor-store-docs.db" });
await raw.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
await runMigrations(raw, await loadMigrations("tenant"));
await raw.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
await C.upsertTenant({ id: "zes", name: "Editor store", domains: ["zes.test"], dbUrl: "file:.test-editor-store-docs.db", config: {}, secrets: {} });
const TEN = await C.getTenant("zes");
const ownerU = await I.createUser({ email: "asha@zes.test", name: "Asha Rao", password: "owner-pass-editor-store" });
await I.addMembership(ownerU.id, "zes", "owner");
const OWNER = (await S.createSession({ userId: ownerU.id, kind: "merchant", ttlMs: 600_000 })).token;
const req = (body) => ({
  cookies: { get: (name) => (name === "_admin" ? { value: OWNER } : undefined) },
  headers: { get: (k) => ({ host: "zes.test" })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const direct = async (body) => withTenant(TEN, () => handleDocumentsPut(req(body)));
const sql = async (q, args = []) => (await raw.execute({ sql: q, args })).rows;

// fetch routed to the real handler. log: every request's op, in order. A
// held op is answered by the server at once and delivered when released.
const log = [];
const gate = { op: null, release: null };
async function inProcessFetch(url, init) {
  const json = JSON.parse(init.body);
  const op = Object.keys(json).find((k) => k !== "revision");
  log.push({ op, json });
  const r = await direct(json);
  if (gate.op === op) {
    gate.op = null;
    await new Promise((res) => (gate.release = res));
  }
  return { status: r.status, json: async () => r.body };
}
const realApi = createDocumentsApi({ fetch: inProcessFetch });
const opsSince = (n) => log.slice(n).map((x) => x.op);

const must = (r, label) => {
  if (r.status !== 200) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};
const getDoc = async (id) => must(await direct({ getDocument: id }), "get").document;
async function newPage(slug, sections) {
  let d = must(await direct({ createDocument: { type: "page", meta: { slug, title: `Page ${slug}` } } }), "create").document;
  d = must(await direct({ saveDraft: { id: d.id, body: pageBody(slug, sections) }, revision: d.revision }), "save").document;
  return d;
}
const publishDoc = async (d) => must(await direct({ publish: { id: d.id, draftHash: d.draftHash }, revision: d.revision }), "publish");
const saveDirect = async (d, body) => must(await direct({ saveDraft: { id: d.id, body }, revision: d.revision }), "save").document;
const draftOf = async (id) => JSON.parse((await sql("SELECT draft FROM documents WHERE id = ?", [id]))[0].draft);
const versionsOf = async (id) => (await sql("SELECT kind, note, body FROM document_versions WHERE document_id = ? ORDER BY rowid", [id])).map((v) => ({ kind: v.kind, note: v.note, body: JSON.parse(v.body) }));

// the store opens a closed store: the home page goes live first
{
  const home = must(await direct({ createDocument: { type: "home" } }), "home").document;
  const h = await saveDirect(home, { ...home.body, sections: [{ ...R.newSection("hero", { id: "sec_hero1" }) }] });
  await publishDoc(h);
}

// One test per server-replace operation. Each: a pending edit (inside the
// pause) is flushed before the call; the answer's body replaces the local
// body; an edit typed during the hold is applied on top and saved; no save
// after the operation carries the text from before it.
async function replaceCase({ slug, setup, run, expectTitle }) {
  const clock = fakeClock();
  const d0 = await setup(slug);
  const s = St.createDocumentStore({ api: realApi, document: await getDoc(d0.id), tenant: "zes", timers: clock, now: clock.now });
  const BEFORE = `Typed just before (${slug})`;
  s.setField(T1, BEFORE); // inside the pause: not saved yet
  const n = log.length;
  gate.op = run.op;
  const p = run.call(s, d0);
  await until(() => gate.release, `${run.op} to be held`);
  eq(opsSince(n), ["saveDraft", run.op], "the pending edit is saved first, then the operation:");
  eq(titleOf(log[n].json.saveDraft.body), BEFORE, "the flushed save carries the pending edit:");
  // typed while the server works
  s.setField("sections.sec_t1.settings.body.0", `Typed during the hold (${slug})`);
  await clock.advance(P * 3);
  eq(opsSince(n), ["saveDraft", run.op], "no autosave during the hold:");
  const release = gate.release;
  gate.release = null;
  release();
  const r = await p;
  ok(r.ok, `${run.op} ok: ${JSON.stringify(r).slice(0, 300)}`);
  const st = s.getState();
  const server = await getDoc(d0.id);
  eq(titleOf(st.body), expectTitle, "the answer's body replaced the local text:");
  eq(st.body.sections[0].settings.body[0], `Typed during the hold (${slug})`, "the edit typed during the hold is on top of it:");
  await until(async () => !s.getState().saving && opsSince(n).length >= 3, "the replayed edit to be saved");
  await clock.advance(P * 3);
  const after = log.slice(n + 2).filter((x) => x.op === "saveDraft");
  ok(after.length >= 1, "the replayed edit was saved");
  for (const x of after) ok(titleOf(x.json.saveDraft.body) !== BEFORE, "no later save carries the text from before the operation");
  eq(after[0].json.revision, server.revision, "saved on the operation's revision:");
  const stored = await draftOf(d0.id);
  eq([titleOf(stored), stored.sections[0].settings.body[0]], [expectTitle, `Typed during the hold (${slug})`], "stored draft:");
  eq(s.getState().status, "saved", "saved:");
  eq(s.getState().revision, (await getDoc(d0.id)).revision, "the store is on the stored revision:");
  return { s, d0 };
}

await t("unit: undo flushes, holds, takes the answer's body and revision, replays the edit typed during the hold, and never writes the pre-undo text", async () => {
  let logId = null;
  await replaceCase({
    slug: "undo-case",
    expectTitle: "Live one",
    setup: async (slug) => {
      let d = await newPage(slug, [textSec("sec_t1", "Live one")]);
      await publishDoc(d);
      d = await saveDirect(await getDoc(d.id), pageBody(slug, [textSec("sec_t1", "Live two")]));
      logId = (await publishDoc(d)).published[0].undo.logId;
      return getDoc(d.id);
    },
    run: { op: "undo", call: (s) => s.undo({ logId }) },
  });
  // PUB-04: the newer unpublished edit was kept by the server, not lost
  const id = (await sql("SELECT id FROM documents WHERE slug = 'undo-case'"))[0].id;
  const kept = (await versionsOf(id)).filter((v) => v.kind === "undo_saved");
  eq(kept.map((v) => titleOf(v.body)), ["Typed just before (undo-case)"], "the flushed edit is kept as undo_saved:");
});

await t("unit: keepLiveSection flushes, holds, takes the answer's body and revision, replays the edit typed during the hold, and never writes the pre-operation text", async () => {
  await replaceCase({
    slug: "keep-live-case",
    expectTitle: "Live words",
    setup: async (slug) => {
      const d = await newPage(slug, [textSec("sec_t1", "Live words")]);
      await publishDoc(d);
      return getDoc(d.id);
    },
    run: { op: "keepLiveSection", call: (s) => s.keepLiveSection("sec_t1") },
  });
});

await t("unit: discardDraft ('Go back to the live version') flushes, holds, takes the answer's body and revision, replays the edit typed during the hold, and never writes the pre-operation text", async () => {
  await replaceCase({
    slug: "discard-case",
    expectTitle: "Live discard",
    setup: async (slug) => {
      const d = await newPage(slug, [textSec("sec_t1", "Live discard")]);
      await publishDoc(d);
      return saveDirect(await getDoc(d.id), pageBody(slug, [textSec("sec_t1", "Draft only")]));
    },
    run: { op: "discardDraft", call: (s) => s.discardDraft() },
  });
});

await t("unit: restoreVersion flushes, holds, takes the answer's body and revision, replays the edit typed during the hold, and never writes the pre-operation text", async () => {
  let versionId = null;
  await replaceCase({
    slug: "restore-case",
    expectTitle: "Version to restore",
    setup: async (slug) => {
      const d = await newPage(slug, [textSec("sec_t1", "Version to restore")]);
      const pub = await publishDoc(d);
      versionId = pub.published[0].versionId;
      return saveDirect(await getDoc(d.id), pageBody(slug, [textSec("sec_t1", "Later draft")]));
    },
    run: { op: "restoreVersion", call: (s) => s.restoreVersion(versionId) },
  });
});

// 409: another tab saved. Both bodies end up stored: one as the draft, one
// as an undo_saved "Kept from another tab"; neither only as a checkpoint.
async function conflictCase(slug, choose) {
  const clock = fakeClock();
  const d0 = await newPage(slug, [textSec("sec_t1", "Start")]);
  const s = St.createDocumentStore({ api: realApi, document: await getDoc(d0.id), tenant: "zes", timers: clock, now: clock.now });
  // the other tab
  await saveDirect(await getDoc(d0.id), pageBody(slug, [textSec("sec_t1", "Theirs")]));
  s.setField(T1, "Mine");
  s.setField("meta.slug", `${slug.toUpperCase()} half typed`); // an address the server would refuse
  const n = log.length;
  await clock.advance(P);
  await until(() => s.getState().status === "conflict", "the 409");
  const st = s.getState();
  eq(st.conflict.words, "This page was changed in another tab.", "the same person in another tab:");
  s.setField(T1, "Mine, still typing");
  await clock.advance(P * 5);
  await settle();
  eq(opsSince(n), ["saveDraft"], "autosave stopped after the 409:");
  const r = await s[choose]();
  ok(r.ok, `${choose}: ${JSON.stringify(r).slice(0, 300)}`);
  await until(() => !s.getState().saving, "the save after the choice");
  const versions = await versionsOf(d0.id);
  const draft = await draftOf(d0.id);
  const kept = versions.filter((v) => v.kind === "undo_saved");
  eq(kept.length, 1, "one kept version:");
  eq(kept[0].note, St.KEPT_NOTE, "noted 'Kept from another tab':");
  return { s, draft, kept: kept[0], versions, d0, slug };
}

await t("unit: 409 then 'Use the newer version': the newer body is the draft; mine is an undo_saved 'Kept from another tab' (sent with the last saved address); autosave resumes", async () => {
  const { s, draft, kept, slug } = await conflictCase("conflict-newer", "useNewer");
  eq(titleOf(draft), "Theirs", "the draft is the newer version:");
  eq(titleOf(kept.body), "Mine, still typing", "mine is kept, with what was typed during the conflict:");
  eq(kept.body.meta.slug, slug, "kept with the last saved address, not the half-typed one:");
  eq(titleOf(s.getState().body), "Theirs", "the editor shows the newer version:");
  eq(s.getState().status, "saved", "no conflict left:");
  s.setField(T1, "Edit after choosing");
  await s.flush();
  eq(titleOf(await draftOf(s.getState().id)), "Edit after choosing", "autosave works again:");
});

await t("unit: 409 then 'Keep mine': mine is the draft; the newer body is an undo_saved 'Kept from another tab', not only a prunable checkpoint", async () => {
  const { s, draft, kept, slug } = await conflictCase("conflict-mine", "keepMine");
  eq(titleOf(draft), "Mine, still typing", "the draft is mine:");
  eq(draft.meta.slug, slug, "saved with the last saved address:");
  eq(titleOf(kept.body), "Theirs", "the newer version is kept:");
  eq(s.getState().fieldsNotSaved["meta.slug"], St.WORDS.slugNotSaved, "the address is still marked not saved:");
  eq(s.getState().body.meta.slug, `${slug.toUpperCase()} half typed`, "and still shows as typed:");
});

await t("unit: a 422 keeps the text and the issues and marks the unsaved warning; the next good edit saves", async () => {
  const clock = fakeClock();
  const d0 = await newPage("pending-case", [textSec("sec_t1", "Start")]);
  const s = St.createDocumentStore({ api: realApi, document: await getDoc(d0.id), tenant: "zes", timers: clock, now: clock.now });
  s.setField(T1, "Good text");
  s.setField("meta.bogus", 1); // a structure problem: 422 even in draft mode
  await clock.advance(P);
  await until(() => !s.getState().saving, "the 422");
  const st = s.getState();
  eq(st.status, "error", "status:");
  eq(st.pending.code, "VALIDATION_FAILED", "code:");
  eq(st.pending.issues.map((i) => [i.field, i.code]), [["meta.bogus", "UNKNOWN_FIELD"]], "the issues:");
  eq(st.unsavedWarning, true, "unsaved warning:");
  ok(st.statusWords.startsWith("Could not save: "), `words: ${st.statusWords}`);
  eq([titleOf(st.body), st.body.meta.bogus], ["Good text", 1], "the text is kept:");
  eq(titleOf(await draftOf(d0.id)), "Start", "nothing stored:");
  ok(s.beforeUnload(), "leaving warns");
  s.setField("meta.bogus", undefined);
  await clock.advance(P);
  await until(() => !s.getState().saving, "the save");
  eq([s.getState().status, s.getState().pending, s.getState().unsavedWarning], ["saved", null, false], "saved:");
  eq(titleOf(await draftOf(d0.id)), "Good text", "stored:");
});

await t("unit: a locally invalid web address saves the other edits with the last saved address and marks the field 'not saved yet'; a valid one then saves; an address another page holds does the same", async () => {
  const clock = fakeClock();
  const d0 = await newPage("slug-case", [textSec("sec_t1", "Start")]);
  const s = St.createDocumentStore({ api: realApi, document: await getDoc(d0.id), tenant: "zes", timers: clock, now: clock.now });
  s.setField("meta.slug", "Slug Case!");
  s.setField(T1, "Saved anyway");
  const n = log.length;
  await clock.advance(P);
  await until(() => !s.getState().saving, "the save");
  eq(log[n].json.saveDraft.body.meta.slug, "slug-case", "sent with the last saved address:");
  let st = s.getState();
  eq(st.status, "saved", "the save worked:");
  eq(st.fieldsNotSaved, { "meta.slug": St.WORDS.slugNotSaved }, "the address is marked not saved yet:");
  eq(st.body.meta.slug, "Slug Case!", "and shows as typed:");
  eq(st.unsavedWarning, true, "warning:");
  eq(st.unacknowledged, true, "not acknowledged:");
  ok(s.beforeUnload(), "leaving warns");
  eq([titleOf(await draftOf(d0.id)), (await draftOf(d0.id)).meta.slug], ["Saved anyway", "slug-case"], "stored:");
  s.setField("meta.slug", "slug-case-2");
  await clock.advance(P);
  await until(() => !s.getState().saving, "the save");
  st = s.getState();
  eq([st.fieldsNotSaved, st.unacknowledged, (await draftOf(d0.id)).meta.slug], [{}, false, "slug-case-2"], "a valid address saves:");

  // another page holds the address (SLUG_TAKEN, 409)
  await newPage("held-elsewhere", [textSec("sec_t1", "Other")]);
  s.setField("meta.slug", "held-elsewhere");
  s.setField(T1, "Still saving");
  await clock.advance(P);
  await until(async () => !s.getState().saving && titleOf(await draftOf(d0.id)) === "Still saving", "the second save");
  st = s.getState();
  ok(/^Not saved yet: Another page already uses \/held-elsewhere/.test(st.fieldsNotSaved["meta.slug"] || ""), `taken words: ${JSON.stringify(st.fieldsNotSaved)}`);
  eq((await draftOf(d0.id)).meta.slug, "slug-case-2", "stored with the last saved address:");
  eq(st.status, "saved", "the rest saved:");
});

await t("unit: publish through the real API ships the acknowledged draft, and its Undo replaces the local body", async () => {
  const clock = fakeClock();
  const d0 = await newPage("publish-case", [textSec("sec_t1", "First live")]);
  await publishDoc(d0);
  const s = St.createDocumentStore({ api: realApi, document: await getDoc(d0.id), tenant: "zes", timers: clock, now: clock.now });
  s.setField(T1, "Second live");
  const r = await s.publish();
  ok(r.ok, `publish: ${JSON.stringify(r).slice(0, 300)}`);
  const live = JSON.parse((await sql("SELECT body FROM document_versions WHERE id = (SELECT published_version_id FROM documents WHERE id = ?)", [d0.id]))[0].body);
  eq(titleOf(live), "Second live", "what went live is what was typed:");
  const u = await s.undo({ logId: r.data.published[0].undo.logId });
  ok(u.ok, `undo: ${JSON.stringify(u).slice(0, 300)}`);
  eq(titleOf(s.getState().body), "First live", "Undo's body is the editor's:");
  eq(s.getState().revision, (await getDoc(d0.id)).revision, "and its revision:");
});

// =====================================================================================
console.log("— Part 3: previewMachine");

const L = PM.PREVIEW_LABELS;
await t("unit: the three PV-01 labels are the spec's words", async () => {
  eq([L.upToDate, L.updating, L.couldNotUpdate], ["Up to date", "Updating", "Could not update"], "labels:");
  eq(PM.READY_TIMEOUT_MS, 3000, "3 seconds:");
});

function machineAt(documentId = "doc_home") {
  const m = PM.createPreviewMachine({ documentId });
  return m;
}
const shown = (docId = "doc_home", hash = "h1") => {
  const m = machineAt(docId);
  m.send({ type: "saveAck", draftHash: hash });
  m.send({ type: "mintOk" });
  m.send({ type: "frameLoad" });
  m.send({ type: "ready", ok: true, state: { docs: { [docId]: hash } } });
  eq(m.current.label, L.upToDate, "setup:");
  return m;
};
const acts = (a) => ({ label: a.label, remint: a.remint, reload: a.reload, armReadyTimer: a.armReadyTimer });

await t("unit: previewMachine: mint ok, frame load, ready ok → Updating then Up to date; mint failed → Could not update with words", async () => {
  const m = machineAt();
  eq(m.current.label, L.updating, "at start:");
  eq(acts(m.send({ type: "mintOk" })), { label: L.updating, remint: false, reload: true, armReadyTimer: false }, "mint ok loads the frame:");
  eq(acts(m.send({ type: "frameLoad" })), { label: L.updating, remint: false, reload: false, armReadyTimer: true }, "frame load arms the 3 s timer:");
  eq(acts(m.send({ type: "ready", ok: true, state: { docs: {} } })), { label: L.upToDate, remint: false, reload: false, armReadyTimer: false }, "ready ok:");
  const f = machineAt().send({ type: "mintFailed", message: "We couldn't open the preview, so it shows nothing new yet." });
  eq(acts(f), { label: L.couldNotUpdate, remint: false, reload: false, armReadyTimer: false }, "mint failed:");
  eq(f.words, "We couldn't open the preview, so it shows nothing new yet.", "with its words:");
  eq(machineAt().send({ type: "mintFailed" }).words, PM.PREVIEW_WORDS.mintFailed, "default words:");
  const again = PM.previewStep(f.state, { type: "retry" });
  eq(acts(again), { label: L.updating, remint: true, reload: false, armReadyTimer: false }, "Try again re-mints:");
});

await t("unit: previewMachine: a save ack while Up to date says Updating and reloads; refresh sent says Updating; an ack during the load reloads again before Up to date", async () => {
  const m = shown();
  const a = m.send({ type: "saveAck", draftHash: "h2" });
  eq(acts(a), { label: L.updating, remint: false, reload: true, armReadyTimer: false }, "save ack:");
  eq(m.send({ type: "refreshSent" }).label, L.updating, "refresh sent:");
  m.send({ type: "frameLoad" });
  m.send({ type: "saveAck", draftHash: "h3" }); // typed again while it loads
  const r = m.send({ type: "ready", ok: true, state: { docs: { doc_home: "h2" } } });
  eq(acts(r), { label: L.updating, remint: false, reload: true, armReadyTimer: false }, "never Up to date with the older content:");
  m.send({ type: "frameLoad" });
  eq(m.send({ type: "ready", ok: true, state: { docs: { doc_home: "h3" } } }).label, L.upToDate, "then Up to date:");
  // the same when the frame's ready doesn't list this document's hash
  const m1 = shown();
  m1.send({ type: "saveAck", draftHash: "h2" });
  m1.send({ type: "frameLoad" });
  m1.send({ type: "saveAck", draftHash: "h3" });
  eq(acts(m1.send({ type: "ready", ok: true, state: { docs: {} } })), { label: L.updating, remint: false, reload: true, armReadyTimer: false }, "an ack during the load reloads, hash or not:");
  // refresh sent from Up to date
  const m2 = shown();
  eq(acts(m2.send({ type: "refreshSent" })), { label: L.updating, remint: false, reload: false, armReadyTimer: false }, "refresh sent from Up to date:");
});

await t("unit: previewMachine: a ready naming an older draft reloads, then says Could not update; it never says Up to date over older content", async () => {
  const m = shown();
  m.send({ type: "saveAck", draftHash: "h2" });
  m.send({ type: "frameLoad" });
  const r1 = m.send({ type: "ready", ok: true, state: { docs: { doc_home: "h1" } } });
  eq(acts(r1), { label: L.updating, remint: false, reload: true, armReadyTimer: false }, "older draft: reload:");
  m.send({ type: "frameLoad" });
  const r2 = m.send({ type: "ready", ok: true, state: { docs: { doc_home: "h1" } } });
  eq([r2.label, r2.words], [L.couldNotUpdate, PM.PREVIEW_WORDS.stale], "still older: Could not update:");
  // a frame that doesn't list this document (no draft in the overlay) is not judged
  const m3 = shown();
  m3.send({ type: "saveAck", draftHash: "h2" });
  m3.send({ type: "frameLoad" });
  eq(m3.send({ type: "ready", ok: true, state: { docs: {} } }).label, L.upToDate, "not listed:");
});

await t("unit: previewMachine: ready ok:false re-mints for reason live and for each ended reason (revoked, expired, not_found), saying Updating (Reconnecting); legacy says Could not update", async () => {
  for (const reason of ["live", "revoked", "expired", "not_found"]) {
    const m = shown();
    m.send({ type: "saveAck", draftHash: "h2" });
    m.send({ type: "frameLoad" });
    const a = m.send({ type: "ready", ok: false, reason });
    eq(acts(a), { label: L.updating, remint: true, reload: false, armReadyTimer: false }, `${reason}:`);
    eq(a.words, PM.PREVIEW_WORDS.reconnecting, `${reason} words:`);
    // the re-mint works: Up to date again
    m.send({ type: "mintOk" });
    m.send({ type: "frameLoad" });
    eq(m.send({ type: "ready", ok: true, state: { docs: { doc_home: "h2" } } }).label, L.upToDate, `${reason}, after the re-mint:`);
  }
  const lg = shown().send({ type: "ready", ok: false, reason: "legacy" });
  eq([lg.label, lg.remint, lg.words], [L.couldNotUpdate, false, PM.PREVIEW_WORDS.legacy], "legacy:");
});

await t("unit: previewMachine: no ready within 3 seconds of a frame load re-mints; a ready in time does not; repeated failures end in Could not update", async () => {
  const m = shown();
  m.send({ type: "saveAck", draftHash: "h2" });
  m.send({ type: "frameLoad" });
  const a = m.send({ type: "readyTimeout" });
  eq(acts(a), { label: L.updating, remint: true, reload: false, armReadyTimer: false }, "no ready in 3 s:");
  // a late ready from the old frame while re-minting changes nothing
  eq(m.send({ type: "ready", ok: true, state: { docs: { doc_home: "h1" } } }).label, L.updating, "late ready ignored:");
  m.send({ type: "mintOk" });
  m.send({ type: "frameLoad" });
  eq(m.send({ type: "readyTimeout" }).remint, true, "a second time: re-mint again:");
  m.send({ type: "mintOk" });
  m.send({ type: "frameLoad" });
  const last = m.send({ type: "readyTimeout" });
  eq([last.label, last.remint, last.words], [L.couldNotUpdate, false, PM.PREVIEW_WORDS.timeout], "then Could not update:");
  // the same for a session that keeps ending
  const e = shown();
  for (let i = 0; i < PM.MAX_REMINTS; i++) {
    eq(e.send({ type: "ready", ok: false, reason: "expired" }).remint, true, `re-mint ${i + 1}:`);
    e.send({ type: "mintOk" });
  }
  const end = e.send({ type: "ready", ok: false, reason: "expired" });
  eq([end.label, end.remint, end.words], [L.couldNotUpdate, false, PM.PREVIEW_WORDS.ended], "ended for good:");
  // a timer from a load that already answered does nothing
  const fine = shown();
  eq(acts(fine.send({ type: "readyTimeout" })), { label: L.upToDate, remint: false, reload: false, armReadyTimer: false }, "answered in time:");
});

await t("unit: previewMachine: a failed save or a 422 says Could not update with the reason and the field; the next save ack reloads; an incomplete section is a note", async () => {
  const m = shown();
  const f = m.send({ type: "saveFailed", message: "We couldn't reach Storeasy, so nothing was saved." });
  eq([f.label, f.words, f.reload, f.remint], [L.couldNotUpdate, "We couldn't reach Storeasy, so nothing was saved.", false, false], "network:");
  eq(m.send({ type: "refreshSent" }).label, L.couldNotUpdate, "a refresh doesn't hide it:");
  eq(m.send({ type: "ready", ok: true, state: { docs: { doc_home: "h1" } } }).label, L.couldNotUpdate, "nor a ready:");
  const back = m.send({ type: "saveAck", draftHash: "h2" });
  eq(acts(back), { label: L.updating, remint: false, reload: true, armReadyTimer: false }, "the next ack reloads:");
  const issue = { field: "links.0", sectionId: "sec_promo", anchor: "f-sec_promo-links-0", message: "This link goes nowhere.", severity: "error" };
  const p = shown().send({ type: "savePending", message: "There's 1 thing to fix", issues: [issue] });
  eq([p.label, p.words, p.field], [L.couldNotUpdate, "There's 1 thing to fix", "f-sec_promo-links-0"], "422 (bad link) with the field:");
  const server = shown().send({ type: "saveFailed", message: "Something went wrong on our side, so nothing was saved." });
  eq(server.label, L.couldNotUpdate, "server error:");
  const inc = shown();
  inc.send({ type: "saveAck", draftHash: "h2", issues: [{ field: "image", sectionId: "sec_iwt", anchor: "f-sec_iwt-image", severity: "incomplete", message: "Add an image." }] });
  inc.send({ type: "frameLoad" });
  const done = inc.send({ type: "ready", ok: true, state: { docs: { doc_home: "h2" } } });
  eq([done.label, done.note], [L.upToDate, { words: PM.PREVIEW_WORDS.incomplete, field: "f-sec_iwt-image" }], "incomplete section:");
});

await t("unit: previewMachine imports nothing and the store has no React or DOM", async () => {
  const pm = await readFile(join(ROOT, "components/admin/editor/previewMachine.js"), "utf8");
  ok(!/^\s*import\s/m.test(pm), "previewMachine has no imports");
  const st = await readFile(join(ROOT, "components/admin/editor/store.js"), "utf8");
  ok(!/from\s+["'](react|react-dom|next\/)/.test(st), "no React or Next in the store");
  ok(!/(?<![.\w])(window|document|localStorage|sessionStorage|navigator)\s*[.[]/.test(st.replace(/\/\/.*$/gm, "")), "no DOM globals in the store");
  ok(!/from\s+["']node:/.test(st + pm), "no node: imports");
});

raw.close();
await cleanup();
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${pass} passed, ${fail} failed (${secs}s)`);
process.exit(fail ? 1 : 0);
