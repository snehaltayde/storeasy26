import { createRequire } from "node:module";
const require = createRequire(process.argv[2] + "/package.json");
const { createClient } = require("@libsql/client");
const c = createClient({ url: "http://127.0.0.1:4641" });
const REL = "rel_84d7d33384eb3e33";
await c.execute("UPDATE cms_state SET mode = 'legacy' WHERE id = 1");
await c.execute({ sql: "UPDATE release_state SET live_release_id = ? WHERE id = 1", args: [REL] });
const strings = new Set();
const walk = (v) => { if (typeof v === "string") { if (v.trim().length >= 10 && !/^(https?:|\/|gid:|#|rel_|ver_|sec_)/.test(v)) strings.add(v.trim()); } else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
for (const r of (await c.execute({ sql: "SELECT content FROM releases WHERE id = ?", args: [REL] })).rows) walk(JSON.parse(String(r.content)));
const T = encodeURIComponent(JSON.stringify(["", { children: ["(storefront)", { children: ["collections", { children: ["__PAGE__", {}] }] }] }]));
for (const p of ["/", "/policies/shipping", "/contact"]) {
  const t = await (await fetch("http://localhost:3640" + p, { headers: { RSC: "1", "Next-Router-State-Tree": T, "Next-Url": "/collections" } })).text();
  const hits = [...strings].filter((s) => t.includes(s));
  console.log("open store (control)", p, "content strings found:", hits.length, JSON.stringify(hits.slice(0, 2)).slice(0, 160));
}
await c.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
await c.execute("UPDATE release_state SET live_release_id = NULL WHERE id = 1");
console.log("closed again");
