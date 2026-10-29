import { notFound, permanentRedirect } from "next/navigation";
import ContentPage from "@/components/ContentPage";
import { resolvedContentPage } from "@/lib/content/resolve";
import { campaignVisible } from "@/lib/cms/store";
import { resolvedSlugRedirect } from "@/lib/content/resolve";
import { siteLegalName } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";

// Journal post (S46 / SF20): family-guarded, scheduled via window_start,
// release-governed; a renamed slug 301s from its old URL (page_redirects).
export const dynamic = "force-dynamic";

async function loadPost(slug) {
  const page = await resolvedContentPage(slug);
  if (page && (page.family || "page") === "journal" && campaignVisible(page)) return { page };
  const to = await resolvedSlugRedirect(slug); // release-gated since S53
  return { page: null, redirectTo: to };
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const { page } = await tfetch(() => loadPost(slug));
  if (!page) return { title: "Journal" };
  return { title: page.title, description: page.description, alternates: { canonical: `/journal/${slug}` } };
}

export default async function JournalPost({ params }) {
  const { slug } = await params;
  const [{ page, redirectTo }, legalName] = await tfetch(async () => [await loadPost(slug), siteLegalName()]);
  if (!page) {
    if (redirectTo) permanentRedirect(`/journal/${redirectTo}`);
    notFound();
  }
  return <ContentPage page={page} legalName={legalName} />;
}
