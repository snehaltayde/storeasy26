// Product-finder quizzes (Session 46 / SF19). SERVER-ONLY, tenant-scoped.
//
// DETERMINISTIC by design — no AI anywhere in the runtime: options carry tag
// weights, scoring is a tally, and the recommendation is a plain catalog
// query over the winning tags (available products, stable ordering). The
// same answers always produce the same result.
import { db } from "./db.js";
import { cardRows } from "./catalog/effective.js";

const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

export function validateQuiz({ slug, title, intro = "", questions }) {
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug || "")) errors.push("slug must be lowercase letters/digits/hyphens");
  if (!title?.trim()) errors.push("title required");
  if (!Array.isArray(questions) || !questions.length) errors.push("at least one question");
  if ((questions || []).length > 10) errors.push("at most 10 questions");
  const clean = (questions || []).slice(0, 10).map((q, i) => {
    const prompt = String(q?.prompt || "").trim().slice(0, 300);
    if (!prompt) errors.push(`question ${i + 1}: prompt required`);
    const options = Array.isArray(q?.options) ? q.options.slice(0, 6) : [];
    if (options.length < 2) errors.push(`question ${i + 1}: at least 2 options`);
    return {
      id: `q${i + 1}`,
      prompt,
      options: options.map((o, j) => ({
        id: `q${i + 1}o${j + 1}`,
        label: String(o?.label || "").trim().slice(0, 120),
        tags: (Array.isArray(o?.tags) ? o.tags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 5),
      })),
    };
  });
  for (const q of clean) for (const o of q.options) if (!o.label) errors.push(`${q.id}: every option needs a label`);
  return { ok: !errors.length, errors, value: { slug, title: title?.trim().slice(0, 120), intro: String(intro || "").slice(0, 500), questions: clean } };
}

export async function upsertQuiz(input, { enabled = true } = {}) {
  const v = validateQuiz(input);
  if (!v.ok) {
    const err = new Error(v.errors.join(" · "));
    err.errors = v.errors;
    throw err;
  }
  const row = { slug: v.value.slug, title: v.value.title, intro: v.value.intro, questions: JSON.stringify(v.value.questions), enabled: enabled ? 1 : 0, updated_at: new Date().toISOString() };
  await db
    .insertInto("quizzes")
    .values(row)
    .onConflict((oc) => oc.column("slug").doUpdateSet(row))
    .execute();
  return v.value;
}

export async function getQuiz(slug) {
  try {
    const r = await db.selectFrom("quizzes").selectAll().where("slug", "=", slug).executeTakeFirst();
    if (!r || !r.enabled) return null;
    return { slug: r.slug, title: r.title, intro: r.intro || "", questions: parse(r.questions, []) };
  } catch {
    return null;
  }
}

export async function listQuizzes() {
  try {
    const rows = await db.selectFrom("quizzes").select(["slug", "title", "enabled", "updated_at"]).execute();
    return rows.map((r) => ({ ...r, enabled: !!r.enabled }));
  } catch {
    return [];
  }
}

export async function deleteQuiz(slug) {
  await db.deleteFrom("quizzes").where("slug", "=", slug).execute();
}

// Tally tags for the chosen options. answers = {questionId: optionId}.
export function scoreQuiz(quiz, answers) {
  const tally = new Map();
  for (const q of quiz.questions) {
    const chosen = q.options.find((o) => o.id === answers?.[q.id]);
    if (!chosen) continue;
    for (const t of chosen.tags) tally.set(t, (tally.get(t) || 0) + 1);
  }
  // deterministic winners: score desc, then tag A–Z
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { ranked, topTags: ranked.slice(0, 3).map(([t]) => t) };
}

// Winning tags → available products (tag match counted in JS for honesty;
// stable ordering: matches desc, then title).
// P4-EFFECTIVE (OVL-03): scoring reads Shopify's RAW tags (logic_tags); the
// results, and the quiz email built from them, show the effective title,
// display type and image (lib/catalog/effective.js). Ties order by the title
// the shopper sees.
export async function recommendProducts(topTags, { limit = 4 } = {}) {
  if (!topTags.length) return [];
  const rows = await cardRows({ availableOnly: true, logic: true });
  const scored = rows
    .map((r) => {
      const tags = r.logic_tags.map((t) => String(t).toLowerCase());
      const matches = topTags.filter((t) => tags.includes(t)).length;
      return { ...r, matches };
    })
    .filter((r) => r.matches > 0)
    .sort((a, b) => b.matches - a.matches || String(a.title).localeCompare(String(b.title)))
    .slice(0, limit);
  return scored.map((r) => ({ handle: r.handle, title: r.title, display_type: r.display_type, image: r.featured_image, price: r.price_min, currency: r.currency || "INR", matches: r.matches }));
}
