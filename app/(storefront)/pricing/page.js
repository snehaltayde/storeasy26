import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { isPlatformSiteHost } from "@/lib/platform-site";
import { platformConfigured } from "@/lib/platform/control";
import LeadForm from "@/components/site/LeadForm";
import { ArtDefs, TierBars } from "@/components/site/LandingArt";
import { PRICING } from "@/components/site/landing-copy";

// Pricing (S44 / MK02; tiers 2026-11-26). The cards read the SAME versioned
// plan catalog the billing system charges from (lib/platform/billing.js) —
// pricing shown here can never drift from pricing billed, by construction.
// listPublicPlans leaves the internal price-zero plan out; Enterprise has no
// catalog row and no price (ENTERPRISE_PLAN): its card leads to the lead form
// at the foot of this page, which is the same form /contact shows.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Pricing" };

const inr = (paise) => `₹${(paise / 100).toLocaleString("en-IN")}`;
const ring = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mk-blue";

export default async function PricingPage() {
  const host = (await headers()).get("host");
  if (!isPlatformSiteHost(host)) notFound();

  let plans = [];
  let enterprise = null;
  // Phase 1 line 1: "Get started" opens self-serve signup while it is open
  // (the ff_self-signup kill switch), else it stays the contact form.
  let getStarted = "/contact";
  if (platformConfigured()) {
    const S = await import("@/lib/platform/signup.js");
    if (!(await S.signupClosedAnswer(host).catch(() => true))) getStarted = "/signup";
    const B = await import("@/lib/platform/billing.js");
    await B.ensureDefaultPlans();
    plans = await B.listPublicPlans();
    enterprise = B.ENTERPRISE_PLAN;
  }
  const top = plans[plans.length - 1] || null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <ArtDefs />
      <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl">{PRICING.title}</h1>
      <p className="mt-4 max-w-xl text-zinc-600">
        {PRICING.lede} Billed by Razorpay, cancellable any time. These cards read the live plan catalog — what you see
        here is exactly what the billing system charges.
      </p>

      <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((p, i) => (
          <div key={`${p.id}@${p.version}`} className="flex flex-col rounded-3xl border border-zinc-200 bg-white p-6 transition-[translate,box-shadow,border-color] duration-500 hover:-translate-y-1.5 hover:border-mk-violet hover:shadow-[0_40px_60px_-44px_rgb(42_20_160/0.7)]">
            <TierBars level={i + 1} />
            <h2 className="mt-5 text-lg font-bold">{p.name}</h2>
            <p className="mt-2 text-3xl font-extrabold tabular-nums">
              {inr(p.price)}
              <span className="text-sm font-normal text-zinc-400">/{p.interval}</span>
            </p>
            <ul className="mt-4 mb-6 flex-1 space-y-2 text-sm text-zinc-600">
              {Object.entries(p.features).map(([k, v]) => (
                <li key={k} className="flex gap-2">
                  <span className="text-lime-600">✓</span>
                  {typeof v === "boolean" ? k.replace(/_/g, " ") : `${Number(v).toLocaleString("en-IN")} ${k.replace(/_/g, " ")}`}
                </li>
              ))}
              <li className="flex gap-2">
                <span className="text-lime-600">✓</span>every platform feature — plans differ by limits, not by held-back basics
              </li>
            </ul>
            <Link href={getStarted} className={`block rounded-full bg-zinc-900 px-4 py-2.5 text-center text-sm font-semibold text-white hover:bg-zinc-800 ${ring}`}>
              Get started
            </Link>
          </div>
        ))}
        {enterprise && plans.length > 0 && (
          <div className="flex flex-col rounded-3xl bg-(image:--mk-surface) p-6 text-white">
            <TierBars level={4} ink />
            <h2 className="mt-5 text-lg font-bold">{enterprise.name}</h2>
            <p className="mt-2 text-3xl font-extrabold">{PRICING.enterprisePrice}</p>
            <p className="mt-4 mb-6 flex-1 text-sm leading-relaxed text-mk-on-ink">
              {top ? `${PRICING.enterpriseAbove} ${top.name}. ` : null}
              {PRICING.enterpriseBody}
            </p>
            <a href="#enterprise" className="block rounded-full bg-white px-4 py-2.5 text-center text-sm font-semibold text-mk-navy hover:bg-mk-mist focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
              {PRICING.enterpriseCta}
            </a>
          </div>
        )}
        {plans.length === 0 && <p className="text-sm text-zinc-400">Plan catalog unavailable right now — ask us directly.</p>}
      </div>

      <p className="mt-8 text-xs text-zinc-400">
        Going over a limit warns — it never blocks a sale. If a subscription stays unpaid past its 7-day grace
        period, checkout pauses while your storefront, content and order lookups stay fully live; service
        resumes on the next successful payment. A published store is never hard-shut-down.
      </p>

      <section id="enterprise" aria-labelledby="enterprise-title" className="mt-20 grid scroll-mt-24 gap-8 border-t border-zinc-200 pt-12 lg:grid-cols-2">
        <div>
          <h2 id="enterprise-title" className="mk-display text-3xl sm:text-4xl">
            {enterprise?.name || "Enterprise"}
          </h2>
          <p className="mt-3 max-w-md text-zinc-600">{PRICING.enterpriseBody} Tell us about your store and we reply personally.</p>
        </div>
        <LeadForm />
      </section>
    </div>
  );
}
