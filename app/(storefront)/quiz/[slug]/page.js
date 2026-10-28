import { notFound } from "next/navigation";
import { getQuiz } from "@/lib/quiz";
import QuizRunner from "@/components/QuizRunner";
import { tfetch } from "@/lib/tenant-request";

// Product-finder quiz (S46 / SF19): deterministic — no AI at runtime.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const quiz = await tfetch(() => getQuiz(slug));
  if (!quiz) notFound();
  return { title: quiz.title, description: quiz.intro?.slice(0, 160) };
}

export default async function QuizPage({ params }) {
  const { slug } = await params;
  const quiz = await tfetch(() => getQuiz(slug));
  if (!quiz) notFound();
  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-tight">{quiz.title}</h1>
      {quiz.intro && <p className="mt-2 text-zinc-500">{quiz.intro}</p>}
      <div className="mt-8">
        <QuizRunner quiz={quiz} />
      </div>
    </div>
  );
}
