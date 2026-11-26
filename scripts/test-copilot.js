// AI copilot (Phase 9 line 5, docs/plans/phase-9.md "Line 5").
//   pnpm test:copilot
// The provider (stub refuses in production; the Anthropic body: max_tokens,
// json_schema output, fallbacks; OpenAI and Gemini need AI_MODEL), the prompt
// guard, the routes as every caller (support reads with no run controls), zero
// PII (every outgoing body scanned for seeded customers, orders, search terms
// and an email in a description), drafts only (publish_log and live rows
// unchanged, offers off), the claims scan, malformed answers, the daily budget
// (20 runs at once at the edge, failures free their reservation, the store's
// day rolls over at its midnight on a pinned clock), the kill switch (global
// and per store), the audit row, and the SEO columns of the live row. No real
// provider is ever called: fetch() is blocked and AI_PROVIDER=stub.
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-copilot-default.db";
process.env.PLATFORM_SECRET = "test-copilot-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.AI_PROVIDER = "stub";
H.blockNetwork();

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack || e).split("\n").slice(0, 6).join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();

const P = await import("../lib/ai/provider.js");
const G = await import("../lib/ai/prompt-guard.js");
const B = await import("../lib/ai/budget.js");
const C = await import("../lib/ai/copilot.js");
const INS = await import("../lib/ai/insights.js");
const CAT = await import("../lib/plugins/catalog.js");
const FLAGS = await import("../lib/platform/flags.js");
const { listAudit } = await import("../lib/platform/audit.js");
const { liveRowFor } = await import("../lib/documents/live-rows.js");
const { documentType } = await import("../lib/registry/index.js");
const { libsql } = await import("../lib/db.js");

// ---- seeded shopper data that must never leave ------------------------------------------
const CANARY = { email: "canary.buyer@example.org", phone: "9876501234", name: "Zubeida Canarywala", address: "42 Canary Lane", term: "zebracanaryterm", order: "AAA-1A2B3C4D5E6F7A8B" };
const PRODUCTS = [
  { title: "Oat Crunch", description: "Crisp oat clusters. Questions? Mail help@oat.example or call +91 98765 43210, or DM @oatcrunch." },
  { title: "Cocoa Bites", description: "Dark cocoa bites with sea salt." },
  { title: "Mango Bar", description: "Real mango, pressed into a bar." },
];

const store = await H.makeRoleStore({ name: "copilot", a: { products: PRODUCTS, collections: [{ productIds: ["gid://shopify/Product/9101", "gid://shopify/Product/9102", "gid://shopify/Product/9103"] }] } });
const { a, b, call } = store;
const ids = await a.run(async () => (await libsql.execute("SELECT id FROM products ORDER BY id")).rows.map((r) => String(r.id)));

await a.run(async () => {
  const at = new Date().toISOString();
  await libsql.execute({ sql: "INSERT INTO customers (id, email, name, phone, default_address, created_at) VALUES (?, ?, ?, ?, ?, ?)", args: ["cus_canary", CANARY.email, CANARY.name, CANARY.phone, JSON.stringify({ line1: CANARY.address }), at] });
  await libsql.execute({
    sql: "INSERT INTO orders (id, email, phone, name, address_line1, city, pincode, subtotal, total, status, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'Pune', '411001', 100, 100, 'paid', ?, ?, ?)",
    args: [CANARY.order, CANARY.email, CANARY.phone, CANARY.name, CANARY.address, JSON.stringify({ items: [{ title: "Oat Crunch", quantity: 1 }] }), at, at],
  });
  await libsql.execute({ sql: "INSERT INTO events (event_id, name, url, payload, created_at) VALUES ('ev_canary', 'search', ?, ?, ?)", args: [`/search?q=${CANARY.term}`, JSON.stringify({ search_term: CANARY.term }), at] });
});

