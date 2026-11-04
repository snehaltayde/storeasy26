// P3-FRAME drill: /quiz/<slug> and /bundles/<slug> on the harness, full HTML
// and RSC: 1 (a router-state header claiming the layout is loaded, as
// P3-CLOSED's probe), with and without console cookies. Counts the FRAMEDRILL
// strings setup.mjs seeded (quiz title, intro, question, option; bundle title
// and description) in each answer.
// node quiz-probe.mjs <port> <label> <out.json>
import { writeFileSync } from "node:fs";
const [, , PORT, LABEL, OUT] = process.argv;
const BASE = `http://localhost:${PORT}`;
const words = ["FRAMEDRILL quiz title", "FRAMEDRILL quiz intro words", "FRAMEDRILL question one", "FRAMEDRILL option oily", "FRAMEDRILL bundle title", "FRAMEDRILL bundle description words"];
const tree = (seg) => encodeURIComponent(JSON.stringify(["", { children: ["(storefront)", { children: [seg, { children: ["__PAGE__", {}] }] }] }]));
const results = [];
for (const path of ["/quiz/skin", "/bundles/night"]) {
  for (const cookies of [{}, { _admin: "x" }, { _platform: "x", _mx: "x" }]) {
    for (const kind of ["html", "rsc"]) {
      const headers = { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") };
      if (kind === "rsc") Object.assign(headers, { RSC: "1", "Next-Router-State-Tree": tree("collections"), "Next-Url": "/collections" });
      const res = await fetch(BASE + path, { headers, redirect: "manual" });
      const text = await res.text();
      results.push({ path, kind, cookies: Object.keys(cookies).join(",") || "none", status: res.status, type: (res.headers.get("content-type") || "").split(";")[0], openingSoon: text.includes("Opening soon"), leaks: words.filter((w) => text.includes(w)) });
    }
  }
}
writeFileSync(OUT, JSON.stringify({ label: LABEL, results }, null, 2));
const bad = results.filter((r) => r.leaks.length);
console.log(`${LABEL}: requests ${results.length}, with founder copy ${bad.length}`);
for (const r of results) console.log(`  ${r.kind} ${r.path} [${r.cookies}] ${r.status} ${r.type} opening=${r.openingSoon} copy=${r.leaks.length}`);
