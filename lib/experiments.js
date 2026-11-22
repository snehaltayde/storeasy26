// Experimentation (Session 47 / BE22). SERVER-ONLY, tenant-scoped.
//
// The honesty rules of this service, enforced in code, not copy:
//   · the analysis plan (hypothesis, metric, min sample, allocation, salt)
//     FREEZES at start — a running experiment refuses edits;
//   · assignment is a pure hash (salt|slug|unit): stable, reproducible,
//     server-evaluated — the client is never trusted with a variant;
//   · NO WINNER CLAIMS while running (no peeking), on insufficient samples,
//     or under sample-ratio mismatch (chi-square, α=0.001) — analysis then
//     says WHY interpretation is blocked instead of showing a number;
//   · adoption routes through the normal CMS draft → release publish path:
//     lib/content-writes.js (P2-WRITERS), which validates, checks the
//     revision, audits and keeps history on a legacy store, and saves a
//     doc_home draft on a documents store. The variant is MERGED over the
//     current hero, so the founder's buttons, badge and image stay;
//   · PV-08: a preview is the founder looking at their own content, never a
//     visitor — no variant is applied, nothing is counted, and a note says a
//     test runs on that section (heroVariantFor, isPreviewRequest). A browser
//     signed in to the console is the founder too, so a lapsed preview isn't
//     counted either (signedInToConsole, isFounderRequest).
import { db } from "./db.js";
import { slog } from "./log.js";
import { legacyHeroToSettings } from "./registry/legacy.js";
import { PREVIEW_COOKIE } from "./preview-sessions.js";

const rid = () => "exp-" + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, "0")).join("");
const nowIso = () => new Date().toISOString();
const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

export const TARGET_KINDS = ["hero"]; // allowlisted serving targets

// PV-08: the storefront section (its data-sec id) each target changes, so a
// preview and the Designer can say which section a running test is on. A new
// target needs its own entry here AND its own preview gate where it is served.
export const TEST_SECTION = { hero: "hero" };

// ---- pure: assignment + statistics -------------------------------------------

// FNV-1a 32-bit — NOT cryptographic, deliberately: bucketing needs a fast,
// dependency-free, deterministic spread, and the salt is not a secret.
export function hashUnit(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 10000;
}

// Stable variant for a unit: bucket 0–9999 walked over cumulative weights.
export function assignVariant(experiment, unitId) {
  const variants = Array.isArray(experiment.variants) ? experiment.variants : parse(experiment.variants, []);
  const bucket = hashUnit(`${experiment.salt || ""}|${experiment.slug}|${unitId}`);
  const totalWeight = variants.reduce((s, v) => s + Number(v.weight), 0);
  let acc = 0;
  for (const v of variants) {
    acc += (Number(v.weight) / totalWeight) * 10000;
    if (bucket < acc) return v.key;
  }
  return variants[variants.length - 1]?.key || "control";
}

// Sample-ratio mismatch: chi-square of observed exposures vs planned
// allocation. α = 0.001 — SRM should fire on real instrumentation bugs,
// not ordinary noise. Critical values for df 1..5.
const CHI2_CRIT = { 1: 10.828, 2: 13.816, 3: 16.266, 4: 18.467, 5: 20.515 };
export function srmCheck(observed, weights) {
  const n = observed.reduce((s, x) => s + x, 0);
  const wSum = weights.reduce((s, x) => s + x, 0);
  if (!n || observed.length < 2) return { ok: true, chi2: 0, n };
  let chi2 = 0;
  for (let i = 0; i < observed.length; i++) {
    const expected = (weights[i] / wSum) * n;
    if (expected > 0) chi2 += (observed[i] - expected) ** 2 / expected;
  }
  const crit = CHI2_CRIT[Math.min(observed.length - 1, 5)];
  return { ok: chi2 < crit, chi2: Math.round(chi2 * 100) / 100, n };
}

