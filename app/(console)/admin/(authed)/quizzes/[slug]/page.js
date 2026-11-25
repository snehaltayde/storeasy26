import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { quizRow } from "@/lib/quiz";
import { quizPages, quizTags } from "@/lib/admin/quiz-usage";
import { tfetch } from "@/lib/console-request";
import { QuizEditor } from "@/components/admin/quizzes/QuizEditor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quiz · Admin", robots: { index: false } };

// Phase 2 line 10: one quiz ("new" is the create form, for storefront.write
// only); an unknown slug is a not-found. The page hands the editor the quiz,
// the pages that link to it and the catalog's tags with their counts (all
// storefront.read). canPublish (storefront.publish, decision 6) says whether
// the page offers On/Off and the writes on a quiz that is On.
export default async function AdminQuizPage({ params }) {
  const { slug } = await params;
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  const canWrite = roleAllows(actor.role, "storefront.write");
  if (slug === "new" && !canWrite) redirect("/admin/quizzes");
  const data = await tfetch(async () => {
    const tags = await quizTags();
    if (slug === "new") return { quiz: null, pages: [], tags };
    const quiz = await quizRow(slug);
    return quiz ? { quiz, pages: await quizPages(slug), tags } : null;
  });
  if (!data) notFound();
  return <QuizEditor initial={data.quiz} pages={data.pages} tags={data.tags} role={actor.role} canWrite={canWrite} canPublish={roleAllows(actor.role, "storefront.publish")} />;
}
