import { notFound } from "next/navigation";
import ContentPage from "@/components/ContentPage";
import { getContentPage } from "@/lib/cms/store";
import { siteLegalName } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";

// Session 23: CMS-aware — a tenant override replaces the default template.
export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const page = await tfetch(() => getContentPage("about"));
  if (!page) return { title: "About" };
  return { title: page.title, description: page.description, alternates: { canonical: "/about" } };
}

export default async function AboutPage() {
  const [page, legalName] = await tfetch(async () => [await getContentPage("about"), siteLegalName()]);
  if (!page) notFound();
  return <ContentPage page={page} legalName={legalName} />;
}