// Two-proportion z-test between the two best variants: a "winner" exists
// only when the difference is significant at α=0.05 — otherwise the honest
// answer is "no significant difference".
export function compareTopTwo(cells) {
  const sorted = [...cells].sort((a, b) => b.rate - a.rate);
  const [a, b] = sorted;
  if (!a || !b || !a.exposed || !b.exposed) return { winner: null, significant: false, z: 0 };
  const p = (a.conversions + b.conversions) / (a.exposed + b.exposed);
  const se = Math.sqrt(p * (1 - p) * (1 / a.exposed + 1 / b.exposed));
  const z = se > 0 ? (a.rate - b.rate) / se : 0;
  const significant = Math.abs(z) >= 1.96;
  return { winner: significant ? a.key : null, significant, z: Math.round(z * 100) / 100 };
}

// ---- validation + CRUD --------------------------------------------------------

// Variant payloads are allowlisted per target kind. Hero fields only — the
// CMS sanitizer runs again at adoption, but nothing here renders raw HTML.
function cleanVariantPayload(kind, payload) {
  if (payload == null) return null;
  if (kind === "hero") {
    const s = (v, n) => String(v ?? "").slice(0, n);
    const out = { title: s(payload.title, 160), highlight: s(payload.highlight, 80), subtitle: s(payload.subtitle, 400) };
    for (const btn of ["primary", "secondary"]) {
      const b = payload[btn];
      if (b?.label && b?.href && /^\/(?!\/)/.test(String(b.href))) out[btn] = { label: s(b.label, 60), href: s(b.href, 200) };
    }
    return out;
  }
  return null;
}

export function validateExperiment({ slug, name, hypothesis = "", target_kind = "hero", variants, min_sample = 200 }) {
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug || "")) errors.push("slug must be lowercase letters/digits/hyphens");
  if (!name?.trim()) errors.push("name required");
  if (!TARGET_KINDS.includes(target_kind)) errors.push(`target must be one of: ${TARGET_KINDS.join(", ")}`);
  const vs = Array.isArray(variants) ? variants : [];
  if (vs.length < 2 || vs.length > 6) errors.push("2–6 variants");
  const keys = new Set();
  const clean = vs.map((v, i) => {
    const key = String(v?.key || "").trim().toLowerCase();
    if (!/^[a-z0-9-]{1,20}$/.test(key)) errors.push(`variant ${i + 1}: key must be a short slug`);
    if (keys.has(key)) errors.push(`variant key "${key}" repeats`);
    keys.add(key);
    const weight = Number(v?.weight);
    if (!Number.isFinite(weight) || weight <= 0) errors.push(`variant ${key || i + 1}: weight must be positive`);
    return { key, weight, payload: cleanVariantPayload(target_kind, v?.payload) };
  });
  if (clean[0] && clean[0].key !== "control") errors.push('the first variant must be "control" (serves the live content unchanged)');
  if (clean[0]?.payload) errors.push("control carries no payload — it IS the live content");
  for (const v of clean.slice(1)) if (!v.payload) errors.push(`variant ${v.key}: needs a payload (what it changes)`);
  const ms = Number(min_sample);
  if (!Number.isInteger(ms) || ms < 50) errors.push("min sample per variant: an integer ≥ 50");
  return {
    ok: !errors.length,
    errors,
    value: { slug, name: name?.trim().slice(0, 120), hypothesis: String(hypothesis || "").slice(0, 1000), target_kind, variants: clean, min_sample: ms },
  };
}

export async function upsertExperiment(input) {
  const v = validateExperiment(input);
  if (!v.ok) {
    const err = new Error(v.errors.join(" · "));
    err.errors = v.errors;
    throw err;
  }
  const existing = await db.selectFrom("experiments").selectAll().where("slug", "=", v.value.slug).executeTakeFirst();
  if (existing && existing.status !== "draft") throw new Error(`"${v.value.slug}" is ${existing.status} — the plan froze at start and can't be edited`);
  const row = {
    id: existing?.id || rid(),
    slug: v.value.slug,
    name: v.value.name,
    hypothesis: v.value.hypothesis,
    target_kind: v.value.target_kind,
    variants: JSON.stringify(v.value.variants),
    primary_metric: "conversion",
    min_sample: v.value.min_sample,
    status: "draft",
    salt: existing?.salt || null,
    started_at: existing?.started_at || null,
    ended_at: null,
    adopted_variant: null,
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
  };
  await db
    .insertInto("experiments")
    .values(row)
    .onConflict((oc) => oc.column("id").doUpdateSet(row))
    .execute();
  return { ...row, variants: v.value.variants };
}