// ---- a scripted stub: answers per task, counts calls --------------------------------------
const answers = {
  starter: () => ({ hero: { title: "Snacks made simply", subtitle: "Oats, cocoa and mango, packed with care." }, featured_title: "Our snacks", text: { title: "About us", paragraphs: ["We make three snacks and make them well."] }, faq: { title: "Questions", items: [{ q: "How fast do you ship?", a: "We pack orders within two working days." }] } }),
  product_seo: (user) => {
    const { products } = JSON.parse(user);
    return { products: products.map((p) => ({ ref: p.ref, seo_title: `${p.title} | Snacks`, seo_description: `Buy ${p.title} online.`, faqs: [{ q: `What is in ${p.title}?`, a: "Only what the label says." }] })) };
  },
  offer_ideas: () => ({
    offers: [
      { kind: "COUPON", title: "Welcome ten", code: "WELCOME10", percent: 10, min_qty: null, buy: null, target: null, reason: "A gentle first-order nudge." },
      { kind: "COUPON", title: "Too generous", code: "HALF", percent: 35, min_qty: null, buy: null, target: null, reason: "Too much." },
      { kind: "BXGY", title: "Buy two get one", code: null, percent: null, min_qty: null, buy: 2, target: "p1", reason: "33% is over the cap." },
    ],
  }),
};
let override = null;
P.__setStubResponder(async (req) => {
  if (override) return override(req);
  return { text: JSON.stringify(answers[req.task](req.user)), tokensIn: 300, tokensOut: 200 };
});

const counts = async () =>
  a.run(async () => {
    const one = async (sql) => Number((await libsql.execute(sql)).rows[0].n);
    return { publish: await one("SELECT count(*) AS n FROM publish_log"), live: await one("SELECT count(*) AS n FROM product_content_live"), liveHash: (await libsql.execute("SELECT group_concat(document_id || version_id) AS h FROM product_content_live")).rows[0].h ?? null };
  });

