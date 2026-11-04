import { NextResponse, after } from "next/server";
import { getQuiz, scoreQuiz, recommendProducts } from "@/lib/quiz";
import { rateLimit } from "@/lib/rate-limit";
import { slog } from "@/lib/log";
import { tenantHandler } from "@/lib/tenant-request";
import { closedStoreGate, STORE_CLOSED_CODE, STORE_CLOSED_MESSAGE } from "@/lib/content/resolve";

// Quiz results (S46 / SF19). Deterministic scoring + catalog recommendation.
// Optional, EXPLICITLY CONSENTED contact capture: one email with the picks —
// stored as a contact message so the merchant console sees it; nothing joins
// a list.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = tenantHandler(async (request, { params }) => {
  const limited = rateLimit(request, { name: "quiz", limit: 30 });
  if (limited) return limited;
  // PUB-06: a store that has never published takes no quiz answers (they can
  // capture an email), except from a founder's valid preview session.
  const closed = await closedStoreGate();
  if (closed && !closed.preview) return NextResponse.json({ error: STORE_CLOSED_MESSAGE, code: STORE_CLOSED_CODE }, { status: 403 });
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