export async function startExperiment(slug) {
  const row = await db.selectFrom("experiments").selectAll().where("slug", "=", slug).executeTakeFirst();
  if (!row) throw new Error("experiment not found");
  if (row.status === "running") return { slug, status: "running" };
  if (row.status === "completed") throw new Error("a completed experiment can't restart — clone it instead (fresh plan, fresh samples)");
  if (!String(row.hypothesis || "").trim()) throw new Error("write the hypothesis first — the plan freezes at start");
  // one running experiment per serving target: overlapping assignments on
  // the same surface would contaminate each other's exposures
  const clash = await db
    .selectFrom("experiments")
    .select("slug")
    .where("target_kind", "=", row.target_kind)
    .where("status", "in", ["running", "paused"])
    .where("slug", "!=", slug)
    .executeTakeFirst();
  if (clash) throw new Error(`"${clash.slug}" already runs on ${row.target_kind} — complete it first`);
  const salt = row.salt || Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  await db
    .updateTable("experiments")
    .set({ status: "running", salt, started_at: row.started_at || nowIso(), updated_at: nowIso() })
    .where("slug", "=", slug)
    .execute();
  slog("experiment_started", { experiment: slug });
  return { slug, status: "running" };
}

export async function setExperimentStatus(slug, status) {
  if (!["paused", "running", "completed"].includes(status)) throw new Error("status must be paused, running or completed");
  const row = await db.selectFrom("experiments").selectAll().where("slug", "=", slug).executeTakeFirst();
  if (!row) throw new Error("experiment not found");
  if (row.status === "draft") throw new Error("start it first");
  if (row.status === "completed") throw new Error("completed is final");
  if (status === "running") return startExperiment(slug);
  await db
    .updateTable("experiments")
    .set({ status, updated_at: nowIso(), ...(status === "completed" ? { ended_at: nowIso() } : {}) })
    .where("slug", "=", slug)
    .execute();
  slog("experiment_status", { experiment: slug, status });
  return { slug, status };
}

export async function listExperiments() {
  try {
    const rows = await db.selectFrom("experiments").selectAll().orderBy("created_at", "desc").execute();
    return rows.map((r) => ({ ...r, variants: parse(r.variants, []) }));
  } catch {
    return []; // pre-migration tenant
  }
}

// ---- analysis (the only reader of results) ------------------------------------

