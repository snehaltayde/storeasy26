import { NextResponse, after } from "next/server";
import { getQuiz, scoreQuiz, recommendProducts } from "@/lib/quiz";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import { storefrontHandler } from "@/lib/storefront-request";

// Quiz results (S46 / SF19). Deterministic scoring + catalog recommendation.
// Optional, EXPLICITLY CONSENTED contact capture: one email with the picks —
// stored as a contact message so the merchant console sees it; nothing joins
// a list.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = storefrontHandler(async (request, { params }) => {
  const limited = rateLimit(request, { name: "quiz", limit: 30 });
  if (limited) return limited;
  const { slug } = await params;
  const quiz = await getQuiz(slug);
  if (!quiz) return NextResponse.json({ error: "quiz not found" }, { status: 404 });
  const body = await request.json().catch(() => ({}));

  const { topTags } = scoreQuiz(quiz, body.answers || {});
  const products = await recommendProducts(topTags);

  // optional consented contact capture — never required for results
  if (body.email && body.consent === true) {
    const email = String(body.email).trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      after(async () => {
        try {
          const { notify } = await import("@/lib/notifications.js");
          const list = products.map((p) => `· ${p.title} — /products/${p.handle}`).join("\n");
          await notify({
            type: "quiz_result",
            to: email,
            subject: `Your picks from the ${quiz.title}`,
            text: `Here are your picks:\n\n${list || "(no matches today)"}\n\nYou asked for this one email after the quiz — there's no list and no follow-ups.`,
          });
          const { runDueJobs } = await import("@/lib/platform/worker.js");
          await runDueJobs({ limit: 5 }).catch(() => {});
        } catch {
          /* best-effort */
        }
      });
      slog("quiz_lead", { quiz: slug });
    }
  }

  return NextResponse.json({ ok: true, topTags, products });
});
