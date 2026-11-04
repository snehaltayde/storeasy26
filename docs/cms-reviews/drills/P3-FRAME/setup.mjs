// P3-FRAME drill setup, against a RUNNING design harness only (its local sqld).
// node setup.mjs <worktree> <scratch-dir> <sqld-first-port> <action>
//   action "publish": the harness tenant moves to documents mode (its seeded
//     v3 pointer set aside, so it is a never-published store), publishes a
//     home page (hero, text, FAQ, banner), header, footer, announcement and an
//     about page through the real service, then saves drafts (a new hero
//     title, the about page) and mints a preview session. The token goes to
//     <scratch-dir>/token.txt (never printed).
//   action "session": a new preview session (token to <scratch-dir>/token.txt).
//   action "revoke": revokes that session.
//   action "close": the quiz and bundle rows, then the store closed (pointer NULL).
//   action "quiz": the quiz and bundle rows only (store stays as it is).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [, , WT, SCRATCH, FIRST, ACTION] = process.argv;
const port = Number(FIRST);
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = `http://127.0.0.1:${port + 2}`;
process.env.PLATFORM_DB_URL = `http://127.0.0.1:${port}`;
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "design-preview-secret";
const C = await import(join(WT, "lib/platform/control.js"));
const { withTenant } = await import(join(WT, "lib/tenant-context.js"));
const { libsql } = await import(join(WT, "lib/db.js"));
const Reg = await import(join(WT, "lib/registry/index.js"));
const Svc = await import(join(WT, "lib/documents/service.js"));
const Pub = await import(join(WT, "lib/documents/publish.js"));
const PS = await import(join(WT, "lib/preview-sessions.js"));
const T = await C.getTenant("design");
const sec = (kind, id, settings = {}) => {
  const s = Reg.newSection(kind, { id });
  return { ...s, settings: { ...s.settings, ...settings } };
};
const withBody = (type, patch) => {
  const b = Reg.emptyBody(type);
  return { ...b, ...patch, meta: { ...b.meta, ...(patch.meta || {}) }, ...(patch.settings ? { settings: { ...(b.settings || {}), ...patch.settings } } : {}) };
};
async function upsert(type, body, id = null) {
  if (id) {
    try {
      const cur = await Svc.getDocument(id);
      return (await Svc.saveDraft({ id: cur.id, revision: cur.revision, body })).document;
    } catch (e) {
      if (e?.status !== 404 && !/no longer exists/.test(e?.message || "")) throw e;
    }
  }
  return (await Svc.createDocument({ type, body })).document;
}
const HERO = { title: "Glow from within", highlight: "Glow", subtitle: "Clean skincare, made in small batches.", primary: { label: "Shop serums", link: { type: "url", href: "/collections" } }, secondary: { label: "Read our story", link: { type: "url", href: "/about" } }, badge: "" };
const home = (title) => [
  sec("hero", "sec_hero", { ...HERO, title }),
  sec("text", "sec_text", { title: "How we make it", body: ["We start small.", "We test every batch.", "We ship from Pune."] }),
  sec("faq", "sec_faq", { title: "Questions", items: [{ q: "Is it vegan?", a: "<p>Yes, all of it.</p>" }, { q: "How long does delivery take?", a: "<p>Two to four days.</p>" }] }),
  sec("banner", "sec_bn", { title: "Free shipping this week", text: "On every order.", button: { label: "Shop now", link: { type: "url", href: "/collections" } } }),
];
async function quizAndBundle() {
  const now = new Date().toISOString();
  await libsql.execute({ sql: "INSERT OR REPLACE INTO quizzes (slug, title, intro, questions, enabled, updated_at) VALUES ('skin', 'FRAMEDRILL quiz title', 'FRAMEDRILL quiz intro words', ?, 1, ?)", args: [JSON.stringify([{ id: "q1", prompt: "FRAMEDRILL question one", options: [{ id: "o1", label: "FRAMEDRILL option oily", tags: ["oily"] }, { id: "o2", label: "Dry", tags: ["dry"] }] }]), now] });
  const v = (await libsql.execute("SELECT id FROM variants ORDER BY id LIMIT 2")).rows.map((r) => String(r.id));
  await libsql.execute({ sql: "INSERT OR REPLACE INTO bundles (id, slug, title, description, items, bundle_price, enabled, created_at, updated_at) VALUES ('bun-drill', 'night', 'FRAMEDRILL bundle title', 'FRAMEDRILL bundle description words', ?, 1500, 1, ?, ?)", args: [JSON.stringify(v.map((variantId) => ({ variantId, quantity: 1 }))), now, now] });
}
await withTenant(T, async () => {
  if (ACTION === "publish") {
    // a documents store that has never published (the harness seed's v3 release is set aside)
    await libsql.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
    await libsql.execute("UPDATE release_state SET live_release_id = NULL WHERE id = 1");
    const docs = [
      await upsert("home", withBody("home", { sections: home(HERO.title) }), "doc_home"),
      await upsert("header", withBody("header", { settings: { mode: "custom", items: [{ label: "Serums", link: { type: "url", href: "/collections" } }, { label: "About", link: { type: "url", href: "/about" } }] } }), "doc_header"),
      await upsert("footer", withBody("footer", { settings: { mode: "custom", items: [{ label: "About", link: { type: "url", href: "/about" } }] } }), "doc_footer"),
      await upsert("announcement", withBody("announcement", { settings: { enabled: true, text: "Free delivery over 999", link: { type: "url", href: "/collections" } } }), "doc_announcement"),
      await upsert("page", withBody("page", { meta: { slug: "about", title: "Our story" }, sections: [sec("text", "sec_ab", { title: "Who we are", body: ["Two friends.", "One kitchen.", "Small batches."] })] }), (await libsql.execute("SELECT id FROM documents WHERE slug = 'about' AND archived_at IS NULL")).rows[0]?.id ?? null),
    ];
    const r = await Pub.publish({ ids: docs.map((d) => ({ id: d.id, revision: d.revision, draftHash: d.draftHash })) });
    if (!r.release?.id) throw new Error(`publish: ${JSON.stringify(r).slice(0, 400)}`);
    await upsert("home", withBody("home", { sections: home("Draft glow title") }), "doc_home");
    const s = await PS.createPreviewSession({ actor: { kind: "merchant", id: "drill" } });
    writeFileSync(join(SCRATCH, "token.txt"), s.token);
    writeFileSync(join(SCRATCH, "sid.txt"), s.sid);
    console.log(`published ${r.release.id}; drafts saved; session ${s.sid}`);
  } else if (ACTION === "session") {
    const s = await PS.createPreviewSession({ actor: { kind: "merchant", id: "drill" } });
    writeFileSync(join(SCRATCH, "token.txt"), s.token);
    writeFileSync(join(SCRATCH, "sid.txt"), s.sid);
    console.log(`session ${s.sid}`);
  } else if (ACTION === "revoke") {
    const sid = readFileSync(join(SCRATCH, "sid.txt"), "utf8").trim();
    console.log(`revoked: ${await PS.revokePreviewSession({ sid })}`);
  } else if (ACTION === "quiz") {
    await quizAndBundle();
    console.log("quiz and bundle seeded");
  } else if (ACTION === "close") {
    await quizAndBundle();
    await libsql.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
    await libsql.execute("UPDATE release_state SET live_release_id = NULL WHERE id = 1");
    console.log("closed");
  } else throw new Error(`unknown action ${ACTION}`);
});
process.exit(0);