export async function analyzeExperiment(slug) {
  const row = await db.selectFrom("experiments").selectAll().where("slug", "=", slug).executeTakeFirst();
  if (!row) return null;
  const variants = parse(row.variants, []);
  const [expRows, convRows] = await Promise.all([
    db
      .selectFrom("experiment_exposures")
      .select(({ fn }) => ["variant", fn.countAll().as("n")])
      .where("experiment_id", "=", row.id)
      .groupBy("variant")
      .execute(),
    db
      .selectFrom("experiment_conversions as c")
      .innerJoin("experiment_exposures as e", (join) => join.onRef("e.experiment_id", "=", "c.experiment_id").onRef("e.unit_id", "=", "c.unit_id"))
      .select(({ fn }) => ["e.variant", fn.countAll().as("n"), fn.sum("c.total").as("revenue")])
      .where("c.experiment_id", "=", row.id)
      .groupBy("e.variant")
      .execute(),
  ]);
  const exposedBy = new Map(expRows.map((r) => [r.variant, Number(r.n)]));
  const convBy = new Map(convRows.map((r) => [r.variant, { n: Number(r.n), revenue: Number(r.revenue || 0) }]));
  const cells = variants.map((v) => {
    const exposed = exposedBy.get(v.key) || 0;
    const conv = convBy.get(v.key) || { n: 0, revenue: 0 };
    return { key: v.key, weight: v.weight, exposed, conversions: conv.n, revenue: conv.revenue, rate: exposed ? conv.n / exposed : 0 };
  });

  const srm = srmCheck(cells.map((c) => c.exposed), variants.map((v) => v.weight));
  const insufficient = cells.filter((c) => c.exposed < row.min_sample).map((c) => c.key);

  // Winner interpretation is BLOCKED unless: completed (no peeking) AND
  // every variant reached min_sample AND the ratio check passed. The blocks
  // are returned as reasons, never silently.
  const blocks = [];
  if (row.status !== "completed") blocks.push("experiment still running — no peeking: winner talk starts at completion");
  if (insufficient.length) blocks.push(`insufficient samples (${insufficient.join(", ")} under ${row.min_sample})`);
  if (!srm.ok) blocks.push(`sample-ratio mismatch (χ²=${srm.chi2}) — exposure logging looks broken; fix instrumentation before trusting anything`);

  let verdict = null;
  if (!blocks.length) {
    const cmp = compareTopTwo(cells);
    verdict = cmp.significant
      ? { winner: cmp.winner, z: cmp.z, note: `"${cmp.winner}" wins at 95% confidence (z=${cmp.z})` }
      : { winner: null, z: cmp.z, note: `no significant difference between the top variants (z=${cmp.z}) — an honest null result` };
  }
  return {
    slug,
    status: row.status,
    hypothesis: row.hypothesis,
    primary_metric: row.primary_metric,
    min_sample: row.min_sample,
    adopted_variant: row.adopted_variant,
    cells,
    srm,
    interpretationBlocked: blocks,
    verdict,
  };
}

// Adoption = write the variant payload as a DRAFT through the one door for
// programmatic writers (lib/content-writes.js). The payload is merged over the
// CURRENT hero: a variant names only what it changes (title, highlight,
// subtitle, maybe a button), so the founder's other buttons and badge stay.
// Publishing still needs the Releases tab (legacy) or the editor (documents)
// and its permission. Nothing here touches the live pointer.
// This module is on the storefront's edge path, so it never imports the
// documents service (node:crypto): a Node caller hands it in as `documents`
// (lib/documents/service.js). Without it a documents store refuses (409).
// The door itself is loaded with import() so a storefront request never runs it.
export async function adoptVariant(slug, variantKey, { actor = null, documents = null } = {}) {
  const row = await db.selectFrom("experiments").selectAll().where("slug", "=", slug).executeTakeFirst();
  if (!row) throw new Error("experiment not found");
  if (row.status !== "completed") throw new Error("complete the experiment first — adoption is a post-completion decision");
  const variant = parse(row.variants, []).find((v) => v.key === variantKey);
  if (!variant) throw new Error(`no variant "${variantKey}"`);
  if (variant.key === "control") {
    await db.updateTable("experiments").set({ adopted_variant: "control", updated_at: nowIso() }).where("slug", "=", slug).execute();
    return { slug, adopted: "control", draft: false, note: "control adopted — live content already is the control; nothing to draft" };
  }
  let mode = null;
  let written = null;
  if (row.target_kind === "hero") {
    const { writeContentDrafts } = await import("./content-writes.js");
    written = await writeContentDrafts({ hero: { value: variant.payload, merge: true } }, { actor, source: `experiment:${slug}`, documents });
    mode = written.mode;
  }
  await db.updateTable("experiments").set({ adopted_variant: variantKey, updated_at: nowIso() }).where("slug", "=", slug).execute();
  const cant = mode === "documents" ? await unpublishableDrafts(documents, written?.documents) : { blocked: [], note: null };
  slog("experiment_adopted", { experiment: slug, variant: variantKey, unpublishable: cant.blocked.length });
  const saved = mode === "documents" ? "variant saved into the home page DRAFT — publish it from the editor to take it live" : "variant saved as the hero DRAFT — publish a release to take it live";
  // a draft that can't be published yet says so first, naming what to fix
  const note = cant.note ? `${cant.note} Until then the variant is saved in the draft only.` : saved;
  return { slug, adopted: variantKey, draft: true, note, ...(cant.blocked.length ? { unpublishable: cant.blocked } : {}) };
}

