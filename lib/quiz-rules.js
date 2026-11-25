// Product-finder quiz rules (S46 / SF19), pure: no database, no node: import.
// lib/quiz.js re-exports them for the server; the console's quiz editor
// (components/admin/quizzes/, Phase 2 line 10) imports them directly, so the
// inline errors and "Try it" are the same rules the API and the store apply.

// { ok, errors, problems, value }. errors: the API's short strings (as since
// S46). problems: the same refusals for the editor, each { at, words }: at is
// "slug", "title", "questions", a question id ("q1") or an option id
// ("q1o2"), words a plain sentence for that field.
export function validateQuiz({ slug, title, intro = "", questions }) {
  const errors = [];
  const problems = [];
  const bad = (error, at, words) => {
    errors.push(error);
    problems.push({ at, words });
  };
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug || "")) bad("slug must be lowercase letters/digits/hyphens", "slug", "Use lowercase letters, numbers and hyphens, starting with a letter or number (up to 61).");
  if (!title?.trim()) bad("title required", "title", "Give the quiz a title.");
  if (!Array.isArray(questions) || !questions.length) bad("at least one question", "questions", "Add at least one question.");
  if ((questions || []).length > 10) bad("at most 10 questions", "questions", "A quiz can have up to 10 questions.");
  const clean = (questions || []).slice(0, 10).map((q, i) => {
    const id = `q${i + 1}`;
    const prompt = String(q?.prompt || "").trim().slice(0, 300);
    if (!prompt) bad(`question ${i + 1}: prompt required`, id, "Write the question.");
    const options = Array.isArray(q?.options) ? q.options.slice(0, 6) : [];
    if (options.length < 2) bad(`question ${i + 1}: at least 2 options`, id, "Give this question at least two answers.");
    return {
      id,
      prompt,
      options: options.map((o, j) => ({
        id: `${id}o${j + 1}`,
        label: String(o?.label || "").trim().slice(0, 120),
        tags: (Array.isArray(o?.tags) ? o.tags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 5),
      })),
    };
  });
  for (const q of clean) for (const o of q.options) if (!o.label) bad(`${q.id}: every option needs a label`, o.id, "Write this answer.");
  return { ok: !errors.length, errors, problems, value: { slug, title: title?.trim().slice(0, 120), intro: String(intro || "").slice(0, 500), questions: clean } };
}

// The limits the editor shows (validateQuiz keeps only the first of each).
export const QUIZ_LIMITS = Object.freeze({ questions: 10, options: 6, tags: 5 });

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

