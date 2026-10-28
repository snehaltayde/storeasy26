import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isPlatformSiteHost } from "@/lib/platform-site";

// Platform SaaS legal (S44 / MK08): terms + privacy for the PLATFORM itself
// (merchant-facing), distinct from each store's shopper-facing policies.
// Plain-language and honest; clearly marked for counsel review before public
// launch (a checkpoint-C item).
export const dynamic = "force-dynamic";

const DOCS = {
  terms: {
    title: "Terms of service",
    sections: [
      ["The deal", "Storeasy provides storefront software for your existing Shopify store on a subscription. Shopify remains your system of record for catalog, orders, payments to you, and fulfilment; Razorpay processes shopper payments under your own account."],
      ["Your store, your data", "Your catalog, content, orders and customer data belong to you. You can request a complete export at any time, and offboarding keeps your data exportable — we never hold it hostage."],
      ["Billing", "Plans are billed through Razorpay Subscriptions at the prices shown on the pricing page (the same catalog the billing system charges from). Payment trouble triggers a 7-day grace period with full service; past grace, checkout pauses but your storefront stays up. We never hard-shut-down a published store over billing."],
      ["Acceptable use", "No illegal goods, no deceptive practices toward your shoppers, no attempts to access other merchants' data (which is structurally isolated anyway)."],
      ["Our commitments and limits", "We run backups with rehearsed restores and publish our deployed security controls on the trust page. The service is provided as-is while in early access; our liability is capped at the fees you paid in the preceding three months."],
      ["Ending things", "Cancel any time from billing. On offboarding we suspend the storefront, revoke access keys, and keep your database available for export until you ask us to delete it."],
    ],
  },
  privacy: {
    title: "Privacy policy",
    sections: [
      ["Who this covers", "This policy covers merchants and visitors to this website. Shoppers on a merchant's storefront are covered by that store's own privacy policy; we process shopper data as the store's service provider."],
      ["What we collect from merchants", "Account details (name, email), store configuration, and the operational data needed to run your storefront. Billing runs through Razorpay — card details never touch us."],
      ["This website", "The contact form stores what you type plus your separate, optional marketing opt-in. No analytics pixels run on this site today."],
      ["Shopper data we process for stores", "Orders (contact + address for delivery), consent-gated analytics events, and privacy requests — processed under each store's instructions, with redaction workflows that scrub identity while retaining the legal money record."],
      ["Where data lives", "Databases are hosted on Turso and the application on Vercel. Each store's commerce data lives in its own isolated database."],
      ["Your rights", "Ask us for a copy or deletion of your data at any time; merchants can self-serve a full store export. Write to us via the contact page."],
    ],
  },
};

export default async function LegalPage({ params }) {
  if (!isPlatformSiteHost((await headers()).get("host"))) notFound();
  const { doc } = await params;
  const d = DOCS[doc];
  if (!d) notFound();
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-tight">{d.title}</h1>
      <p className="mt-2 text-xs text-zinc-400">Plain-language draft, effective 2026-10-28 · pending counsel review before public launch.</p>
      <div className="mt-8 space-y-7">
        {d.sections.map(([h, body]) => (
          <section key={h}>
            <h2 className="font-bold">{h}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">{body}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