// P3-FIX4 (the P3-VALIDATE direction): a draft this write saved that a publish
// would refuse, said in plain words with what to fix, the way a kit apply says
// it (lib/themes/kits.js unpublishableNote). Documents mode only; advice only:
// a draft that can't be read back is left out.
//   -> { blocked: [{ documentId, label, problems: [words] }], note: words | null }
const DRAFT_LABELS = { doc_home: "The home page", doc_announcement: "The announcement bar" };
async function unpublishableDrafts(documents, ids) {
  const R = await import("./registry/index.js");
  const blocked = [];
  for (const id of ids || []) {
    try {
      const d = await documents.getDocument(id);
      const problems = R.validateDocument(d.body, { mode: "publish", documentId: id })
        .issues.filter((i) => i.severity === "error")
        .map((i) => {
          const at = R.where(i, d.body);
          return at ? `${at}: ${i.message}` : i.message;
        });
      if (problems.length) blocked.push({ documentId: id, label: DRAFT_LABELS[id] || d.label || "This page", problems });
    } catch {
      /* advice only */
    }
  }
  const note = blocked.length
    ? blocked
        .map((b) => {
          const shown = b.problems.slice(0, 3);
          const more = b.problems.length - shown.length;
          return `${b.label} was saved as a draft but can't be published yet. Fix this in the editor first: ${shown.join(" ")}${more > 0 ? ` (and ${more} more)` : ""}`;
        })
        .join(" ")
    : null;
  return { blocked, note };
}


// DOC-07: a flat legacy variant payload ({ title, highlight, subtitle,
// primary: { label, href } … }) laid over a hero SECTION's settings. The
// payload goes through the registry adapter (buttons become typed links) and
// is merged at the settings level, so whatever it doesn't name (the other
// button, the badge, the image) stays. For a legacy hero this gives the same
// result as heroVariantFor: settingsToLegacyHero(heroVariantSettings(
// legacyHeroToSettings(hero), payload)) equals { ...hero, ...payload }.
export function heroVariantSettings(settings, variantPayload) {
  const base = settings !== null && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  return { ...base, ...legacyHeroToSettings(variantPayload) };
}

// ---- serving ------------------------------------------------------------------

export const UNIT_COOKIE = "_unit";

export async function runningExperimentFor(kind) {
  try {
    // P2-PERF: only what serving a variant needs (heroVariantFor and
    // assignVariant: slug, name, variants, salt), not the plan's other columns.
    const r = await db.selectFrom("experiments").select(["id", "slug", "name", "target_kind", "status", "variants", "salt"]).where("target_kind", "=", kind).where("status", "=", "running").executeTakeFirst();
    return r ? { ...r, variants: parse(r.variants, []) } : null;
  } catch {
    return null; // pre-migration tenant
  }
}

// The running tests, by the section each one changes:
// { hero: { slug, name } }. For the console's "a test is running" notes.
export async function runningTestsBySection() {
  let rows;
  try {
    rows = await db.selectFrom("experiments").select(["slug", "name", "target_kind"]).where("status", "=", "running").orderBy("slug").execute();
  } catch {
    return {}; // pre-migration tenant
  }
  const out = {};
  for (const r of rows) {
    const section = TEST_SECTION[r.target_kind];
    if (section && !out[section]) out[section] = { slug: r.slug, name: r.name };
  }
  return out;
}

