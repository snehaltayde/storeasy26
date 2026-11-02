import { headers } from "next/headers";
import ContentPage from "@/components/ContentPage";
import ContactForm from "@/components/ContactForm";
import LeadForm from "@/components/site/LeadForm";
import { isPlatformSiteHost } from "@/lib/platform-site";
import { resolvedContentPage } from "@/lib/content/resolve";
import { siteLegalName, siteName } from "@/lib/site";
import { tfetch } from "@/lib/storefront-request";

// Session 23: CMS-aware — the default template injects the tenant's own
// support contacts; an override replaces the page wholesale. S39 (SF15):
// every store gets a WORKING contact page — the form renders even when no
// content page exists (non-BeastLife tenants start page-less), and messages
// flow through the BE23 notification service into the console inbox.
export const dynamic = "force-dynamic";

export async function generateMetadata() {
  if (isPlatformSiteHost((await headers()).get("host"))) {
    return { title: "Talk to us", description: "Tell us about your store — we reply personally." };
  }
  const page = await tfetch(() => resolvedContentPage("contact"));
  return {
    title: page?.title || "Contact us",
    description: page?.description || "Get in touch with us.",
    alternates: { canonical: "/contact" },
  };
}

export default async function ContactPage() {
  // S44 (MK08): on the marketing host, /contact is the SaaS lead form.
  if (isPlatformSiteHost((await headers()).get("host"))) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Talk to us</h1>
        <p className="mt-3 text-zinc-600">
          Tell us about your store — we onboard a small number of merchants at a time and reply personally.
        </p>
        <div className="mt-8">
          <LeadForm />
        </div>
      </div>
    );
  }

  const [page, legalName, name] = await tfetch(async () => [await resolvedContentPage("contact"), siteLegalName(), siteName()]);

  if (page) {
    return (
      <ContentPage page={page} legalName={legalName}>
        <div className="mt-10">
          <ContactForm />
        </div>
      </ContentPage>
    );
  }
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-tight">Contact {name}</h1>
      <p className="mt-3 text-zinc-500">Questions about an order or a product? Drop us a line.</p>
      <div className="mt-8">
        <ContactForm />
      </div>
    </div>
  );
}
