import { notFound } from "next/navigation";
import ContentPage from "@/components/ContentPage";
import { resolvedContentPage } from "@/lib/content/resolve";
import { siteLegalName } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";

// Session 23: CMS-aware — the default template injects the tenant's own
// support contacts; an override replaces the page wholesale.
export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const page = await tfetch(() => resolvedContentPage("contact"));
  if (!page) return { title: "Contact" };
  return { title: page.title, description: page.description, alternates: { canonical: "/contact" } };
}

export default async function ContactPage() {
  const [page, legalName] = await tfetch(async () => [await resolvedContentPage("contact"), siteLegalName()]);
  if (!page) notFound();
  return <ContentPage page={page} legalName={legalName} />;
}