// Overlay the assigned variant onto the live hero. Control (or no unit, or
// no experiment) = the live hero untouched.
// PV-08: in a preview ({ preview: true }) nothing is picked or applied: the
// founder's own hero comes back as given, with no assignment (so no exposure
// ping) and a `notice` naming the test for the preview to show.
// A browser signed in to the console ({ founder: true }) is the founder too,
// preview or not (the preview cookie lapses with its token while the Designer
// stays open): nothing picked or applied, no assignment. The note needs a
// valid preview, so a hand-made console cookie never shows a test's name.
export function heroVariantFor(experiment, hero, unitId, { preview = false, founder = false } = {}) {
  if (experiment && preview) return { hero, assignment: null, notice: { slug: experiment.slug, name: experiment.name, section: TEST_SECTION.hero } };
  if (experiment && founder) return { hero, assignment: null };
  if (!experiment || !unitId) return { hero, assignment: null };
  const key = assignVariant(experiment, unitId);
  const variant = experiment.variants.find((v) => v.key === key);
  if (!variant || key === "control" || !variant.payload) return { hero, assignment: { slug: experiment.slug, variant: key } };
  return { hero: { ...hero, ...variant.payload }, assignment: { slug: experiment.slug, variant: key } };
}

// PV-08: a request from a browser in a preview session. Any preview cookie
// counts, valid or not: only the console mints one, so a stale or forged one
// can only keep its own holder out of the counts.
export function isPreviewRequest(request) {
  return Boolean(request?.cookies?.get(PREVIEW_COOKIE)?.value);
}

// The console's session cookies: a merchant (lib/admin-auth.js ADMIN_COOKIE)
// or an operator (lib/platform/admin-auth.js PLATFORM_COOKIE). Named here, not
// imported, so the storefront page doesn't load the console's sign-in code;
// test:preview-experiments checks they match.
export const CONSOLE_COOKIES = ["_admin", "_platform"];

// PV-08 fix round 1: a browser signed in to the console (path "/", 7 days)
// belongs to the founder, staff or support, never a visitor. Presence only,
// like the preview cookie: only sign-in sets one, so a stale or hand-made one
// only keeps its own holder out of the test. `jar` is anything with
// get(name) → { value } (request.cookies, or next/headers cookies()).
export function signedInToConsole(jar) {
  return CONSOLE_COOKIES.some((name) => Boolean(jar?.get?.(name)?.value));
}

// The founder's browser: in a preview, or signed in to the console. It is
// never counted, whether or not its preview cookie has lapsed.
export function isFounderRequest(request) {
  return isPreviewRequest(request) || signedInToConsole(request?.cookies);
}

// The unit an order converts for: none from the founder's browser (PV-08).
export function conversionUnit(request) {
  if (isFounderRequest(request)) return null;
  return request?.cookies?.get(UNIT_COOKIE)?.value || null;
}

export async function recordExposure(slug, unitId) {
  const exp = await db.selectFrom("experiments").select(["id", "slug", "status", "salt", "variants"]).where("slug", "=", slug).executeTakeFirst();
  if (!exp || exp.status !== "running" || !unitId) return { recorded: false };
  // the server re-derives the variant — a client can never vote itself into one
  const variant = assignVariant({ ...exp, variants: parse(exp.variants, []) }, unitId);
  await db
    .insertInto("experiment_exposures")
    .values({ experiment_id: exp.id, unit_id: unitId, variant, first_exposed_at: nowIso() })
    .onConflict((oc) => oc.columns(["experiment_id", "unit_id"]).doNothing())
    .execute();
  return { recorded: true, variant };
}

// Called (best-effort, AFTER money committed) when an order is created: the
// order converts every running experiment this unit was EXPOSED to. One row
// per (experiment, order) — retries and webhook replays can't double-count.
export async function recordConversions(unitId, orderId, total) {
  if (!unitId || !orderId) return 0;
  try {
    const running = await db.selectFrom("experiments").select(["id"]).where("status", "=", "running").execute();
    let n = 0;
    for (const exp of running) {
      const exposed = await db
        .selectFrom("experiment_exposures")
        .select("variant")
        .where("experiment_id", "=", exp.id)
        .where("unit_id", "=", unitId)
        .executeTakeFirst();
      if (!exposed) continue;
      await db
        .insertInto("experiment_conversions")
        .values({ experiment_id: exp.id, unit_id: unitId, order_id: orderId, total: Number(total) || 0, created_at: nowIso() })
        .onConflict((oc) => oc.columns(["experiment_id", "order_id"]).doNothing())
        .execute();
      n++;
    }
    return n;
  } catch {
    return 0; // pre-migration tenant / never block anything around an order
  }
}
