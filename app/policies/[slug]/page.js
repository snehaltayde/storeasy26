import { notFound } from "next/navigation";
import ContentPage from "@/components/ContentPage";
import { resolvedContentPage } from "@/lib/content/resolve";
import { siteLegalName } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";

// Session 23: serves default policy templates AND merchant-added CMS pages —
// any slug with content renders, everything else 404s. Dynamic per request
// (slugs differ per tenant, and edits go live without a deploy).
export const dynamic = "force-dynamic";

// S39: campaign-family pages serve at /campaigns/<slug> only — not here.
const asPolicy = (page) => (page && (page.family || "page") === "page" ? page : null);

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const page = asPolicy(await tfetch(() => resolvedContentPage(slug)));
  if (!page) return { title: "Page not found" };
  return { title: page.title, description: page.description, alternates: { canonical: `/policies/${slug}` } };
}

export default async function PolicyPage({ params }) {
  const { slug } = await params;
  const [page, legalName] = await tfetch(async () => [asPolicy(await resolvedContentPage(slug)), siteLegalName()]);
  if (!page) notFound();
  return <ContentPage page={page} legalName={legalName} />;
}
