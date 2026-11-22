import { notFound } from "next/navigation";
import ContentPage from "@/components/ContentPage";
import TrackEvent from "@/components/analytics/TrackEvent";
import { resolvedContentPage } from "@/lib/content/resolve";
import { campaignVisible } from "@/lib/content/pages";
import { pickUtmParams, appendUtmToHtml } from "@/lib/content/utm";
import { siteLegalName } from "@/lib/site";
import { tfetch } from "@/lib/storefront-request";

// Campaign landing pages (S39 / SF17): cms_pages rows with family='campaign',
// release-governed like every page, served ONLY inside their UTC visibility
// window (outside → 404, so a dead campaign link never shows stale offers).
// Internal links keep the visitor's utm_* params (attribution survives the
// click-through). Campaigns are noindex — they're destination pages for paid/
// social traffic, not organic surface.
export const dynamic = "force-dynamic";

async function loadCampaign(slug) {
  const page = await resolvedContentPage(slug);
  if (!page || (page.family || "page") !== "campaign" || !campaignVisible(page)) return null;
  return page;
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const page = await tfetch(() => loadCampaign(slug));
  if (!page) notFound();
  return { title: page.title, description: page.description, robots: { index: false } };
}

export default async function CampaignPage({ params, searchParams }) {
  const { slug } = await params;
  const utm = pickUtmParams(await searchParams);
  const [page, legalName] = await tfetch(async () => [await loadCampaign(slug), siteLegalName()]);
  if (!page) notFound();

  // UTM retention: rewrite internal hrefs in rich/faq content before render
  const sections = page.sections.map((s) => {
    if (s.kind === "rich") return { ...s, html: appendUtmToHtml(s.html, utm) };
    if (s.kind === "faq") return { ...s, items: s.items.map((it) => ({ ...it, a: appendUtmToHtml(it.a, utm) })) };
    return s;
  });

  return (
    <>
      <TrackEvent name="view_campaign" data={{ params: { campaign_slug: slug, ...utm } }} />
      <ContentPage page={{ ...page, sections }} legalName={legalName} />
    </>
  );
}
