import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { audit } from "@/lib/platform/audit";
import { db } from "@/lib/db";
import { listQuizzes, upsertQuiz, deleteQuiz, validateQuiz } from "@/lib/quiz";
import { tenantHandler } from "@/lib/tenant-request";

// Quiz admin API (S46 / SF19). Deterministic product-finder quizzes: options
// carry catalog tags, scoring is a tally — no AI anywhere in the runtime.
//   GET                  → quizzes list
//   GET ?slug=           → one quiz (full questions, for the editor)
//   POST {quiz:{…}, enabled}   → validate + upsert
//   POST {remove:{slug}}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.read");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const slug = new URL(request.url).searchParams.get("slug");
  if (slug) {
    // editor read: include disabled quizzes too (getQuiz hides them from shoppers)
    const r = await db.selectFrom("quizzes").selectAll().where("slug", "=", slug).executeTakeFirst().catch(() => null);
    if (!r) return NextResponse.json({ error: "quiz not found" }, { status: 404 });
    let questions = [];
    try {
      questions = JSON.parse(r.questions);
    } catch {
      questions = [];
    }
    return NextResponse.json({ ok: true, quiz: { slug: r.slug, title: r.title, intro: r.intro || "", enabled: !!r.enabled, questions } });
  }
  return NextResponse.json({ ok: true, quizzes: await listQuizzes() });
});

export const POST = tenantHandler(async (request) => {
  const auth = await requireAdmin(request, "storefront.write");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = await request.json().catch(() => ({}));
  try {
    if (body.quiz) {
      const v = validateQuiz(body.quiz);
      if (!v.ok) return NextResponse.json({ error: v.errors.join(" · "), errors: v.errors }, { status: 422 });
      const saved = await upsertQuiz(body.quiz, { enabled: body.enabled !== false });
      await audit({ actor: auth.actor, action: "storefront.write", resource: `quiz:${saved.slug}`, diff: { questions: saved.questions.length, enabled: body.enabled !== false } });
      return NextResponse.json({ ok: true, quiz: saved });
    }
    if (body.remove) {
      await deleteQuiz(String(body.remove.slug || ""));
      await audit({ actor: auth.actor, action: "storefront.write", resource: `quiz:${body.remove.slug}`, diff: { removed: true } });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e?.message || e).slice(0, 300), ...(e.errors ? { errors: e.errors } : {}) }, { status: 422 });
  }
});
