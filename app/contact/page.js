import ContentPage from "@/components/ContentPage";
import ContactForm from "@/components/ContactForm";
import { resolvedContentPage } from "@/lib/content/resolve";
import { siteLegalName, siteName } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";

// Session 23: CMS-aware — the default template injects the tenant's own
// support contacts; an override replaces the page wholesale. S39 (SF15):
// every store gets a WORKING contact page — the form renders even when no
// content page exists (non-BeastLife tenants start page-less), and messages
// flow through the BE23 notification service into the console inbox.
export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const page = await tfetch(() => resolvedContentPage("contact"));
  return {
    title: page?.title || "Contact us",
    description: page?.description || "Get in touch with us.",
    alternates: { canonical: "/contact" },
  };
}

export default async function ContactPage() {
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
