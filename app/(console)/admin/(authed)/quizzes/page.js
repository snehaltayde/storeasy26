import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { listQuizzes } from "@/lib/quiz";
import { quizUsage } from "@/lib/admin/quiz-usage";
import { tfetch } from "@/lib/console-request";
import { QuizList } from "@/components/admin/quizzes/QuizList";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quizzes · Admin", robots: { index: false } };

// Phase 2 line 10: the product-finder quizzes on the new UI
// (lib/admin/new-ui-routes.js), under storefront.read like GET
// /api/admin/quiz. canWrite says whether the page offers "New quiz"; the API
// refuses writes regardless. usedOn: how many pages link to the quiz.
export default async function AdminQuizzesPage() {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const quizzes = await tfetch(async () => {
    const [list, usage] = [await listQuizzes(), await quizUsage()];
    return list.map((q) => ({ ...q, usedOn: (usage.get(q.slug) || []).length }));
  });
  return <QuizList quizzes={quizzes} role={actor.role} canWrite={roleAllows(actor.role, "storefront.write")} />;
}
