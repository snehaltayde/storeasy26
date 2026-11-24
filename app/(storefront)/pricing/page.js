import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { isPlatformSiteHost } from "@/lib/platform-site";
import { platformConfigured } from "@/lib/platform/control";

// Pricing (S44 / MK02). The cards read the SAME versioned plan catalog the
// billing system charges from (lib/platform/billing.js) — pricing shown here
// can never drift from pricing billed, by construction.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Pricing" };

const inr = (paise) => (paise === 0 ? "Free" : `₹${(paise / 100).toLocaleString("en-IN")}`);

export default async function PricingPage() {
  const host = (await headers()).get("host");
  if (!isPlatformSiteHost(host)) notFound();

  let plans = [];
  // Phase 1 line 1: "Get started" opens self-serve signup while it is open
  // (the ff_self-signup kill switch), else it stays the contact form.
  let getStarted = "/contact";
  if (platformConfigured()) {
    const S = await import("@/lib/platform/signup.js");
    if (!(await S.signupClosedAnswer(host).catch(() => true))) getStarted = "/signup";
    const B = await import("@/lib/platform/billing.js");
    await B.ensureDefaultPlans();
    plans = await B.listPlans();
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Pricing</h1>
      <p className="mt-3 max-w-xl text-zinc-600">
        Billed by Razorpay, cancellable any time. These cards read the live plan catalog — what you see here
        is exactly what the billing system charges.
      </p>

      <div className="mt-10 grid gap-5 sm:grid-cols-3">
        {plans.map((p) => (
          <div key={`${p.id}@${p.version}`} className={`rounded-2xl border p-6 ${p.id === "starter" ? "border-lime-400 shadow-sm" : "border-zinc-200"}`}>
            <h2 className="font-bold capitalize">{p.name}</h2>
            <p className="mt-2 text-3xl font-extrabold">
              {inr(p.price)}
              {p.price > 0 && <span className="text-sm font-normal text-zinc-400">/{p.interval}</span>}
            </p>
            <ul className="mt-4 space-y-2 text-sm text-zinc-600">
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
            <Link href={getStarted} className="mt-6 block rounded-xl bg-zinc-900 px-4 py-2.5 text-center text-sm font-semibold text-white hover:bg-zinc-800">
              Get started
            </Link>
          </div>
        ))}
        {plans.length === 0 && <p className="text-sm text-zinc-400">Plan catalog unavailable right now — ask us directly.</p>}
      </div>

      <p className="mt-8 text-xs text-zinc-400">
        Going over a limit warns — it never blocks a sale. If a subscription stays unpaid past its 7-day grace
        period, checkout pauses while your storefront, content and order lookups stay fully live; service
        resumes on the next successful payment. A published store is never hard-shut-down.
      </p>
    </div>
  );
}
