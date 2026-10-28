import Link from "next/link";

// Marketing homepage (S44 / MK01). Every claim here is SUBSTANTIATED by
// shipped, verified behavior — no vapor, no stock-photo heroes.
const FEATURES = [
  {
    title: "Your Shopify catalog, a faster storefront",
    body: "Products, collections and inventory sync from the store you already run — Shopify stays authoritative for catalog, orders and payments. Pages read from a local projection in milliseconds.",
  },
  {
    title: "Drafts, releases, rollback",
    body: "Every content change is a draft until you publish. Releases are immutable snapshots with validation (dead links, contrast) — and rollback is one click that never touches your drafts.",
  },
  {
    title: "Theme kits that actually differ",
    body: "Pulse (nutrition) and Glow (beauty) ship today — same engine, visibly different stores. Kits are version-pinned: a redesign never lands on your store until you apply it.",
  },
  {
    title: "Offers that explain themselves",
    body: "Coupons, tiered discounts, gifts and cart upsells with a deterministic simulator — see exactly what a cart pays before an offer goes live. Timezone-safe scheduling included.",
  },
  {
    title: "Honest analytics",
    body: "Consent-first by design: behavioural numbers cover consented sessions and say so. Money numbers come from your orders ledger with provider-mirrored refunds — never estimates.",
  },
  {
    title: "Ops a real store needs",
    body: "Individual team accounts with roles, append-only audit log, durable job queues with replay, per-tenant isolated databases, backup restore drills, branded maintenance mode.",
  },
];

export default function MarketingHome() {
  return (
    <>
      <section className="bg-zinc-950 text-white">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <p className="inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-lime-400">
            <span className="h-1.5 w-1.5 rounded-full bg-lime-400" /> For Shopify merchants in India
          </p>
          <h1 className="mt-5 max-w-3xl text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
            A fast, branded storefront on the Shopify catalog you already have.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-zinc-400">
            Storeasy runs your shopper experience — themes, offers, content releases, checkout with Razorpay &
            COD — while Shopify keeps running your catalog, orders and fulfilment.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/contact" className="rounded-full bg-lime-400 px-6 py-3 text-sm font-bold text-zinc-950 hover:bg-lime-300">
              Talk to us
            </Link>
            <Link href="/pricing" className="rounded-full border border-white/20 px-6 py-3 text-sm font-semibold hover:bg-white/10">
              See pricing
            </Link>
          </div>
          <p className="mt-10 text-xs text-zinc-500">
            406 automated checks run before every release of the platform itself. We hold ourselves to the
            honesty we promise you: these pages claim only what is built and verified.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl border border-zinc-200 p-5">
              <h2 className="font-bold">{f.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        <div className="rounded-2xl bg-zinc-950 px-6 py-10 text-center text-white sm:px-10">
          <h2 className="text-2xl font-bold tracking-tight">Built for two verticals first</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-zinc-400">
            Nutrition & performance, and beauty & self-care — each with a theme kit designed for how those
            shoppers actually buy.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link href="/verticals/nutrition" className="rounded-full border border-white/20 px-5 py-2.5 text-sm font-semibold hover:bg-white/10">
              Nutrition stores →
            </Link>
            <Link href="/verticals/beauty" className="rounded-full border border-white/20 px-5 py-2.5 text-sm font-semibold hover:bg-white/10">
              Beauty stores →
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
