import { notFound } from "next/navigation";
import ContentPage from "@/components/ContentPage";
import { PAGES, POLICY_SLUGS } from "@/lib/content/pages";

export function generateStaticParams() {
  return POLICY_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const page = POLICY_SLUGS.includes(slug) ? PAGES[slug] : null;
  if (!page) return { title: "Policy not found" };
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: `/policies/${slug}` },
  };
}

export default async function PolicyPage({ params }) {
  const { slug } = await params;
  if (!POLICY_SLUGS.includes(slug)) notFound();
  return <ContentPage page={PAGES[slug]} />;
}
