// P3-CLOSED drill: the harness tenant made closed (documents mode, no live
// release, drafts in both systems), then anonymous requests with RSC: 1 and a
// router-state header claiming the layout is loaded. Prints JSON results.
// node rsc-probe.mjs <worktree> <out.json>
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const [, , WT, OUT] = process.argv;
const require = createRequire(WT + "/package.json");
const { createClient } = require("@libsql/client");
const db = createClient({ url: "http://127.0.0.1:4641" });
const BASE = "http://localhost:3640";
const rows = async (sql, args = []) => (await db.execute({ sql, args })).rows;

// 1. every string the store's content holds (legacy drafts, the live release)
const strings = new Set();
const walk = (v) => {
  if (typeof v === "string") { if (v.trim().length >= 10 && !/^(https?:|\/|gid:|#|rel_|ver_|sec_)/.test(v)) strings.add(v.trim()); }
  else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === "object") Object.values(v).forEach(walk);
};
for (const r of await rows("SELECT value FROM cms_blocks")) walk(JSON.parse(String(r.value)));
for (const r of await rows("SELECT * FROM cms_pages")) walk(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^[\[{]/.test(v) ? JSON.parse(v) : v])));
for (const r of await rows("SELECT content FROM releases")) walk(JSON.parse(String(r.content)));
// catalog words are Shopify's, not content (owner interpretation): leave them out
const catalog = (await rows("SELECT title FROM products UNION SELECT title FROM collections")).map((r) => String(r.title));
for (const s of [...strings]) if (catalog.some((c) => s.includes(c) || c.includes(s))) strings.delete(s);

// 2. drafts in the documents system too
const now = new Date().toISOString();
const put = (id, type, slug, body) => db.execute({ sql: "INSERT OR REPLACE INTO documents (id, type, slug, label, draft, draft_hash, revision, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)", args: [id, type, slug, id, JSON.stringify(body), "dh_" + id, now, now] });
const sec = (kind, id, settings) => ({ id, kind, v: 1, enabled: true, settings, blocks: [] });
await put("doc_home", "home", null, { schema: 1, type: "home", meta: {}, sections: [sec("hero", "sec_h", { title: "DOCDRAFT HOME HERO" })] });
await put("doc_header", "header", null, { schema: 1, type: "header", meta: {}, settings: { mode: "custom", template: "standard", items: [{ label: "DOCDRAFT HEADER", link: { type: "url", href: "/about" } }] } });
await put("doc_pga", "page", "about", { schema: 1, type: "page", meta: { slug: "about", title: "DOCDRAFT ABOUT" }, sections: [sec("text", "sec_t", { title: "DOCDRAFT ABOUT", body: ["DOCDRAFT ABOUT words"] })] });
await put("doc_pgc", "page", "contact", { schema: 1, type: "page", meta: { slug: "contact", title: "DOCDRAFT CONTACT" }, sections: [sec("text", "sec_c", { title: "DOCDRAFT CONTACT", body: ["x"] })] });
await put("doc_pgs", "page", "shipping", { schema: 1, type: "page", meta: { slug: "shipping", title: "DOCDRAFT SHIPPING" }, sections: [] });
await put("doc_cps", "campaign", "spring", { schema: 1, type: "campaign", meta: { slug: "spring", title: "DOCDRAFT CAMPAIGN" }, sections: [] });
await put("doc_jp", "journal", "first-post", { schema: 1, type: "journal", meta: { slug: "first-post", title: "DOCDRAFT POST" }, sections: [] });
for (const w of ["DOCDRAFT HOME HERO", "DOCDRAFT HEADER", "DOCDRAFT ABOUT", "DOCDRAFT CONTACT", "DOCDRAFT SHIPPING", "DOCDRAFT CAMPAIGN", "DOCDRAFT POST"]) strings.add(w);

// 3. close the store
const live = (await rows("SELECT live_release_id FROM release_state WHERE id = 1"))[0]?.live_release_id ?? null;
await db.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
await db.execute("UPDATE release_state SET live_release_id = NULL WHERE id = 1");

// 4. the probe
const tree = (seg) => encodeURIComponent(JSON.stringify(["", { children: ["(storefront)", { children: [seg, { children: ["__PAGE__", {}] }] }] }]));
const routes = ["/", "/contact", "/about", "/policies/shipping", "/campaigns/spring", "/journal", "/journal/first-post", "/collections"];
const cookieSets = [{}, { _admin: "x" }, { _platform: "x" }, { _mx: "x" }];
const results = [];
for (const path of routes) {
  for (const cookies of cookieSets) {
    for (const kind of ["html", "rsc"]) {
      const headers = { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") };
      if (kind === "rsc") Object.assign(headers, { RSC: "1", "Next-Router-State-Tree": tree("collections"), "Next-Url": "/collections" });
      const res = await fetch(BASE + path, { headers, redirect: "manual" });
      const text = await res.text();
      const leaks = [...strings].filter((s) => text.includes(s));
      results.push({ path, kind, cookies: Object.keys(cookies).join(",") || "none", status: res.status, type: res.headers.get("content-type"), bytes: text.length, openingSoon: text.includes("Opening soon"), leaks });
    }
  }
}
writeFileSync(OUT, JSON.stringify({ previousLiveRelease: live, contentStrings: strings.size, catalogExcluded: catalog.length, results }, null, 2));
const bad = results.filter((r) => r.leaks.length);
console.log(`requests ${results.length}, with leaks ${bad.length}, content strings checked ${strings.size}`);
for (const r of results) console.log(`${r.kind} ${r.path} [${r.cookies}] ${r.status} ${r.type?.split(";")[0]} opening=${r.openingSoon} leaks=${r.leaks.length ? JSON.stringify(r.leaks).slice(0, 200) : 0}`);