// ---- provider ------------------------------------------------------------------------------
await t("provider: anthropic is the default with claude-sonnet-5-5; no key → not set up in words; openai and gemini need AI_MODEL; an unknown provider is refused", () => {
  const saved = { ...process.env };
  try {
    delete process.env.AI_PROVIDER;
    process.env.ANTHROPIC_API_KEY = "";
    let p = P.aiProvider();
    eq([p.provider, p.model, p.configured], ["anthropic", "claude-sonnet-5-5", false], "no key:");
    ok(/ANTHROPIC_API_KEY/.test(p.reason), "names the key");
    process.env.ANTHROPIC_API_KEY = "sk-test";
    eq(P.aiProvider().configured, true, "with a key:");
    process.env.AI_MODEL = "claude-opus-5-5";
    eq(P.aiProvider().model, "claude-opus-5-5", "AI_MODEL overrides:");
    delete process.env.AI_MODEL;
    for (const [prov, key] of [["openai", "OPENAI_API_KEY"], ["gemini", "GEMINI_API_KEY"]]) {
      process.env.AI_PROVIDER = prov;
      process.env[key] = "k";
      p = P.aiProvider();
      ok(!p.configured && /AI_MODEL/.test(p.reason), `${prov} without AI_MODEL is not set up`);
      process.env.AI_MODEL = "some-model";
      ok(P.aiProvider().configured, `${prov} with AI_MODEL`);
      delete process.env.AI_MODEL;
    }
    process.env.AI_PROVIDER = "madeup";
    ok(!P.aiProvider().configured, "unknown provider");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

await t("provider: the stub refuses in production (NODE_ENV or VERCEL_ENV), before any responder runs", async () => {
  for (const [k, v] of [["NODE_ENV", "production"], ["VERCEL_ENV", "production"]]) {
    const was = process.env[k];
    process.env[k] = v;
    try {
      eq(P.aiProvider().configured, false, `${k}:`);
      let code = null;
      try {
        await P.complete({ system: "s", user: "u", maxTokens: 10, task: "starter" });
      } catch (e) {
        code = e.code;
      }
      eq(code, "AI_UNCONFIGURED", `${k} refused:`);
    } finally {
      if (was === undefined) delete process.env[k];
      else process.env[k] = was;
    }
  }
});

await t("provider: the Anthropic request — max_tokens is the whole output (thinking included), json_schema output, server-side fallback on the default model; refusal and unreachable in words", async () => {
  const saved = { ...process.env };
  const sent = [];
  try {
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    P.__setFetch(async (url, init) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"ok":true}' }], stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 34 } }), { status: 200 });
    });
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
    const r = await P.complete({ system: "sys", user: "usr", maxTokens: 777, schema, task: "starter" });
    eq([r.text, r.tokensIn, r.tokensOut, r.provider, r.model], ['{"ok":true}', 12, 34, "anthropic", "claude-sonnet-5-5"], "answer:");
    const s = sent[0];
    eq(s.url, "https://api.anthropic.com/v1/messages", "url:");
    eq([s.body.model, s.body.max_tokens, s.body.system, s.body.messages], ["claude-sonnet-5-5", 777, "sys", [{ role: "user", content: "usr" }]], "body:");
    eq(s.body.output_config, { effort: "medium", format: { type: "json_schema", schema } }, "output_config:");
    eq([s.body.fallbacks, s.headers["anthropic-beta"]], ["default", "server-side-fallback-2026-07-01"], "fallbacks:");
    ok(!("thinking" in s.body) && !JSON.stringify(s.body).includes("budget_tokens"), "no thinking budget is sent (adaptive by default)");
    // without a schema: exactly the request insights always made
    await P.complete({ system: "sys", user: "usr", maxTokens: 2000, model: "claude-haiku-5-5" });
    eq(Object.keys(sent[1].body), ["model", "max_tokens", "system", "messages"], "plain body keys:");
    ok(!sent[1].headers["anthropic-beta"], "no beta header without a schema");
    P.__setFetch(async () => new Response(JSON.stringify({ content: [], stop_reason: "refusal", usage: {} }), { status: 200 }));
    let code = null;
    try {
      await P.complete({ system: "s", user: "u", maxTokens: 5, schema });
    } catch (e) {
      code = e.code;
    }
    eq(code, "AI_REFUSED", "refusal:");
    P.__setFetch(async () => {
      throw new TypeError("fetch failed");
    });
    try {
      await P.complete({ system: "s", user: "u", maxTokens: 5 });
    } catch (e) {
      code = [e.code, e.message];
    }
    eq(code, ["AI_UNAVAILABLE", P.AI_UNAVAILABLE_MESSAGE], "unreachable:");
  } finally {
    P.__setFetch(null);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

await t("insights on the provider: same model default (claude-haiku-5-5, AI_INSIGHTS_MODEL checked), not configured on the stub", () => {
  eq(INS.AI_MODEL(), "claude-haiku-5-5", "default:");
  process.env.AI_INSIGHTS_MODEL = "bad id with spaces";
  eq(INS.AI_MODEL(), "claude-haiku-5-5", "an unreadable id falls back:");
  process.env.AI_INSIGHTS_MODEL = "claude-haiku-4-5";
  eq(INS.AI_MODEL(), "claude-haiku-4-5", "override:");
  delete process.env.AI_INSIGHTS_MODEL;
  eq(INS.aiConfigured(), false, "the stub leaves insights not set up:");
});

// ---- prompt guard ----------------------------------------------------------------------------
await t("prompt guard: scrubText removes email, Indian and E.164 phones and handles; assertOutgoingClean refuses each shape, an order id and a forbidden value", () => {
  const s = G.scrubText(PRODUCTS[0].description);
  ok(!/@/.test(s) && !/98765/.test(s), `scrubbed: ${s}`);
  for (const bad of ["write to a@b.co", "call 9876543210", "call +44 20 7946 0958", "follow @brandname", "order PAV-1A2B3C4D", `hi ${CANARY.name}`]) {
    let refused = false;
    try {
      G.assertOutgoingClean(bad, { forbidden: [CANARY.name] });
    } catch (e) {
      refused = e.code === "AI_PROMPT_REFUSED";
    }
    ok(refused, `refused: ${bad}`);
  }
  ok(G.assertOutgoingClean('{"price":1299,"title":"Oat Crunch 500 g","ref":"p1"}'), "catalog data passes");
});

// ---- roles -------------------------------------------------------------------------------------
await t("routes: 401 signed out and for store B's owner; every store A role reads the page; support and operator support get no run control and 403 on every task", async () => {
  for (const caller of ["signed-out", "owner-b"]) {
    eq((await call(caller, "copilot", "GET")).status, 401, `${caller} GET:`);
    eq((await call(caller, "copilot", "POST", { body: { task: "starter" } })).status, 401, `${caller} POST:`);
  }
  for (const caller of ["owner", "admin", "staff", "support", "operator-support"]) {
    const r = await call(caller, "copilot", "GET");
    eq(r.status, 200, `${caller} GET:`);
    const writer = ["owner", "admin", "staff"].includes(caller);
    eq(r.body.can, { starter: writer, product_seo: writer, offer_ideas: writer }, `${caller} can:`);
  }
  for (const caller of ["support", "operator-support"]) for (const task of ["starter", "product_seo", "offer_ideas"]) eq((await call(caller, "copilot", "POST", { body: { task, productIds: [ids[0]] } })).status, 403, `${caller} ${task}:`);
  const g = await call("owner", "copilot", "GET");
  ok(!g.text.includes(CANARY.email) && !g.text.includes(CANARY.name), "no customer data in the page's data");
});

await t("not installed: a run is refused 409 in words, nothing reserved; installing it from Apps makes it runnable", async () => {
  const r = await call("owner", "copilot", "POST", { body: { task: "starter" } });
  eq([r.status, r.body.code], [409, "NOT_INSTALLED"], "refused:");
  eq(P.stubCalls().length, 0, "the provider was not called:");
  const inst = await call("owner", "apps", "POST", { body: { install: { pluginId: "ai-copilot", scopes: [] } } });
  eq(inst.status, 200, "installed:");
  eq((await call("owner", "copilot", "GET")).body.state.installed, true, "state:");
});

// ---- tasks, drafts only -------------------------------------------------------------------------
await t("product SEO and FAQs on 2 products: product_content drafts with seo_title, seo_description and a FAQ; publish_log and live rows unchanged", async () => {
  const before = await counts();
  const r = await call("owner", "copilot", "POST", { body: { task: "product_seo", productIds: ids.slice(0, 2) } });
  eq(r.status, 200, `run: ${r.text}`);
  eq(r.body.refs.map((x) => x.kind), ["product", "product"], "refs:");
  ok(r.body.refs.every((x) => x.href.startsWith("/admin/editor?product=")), "editor links");
  await a.run(async () => {
    const docs = (await libsql.execute({ sql: "SELECT entity_id, draft FROM documents WHERE type = 'product_content' AND entity_id IN (?, ?)", args: ids.slice(0, 2) })).rows;
    eq(docs.length, 2, "two documents:");
    for (const d of docs) {
      const body = JSON.parse(String(d.draft));
      ok(body.settings.seo_title?.endsWith("| Snacks") && body.settings.seo_title.length <= 70, `seo_title: ${body.settings.seo_title}`);
      ok(body.settings.seo_description && body.settings.seo_description.length <= 160, "seo_description");
      const faq = body.sections.find((s) => s.kind === "faq");
      ok(faq && faq.settings.items.length === 1 && faq.settings.items[0].a.startsWith("<p>"), "a FAQ module");
    }
  });
  eq(await counts(), before, "nothing published:");
});

await t("starter store: a home draft (hero, featured products, text, FAQ) when home has no unpublished edits; with edits it is kept in Earlier versions only", async () => {
  const before = await counts();
  eq(await a.run(async () => (await libsql.execute("SELECT count(*) AS n FROM documents WHERE id = 'doc_home'")).rows[0].n), 0, "this store has no home page yet:");
  const r0 = await call("owner", "copilot", "POST", { body: { task: "starter" } });
  eq([r0.status, r0.body.refs[0]?.applied], [200, true], `no home: the starter is its first draft (${r0.text})`);
  // a home whose draft is what is live (no unpublished edits): the starter becomes the draft
  await a.run(() => libsql.execute("UPDATE documents SET published_hash = draft_hash WHERE id = 'doc_home'"));
  const homeBefore = await a.run(async () => (await libsql.execute("SELECT draft_hash, published_hash, revision FROM documents WHERE id = 'doc_home'")).rows[0]);
  const r = await call("owner", "copilot", "POST", { body: { task: "starter" } });
  eq(r.status, 200, `run: ${r.text}`);
  const ref = r.body.refs[0];
  eq([ref.kind, ref.id, ref.href, ref.applied], ["document", "doc_home", "/admin/editor?doc=doc_home", true], "ref:");
  eq(Number((await a.run(async () => (await libsql.execute("SELECT revision FROM documents WHERE id = 'doc_home'")).rows[0])).revision), Number(homeBefore.revision) + 1, "the draft was saved:");
  await a.run(async () => {
    const v = (await libsql.execute({ sql: "SELECT kind, note, body FROM document_versions WHERE id = ?", args: [ref.versionId] })).rows[0];
    eq([v.kind, v.note], ["undo_saved", "Draft from the AI copilot"], "kept version:");
    eq(JSON.parse(String(v.body)).sections.map((s) => s.kind), ["hero", "product_rail", "text", "faq"], "sections:");
  });
  // the founder has unpublished edits: a run never replaces the draft
  const draftBefore = await a.run(async () => (await libsql.execute("SELECT draft_hash, revision FROM documents WHERE id = 'doc_home'")).rows[0]);
  await a.run(() => libsql.execute("UPDATE documents SET published_hash = 'x-not-the-draft' WHERE id = 'doc_home'"));
  const r2 = await call("owner", "copilot", "POST", { body: { task: "starter" } });
  eq([r2.status, r2.body.refs[0].applied], [200, false], "second run kept as a version:");
  ok(/Earlier versions/.test(r2.body.message), "says where it is");
  const draftAfter = await a.run(async () => (await libsql.execute("SELECT draft_hash, revision FROM documents WHERE id = 'doc_home'")).rows[0]);
  eq([draftAfter.draft_hash, Number(draftAfter.revision)], [draftBefore.draft_hash, Number(draftBefore.revision)], "the draft is untouched:");
  await a.run(() => libsql.execute("UPDATE documents SET published_hash = NULL WHERE id = 'doc_home'"));
  eq(await counts(), before, "nothing published:");
});

await t("offer ideas: created with enabled = 0 and config.source copilot; 35% off and a BXGY over 30% are dropped and named; staff may run it", async () => {
  const r = await call("staff", "copilot", "POST", { body: { task: "offer_ideas" } });
  eq(r.status, 200, `run: ${r.text}`);
  eq(r.body.refs.length, 1, "one offer:");
  ok(r.body.removed.some((w) => /more than 30% off/.test(w)), `named: ${r.body.removed}`);
  await a.run(async () => {
    const rows = (await libsql.execute("SELECT id, enabled, config FROM offers WHERE id LIKE 'copilot-%'")).rows;
    ok(rows.length >= 1, "offers stored");
    for (const o of rows) eq([Number(o.enabled), JSON.parse(String(o.config)).source], [0, "copilot"], `${o.id}:`);
  });
});

await t("claims: an answer saying '#1 brand' or 'clinically proven' is dropped and named; nothing else made → no draft and honest words", async () => {
  override = () => ({ text: JSON.stringify({ hero: { title: "The #1 brand of snacks", subtitle: "Clinically proven crunch." }, featured_title: "", text: { title: "", paragraphs: [] }, faq: { title: "", items: [] } }), tokensIn: 50, tokensOut: 50 });
  try {
    const versions = await a.run(async () => Number((await libsql.execute("SELECT count(*) AS n FROM document_versions WHERE document_id = 'doc_home'")).rows[0].n));
    const r = await call("owner", "copilot", "POST", { body: { task: "starter" } });
    eq([r.status, r.body.refs.length], [200, 0], "no draft:");
    ok(/^Nothing was made/.test(r.body.message) && /Removed one suggestion: it claimed '/.test(r.body.message), r.body.message);
    eq(await a.run(async () => Number((await libsql.execute("SELECT count(*) AS n FROM document_versions WHERE document_id = 'doc_home'")).rows[0].n)), versions, "no version kept:");
  } finally {
    override = null;
  }
});

await t("malformed JSON: no draft, honest words, and the tokens spent are still counted (settled)", async () => {
  override = () => ({ text: "sorry, here you go: {not json", tokensIn: 40, tokensOut: 60 });
  try {
    const r = await call("owner", "copilot", "POST", { body: { task: "offer_ideas" } });
    eq([r.status, r.body.refs.length, r.body.tokens], [200, 0, 100], "no draft:");
    ok(/couldn't be read/.test(r.body.message), r.body.message);
    const last = await a.run(async () => (await libsql.execute("SELECT status, tokens_in, tokens_out FROM ai_usage_ledger ORDER BY created_at DESC, rowid DESC LIMIT 1")).rows[0]);
    eq([last.status, Number(last.tokens_in), Number(last.tokens_out)], ["settled", 40, 60], "ledger:");
  } finally {
    override = null;
  }
});

await t("zero PII: every body the provider was sent holds no email, phone, handle or order id shape and none of the seeded customer, order or search values", () => {
  const bodies = P.stubCalls();
  ok(bodies.length >= 4, `calls: ${bodies.length}`);
  eq(new Set(bodies.map((b) => b.task)).size, 3, "every task was run:");
  for (const b of bodies) {
    const text = `${b.system}\n${b.user}`;
    eq(G.findPii(text, { forbidden: Object.values(CANARY) }), [], `${b.task}:`);
    for (const v of [...Object.values(CANARY), "help@oat.example", "98765 43210", "@oatcrunch", "gid://shopify"]) ok(!text.includes(v), `${b.task} holds ${v}`);
  }
});

await t("a prompt that would carry PII is refused before the provider and before any reservation (ai_prompt_refused)", async () => {
  const n = P.stubCalls().length;
  const rows = async () => a.run(async () => Number((await libsql.execute("SELECT count(*) AS n FROM ai_usage_ledger")).rows[0].n));
  const before = await rows();
  await a.run(() => libsql.execute({ sql: "UPDATE products SET title = ? WHERE id = ?", args: ["Order AAA-1A2B3C4D5E6F7A8B bar", ids[2]] }));
  try {
    const r = await call("owner", "copilot", "POST", { body: { task: "product_seo", productIds: [ids[2]] } });
    eq([r.status, r.body.code], [422, "AI_PROMPT_REFUSED"], "refused:");
    eq([P.stubCalls().length, await rows()], [n, before], "nothing sent, nothing reserved:");
  } finally {
    await a.run(() => libsql.execute({ sql: "UPDATE products SET title = 'Mango Bar' WHERE id = ?", args: [ids[2]] }));
  }
});

// ---- the budget ------------------------------------------------------------------------------------
const NOW = new Date("2026-11-26T12:00:00.000Z"); // 17:30 IST

await t("budget: 20 reservations at once at the edge never pass it; exactly as many fit as the budget holds", async () => {
  await a.run(async () => {
    a.tenant.config.ai_daily_tokens = 5500;
    try {
      const day = new Date("2026-11-20T06:00:00.000Z");
      const results = await Promise.allSettled(Array.from({ length: 20 }, () => B.reserve({ task: "starter", provider: "stub", model: "stub", tokens: 1000, now: day })));
      eq(results.filter((r) => r.status === "fulfilled").length, 5, "fitted:");
      ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "AI_BUDGET"), "refused as AI_BUDGET");
      const u = await B.usageToday(day);
      eq([u.spent, u.budget], [5000, 5500], "spent:");
    } finally {
      delete a.tenant.config.ai_daily_tokens;
    }
  });
});

await t("budget: 20 copilot runs at once at the edge never overspend; failures free their reservation", async () => {
  await a.run(async () => {
    const day = new Date("2026-11-21T06:00:00.000Z");
    // measure one run's reservation, then allow exactly three
    const probe = await C.runTask({ task: "offer_ideas", actor: { kind: "merchant", id: store.users.owner.id }, now: new Date("2026-11-19T06:00:00.000Z") });
    ok(probe.tokens === 500, "probe ran");
    const reserved = Number((await libsql.execute("SELECT tokens_reserved FROM ai_usage_ledger WHERE day = '2026-11-19'")).rows[0].tokens_reserved);
    a.tenant.config.ai_daily_tokens = reserved * 3 + 10;
    try {
      let calls = 0;
      override = async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { text: JSON.stringify(answers.offer_ideas()), tokensIn: 300, tokensOut: 200 };
      };
      const runs = await Promise.allSettled(Array.from({ length: 20 }, () => C.runTask({ task: "offer_ideas", actor: { kind: "merchant", id: store.users.owner.id }, now: day })));
      const okRuns = runs.filter((r) => r.status === "fulfilled").length;
      eq(okRuns, 3, "exactly the three that fit ran:");
      ok(runs.filter((r) => r.status === "rejected").every((r) => r.reason.code === "AI_BUDGET"), "the rest refused on budget");
      const u = await B.usageToday(day);
      ok(u.spent <= u.budget, `never over: ${u.spent} of ${u.budget}`);
      eq(calls, okRuns, "the provider was called only for runs that reserved:");
      // a provider failure frees its reservation
      override = async () => {
        throw new P.AiError("AI_UNAVAILABLE", P.AI_UNAVAILABLE_MESSAGE);
      };
      const before = (await B.usageToday(day)).spent;
      const failDay = new Date("2026-11-22T06:00:00.000Z");
      let code = null;
      try {
        await C.runTask({ task: "offer_ideas", actor: { kind: "merchant", id: store.users.owner.id }, now: failDay });
      } catch (e) {
        code = e.code;
      }
      eq(code, "AI_UNAVAILABLE", "failed:");
      eq((await B.usageToday(failDay)).spent, 0, "freed:");
      eq((await B.usageToday(day)).spent, before, "other days untouched:");
      eq(String((await libsql.execute("SELECT status FROM ai_usage_ledger WHERE day = '2026-11-22'")).rows[0].status), "failed", "the row says failed:");
    } finally {
      override = null;
      delete a.tenant.config.ai_daily_tokens;
    }
  });
});

await t("budget: the store's day rolls over at its own midnight (IST on a pinned clock); default 100,000; the page's words", async () => {
  await a.run(async () => {
    eq(B.dailyBudget(), 100000, "default:");
    const before = new Date("2026-12-30T18:29:59.000Z"); // 23:59:59 IST on the 30th
    const after = new Date("2026-12-30T18:30:00.000Z"); // 00:00 IST on the 31st
    eq([B.storeDay(before), B.storeDay(after)], ["2026-12-30", "2026-12-31"], "days:");
    a.tenant.config.ai_daily_tokens = 1000;
    try {
      await B.reserve({ task: "starter", provider: "stub", model: "stub", tokens: 1000, now: before });
      let code = null;
      try {
        await B.reserve({ task: "starter", provider: "stub", model: "stub", tokens: 1, now: before });
      } catch (e) {
        code = e.code;
      }
      eq(code, "AI_BUDGET", "full at 23:59:59:");
      const r = await B.reserve({ task: "starter", provider: "stub", model: "stub", tokens: 1000, now: after });
      eq(r.day, "2026-12-31", "a new day at midnight:");
    } finally {
      delete a.tenant.config.ai_daily_tokens;
    }
    const { budgetWords } = await import("../components/admin/copilot/BudgetMeter.js").catch(() => ({ budgetWords: null }));
    if (budgetWords) eq(budgetWords({ spent: 38200, budget: 100000 }), "38,200 of 1,00,000 tokens used today; resets at midnight", "words:");
  });
});

// ---- kill switch ------------------------------------------------------------------------------------
await t("kill switch ff_plugin-ai-copilot: off globally → 403 in words; off for this store only → 403 here, B unaffected; nothing sent", async () => {
  const key = CAT.killFlag("ai-copilot");
  eq(key, "ff_plugin-ai-copilot", "flag:");
  const n = P.stubCalls().length;
  await FLAGS.setFlag({ key, description: "AI copilot", default_on: false, create: true, actor: "operator" });
  FLAGS.__resetFlagCache();
  let r = await call("owner", "copilot", "POST", { body: { task: "starter" } });
  eq([r.status, r.body.code], [403, "TURNED_OFF_BY_STOREASY"], "global:");
  ok(/Storeasy has turned the AI copilot off/.test(r.body.error), "words");
  await FLAGS.setFlag({ key, description: "AI copilot", default_on: true, actor: "operator" });
  await FLAGS.setFlagOverride({ key, tenant: a.id, on: false, actor: "operator" });
  FLAGS.__resetFlagCache();
  r = await call("owner", "copilot", "POST", { body: { task: "offer_ideas" } });
  eq([r.status, r.body.code], [403, "TURNED_OFF_BY_STOREASY"], "per store:");
  eq((await call("owner", "copilot", "GET")).body.state.killed, true, "the page knows:");
  await b.run(async () => eq(await (await import("../lib/plugins/installs.js")).isKilled("ai-copilot"), false, "store B:"));
  eq(P.stubCalls().length, n, "nothing sent:");
  await FLAGS.setFlagOverride({ key, tenant: a.id, on: true, actor: "operator" });
  FLAGS.__resetFlagCache();
});

// ---- audit, history, live row ------------------------------------------------------------------------
await t("audit: copilot.run rows carry the task and tokens, never the copy; history lists runs with who and links", async () => {
  const rows = (await listAudit({ tenantId: a.id, action: "copilot.run", limit: 50 })).rows ?? (await listAudit({ tenantId: a.id, action: "copilot.run", limit: 50 }));
  const list = Array.isArray(rows) ? rows : rows.items || [];
  ok(list.length >= 3, `rows: ${list.length}`);
  for (const row of list) {
    const diff = typeof row.diff === "string" ? row.diff : JSON.stringify(row.diff);
    ok(/"task"/.test(diff) && /"tokens"/.test(diff) && !/Snacks/.test(diff), `diff: ${diff}`);
  }
  const g = await call("owner", "copilot", "GET");
  ok(g.body.history.length >= 3 && g.body.history.length <= 30, "history");
  ok(g.body.history.some((h) => h.refs.some((x) => x.kind === "offer")), "links to drafts");
  ok(g.body.history.every((h) => !("actor" in h) && typeof h.by === "string"), "who, by name, no raw id");
});

await t("product content: seo_title (70) and seo_description (160) are registry settings; the live row takes them (empty → null)", () => {
  const set = documentType("product_content").settings;
  eq(set.filter((s) => s.key.startsWith("seo_")).map((s) => [s.key, s.kind, s.max, s.default]), [["seo_title", "text", 70, null], ["seo_description", "text", 160, null]], "settings:");
  const row = liveRowFor("product_content", { schema: 1, type: "product_content", meta: {}, settings: { seo_title: " Oat Crunch | Snacks ", seo_description: "" }, sections: [] }, { documentId: "d", versionId: "v", publishedAt: "t" });
  eq([row.seo_title, row.seo_description], ["Oat Crunch | Snacks", null], "live row:");
});

P.__setStubResponder(null);
await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
