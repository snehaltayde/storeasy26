import { NextResponse } from "next/server";
import { infraResponse } from "@/lib/infra-response";
import { requireAdmin } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { audit } from "@/lib/platform/audit";
import { slog } from "@/lib/log";
import { listQuizzes, quizRow, upsertQuiz, validateQuiz, recommendProducts } from "@/lib/quiz";
import { guardedDeleteQuiz, quizPages, quizTags, quizUsage } from "@/lib/admin/quiz-usage";
import { tenantHandler } from "@/lib/tenant-request";

// Quiz admin API (S46 / SF19; Phase 2 line 10). Deterministic product-finder
// quizzes: options carry catalog tags, scoring is a tally — no AI anywhere in
// the runtime.
//   GET                          → { quizzes } (each with usedOn, a page count)
//   GET ?slug=                   → one quiz, On or Off (the editor), with its pages
//   GET ?view=usage&slug=        → { pages }: where it is used (lib/admin/quiz-usage.js)
//   GET ?view=tags               → { tags }: catalog tags with product counts
//   GET ?view=try&tags=a,b       → { topTags, products }: the public quiz API's
//                                  answer for those winning tags ("Try it")
//   POST {quiz:{…}, enabled?, create?}  → validate + save. enabled left out keeps
//                                  the quiz's state (a new quiz is Off); create
//                                  refuses a slug already taken (409)
//   POST {remove:{slug}}         → delete, one guarded statement; 409 QUIZ_IN_USE
//                                  with the pages when used, 409 QUIZ_CHANGED otherwise
// Decision 6: every POST needs storefront.write; turning a quiz On, or saving
// or deleting one that is On, also needs storefront.publish (403 otherwise),
// checked before anything else in the body is looked at, and again inside
// the write itself (WHERE enabled = 0) for a caller without it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NEEDS_PUBLISH = "Only an owner or admin can turn a quiz on, or change or delete one that is on. You can save it while it is off.";
const IN_USE = "This quiz is linked from your pages, so it can't be deleted. Take the links out first, or turn it off instead.";
const TAKEN = "A quiz already uses this address. Pick another.";
const CHANGED = "This quiz changed while it was being deleted, so it wasn't deleted. Open it again and try once more.";
const slugOf = (v) => (typeof v === "string" ? v.trim() : "");

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const q = new URL(request.url).searchParams;
  const view = q.get("view");
  const slug = slugOf(q.get("slug"));
  try {
    if (view === "usage") {
      if (!slug) return NextResponse.json({ error: "Which quiz? Add its slug." }, { status: 400 });
      return NextResponse.json({ ok: true, pages: await quizPages(slug) });
    }
    if (view === "tags") return NextResponse.json({ ok: true, tags: await quizTags() });
    if (view === "try") {
      const topTags = String(q.get("tags") || "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 3);
      return NextResponse.json({ ok: true, topTags, products: await recommendProducts(topTags) });
    }
    if (view) return NextResponse.json({ error: "Unknown view" }, { status: 400 });
    if (slug) {
      const quiz = await quizRow(slug);
      if (!quiz) return NextResponse.json({ error: "quiz not found" }, { status: 404 });
      return NextResponse.json({ ok: true, quiz, pages: await quizPages(slug) });
    }
    const [quizzes, usage] = [await listQuizzes(), await quizUsage()];
    return NextResponse.json({ ok: true, quizzes: quizzes.map((z) => ({ ...z, usedOn: (usage.get(z.slug) || []).length })) });
  } catch (e) {
    const infra = infraResponse(e, { route: "admin/quiz" });
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    throw e;
  }
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  const canPublish = roleAllows(auth.actor?.role, "storefront.publish");
  const refused = () => NextResponse.json({ error: NEEDS_PUBLISH, code: "QUIZ_NEEDS_PUBLISH" }, { status: 403 });
  try {
    if (body?.quiz) {
      const slug = slugOf(body.quiz.slug);
      const existing = slug ? await quizRow(slug) : null;
      const enabled = typeof body.enabled === "boolean" ? body.enabled : Boolean(existing?.enabled);
      const publishes = enabled || Boolean(existing?.enabled);
      if (publishes && !canPublish) return refused();
      if (body.create === true && existing) return NextResponse.json({ error: TAKEN, code: "QUIZ_SLUG_TAKEN" }, { status: 409 });
      const v = validateQuiz({ ...body.quiz, slug });
      if (!v.ok) return NextResponse.json({ error: v.errors.join(" · "), errors: v.errors, problems: v.problems }, { status: 422 });
      const saved = await upsertQuiz({ ...body.quiz, slug }, { enabled, onlyIfOff: !canPublish });
      const action = publishes ? "storefront.publish" : "storefront.write";
      await audit({ actor: auth.actor, action, resource: `quiz:${saved.slug}`, diff: { questions: saved.questions.length, enabled, ...(existing ? { was: existing.enabled } : { created: true }) } });
      slog("quiz_saved", { quiz: saved.slug, enabled, created: !existing });
      return NextResponse.json({ ok: true, quiz: { ...saved, enabled } });
    }
    if (body?.remove) {
      const slug = slugOf(body.remove.slug);
      const existing = slug ? await quizRow(slug) : null;
      if (!existing) return NextResponse.json({ error: "quiz not found" }, { status: 404 });
      if (existing.enabled && !canPublish) return refused();
      const inUse = (pages) => NextResponse.json({ error: IN_USE, code: "QUIZ_IN_USE", pages }, { status: 409 });
      const pages = await quizPages(slug);
      if (pages.length) return inUse(pages);
      // one guarded statement (lib/admin/quiz-usage.js): a link or a turn-On
      // that lands after the reads above still stops it
      if ((await guardedDeleteQuiz(slug, canPublish ? existing.enabled : false)) === 0) {
        const now = await quizRow(slug);
        if (!now) return NextResponse.json({ error: "quiz not found" }, { status: 404 });
        if (now.enabled && !canPublish) return refused();
        const again = await quizPages(slug);
        if (again.length) return inUse(again);
        return NextResponse.json({ error: CHANGED, code: "QUIZ_CHANGED" }, { status: 409 });
      }
      await audit({ actor: auth.actor, action: existing.enabled ? "storefront.publish" : "storefront.write", resource: `quiz:${slug}`, diff: { removed: true, was: existing.enabled } });
      slog("quiz_deleted", { quiz: slug });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    if (e?.code === "QUIZ_NOW_ON") return refused(); // turned On since it was read (decision 6)
    if (e?.errors) return NextResponse.json({ error: String(e.message).slice(0, 300), errors: e.errors }, { status: 422 }); // the quiz's own problems
    const infra = infraResponse(e, { route: "admin/quiz" }); // DOC-04: a database failure is never a 4xx
    if (infra) return NextResponse.json(infra.body, { status: infra.status });
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300) }, { status: 422 });
  }
});
