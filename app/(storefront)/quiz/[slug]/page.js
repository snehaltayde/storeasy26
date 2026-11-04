import { notFound } from "next/navigation";
import { getQuiz } from "@/lib/quiz";
import QuizRunner from "@/components/QuizRunner";
import { tfetch } from "@/lib/tenant-request";
import { closedStoreGate } from "@/lib/content/resolve";
import { siteName } from "@/lib/site";
import StoreClosed from "@/components/StoreClosed";

// Product-finder quiz (S46 / SF19): deterministic — no AI at runtime.
export const dynamic = "force-dynamic";

// P3-FRAME (PUB-06, after the P3-CLOSED review): a store that has never
// published is closed. The layout shows "Opening soon" on a full page load,
// but an in-app navigation renders this page without the layout, and Next
// carries a page's metadata and its own render in the payload either way.
// So the page itself answers the closed page, before reading the founder's
// quiz: its title, words and products never reach a shopper. A valid
// preview session still sees it (closedStoreGate's { preview: true }).
async function closedHere() {
  try {
    const gate = await tfetch(() => closedStoreGate());
    return gate?.preview === false ? await tfetch(async () => siteName()).catch(() => "Store") : null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const closed = await closedHere();
  if (closed !== null) return { title: { absolute: `${closed} · Opening soon` }, description: "Opening soon.", robots: { index: false, follow: false } };
  const quiz = await tfetch(() => getQuiz(slug));
  if (!quiz) notFound();
  return { title: quiz.title, description: quiz.intro?.slice(0, 160) };
}

export default async function QuizPage({ params }) {
  const { slug } = await params;
  const closed = await closedHere();
  if (closed !== null) return <StoreClosed name={closed} />;
  const quiz = await tfetch(() => getQuiz(slug));
  if (!quiz) notFound();
  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-tight">{quiz.title}</h1>
      {quiz.intro && <p className="mt-2 text-sf-text-subtle">{quiz.intro}</p>}
      <div className="mt-8">
        <QuizRunner quiz={quiz} />
      </div>
    </div>
  );
}
