// Product-finder quizzes (Session 46 / SF19). SERVER-ONLY, tenant-scoped.
//
// DETERMINISTIC by design — no AI anywhere in the runtime: options carry tag
// weights, scoring is a tally, and the recommendation is a plain catalog
// query over the winning tags (available products, stable ordering). The
// same answers always produce the same result.
import { db } from "./db.js";
import { cardRows } from "./catalog/effective.js";
import { validateQuiz, scoreQuiz } from "./quiz-rules.js";

// the pure rules live in quiz-rules.js so the console's editor (a client
// component) runs the same validation and scoring; re-exported for callers
export { validateQuiz, scoreQuiz };

const parse = (s, fb) => {
  try {
    return s == null ? fb : JSON.parse(s);
  } catch {
    return fb;
  }
};

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

// The console's list: every quiz, On or Off, newest change first, with its
// question count (Phase 2 line 10).
export async function listQuizzes() {
  try {
    const rows = await db.selectFrom("quizzes").select(["slug", "title", "enabled", "questions", "updated_at"]).orderBy("updated_at", "desc").orderBy("slug").execute();
    return rows.map((r) => ({ slug: r.slug, title: r.title, enabled: !!r.enabled, questionCount: parse(r.questions, []).length, updated_at: r.updated_at }));
  } catch {
    return [];
  }
}

// The console's read of one quiz, On or Off (getQuiz hides an Off one from
// shoppers). null when there is none. Unlike listQuizzes, a failed read
// throws: the publish gate (app/api/admin/quiz) must never take a quiz it
// couldn't read for one that is Off.
export async function quizRow(slug) {
  if (typeof slug !== "string" || !slug) return null;
  const r = await db.selectFrom("quizzes").selectAll().where("slug", "=", slug).executeTakeFirst();
  if (!r) return null;
  return { slug: r.slug, title: r.title, intro: r.intro || "", enabled: !!r.enabled, questions: parse(r.questions, []), updated_at: r.updated_at };
}

export async function deleteQuiz(slug) {
  await db.deleteFrom("quizzes").where("slug", "=", slug).execute();
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
