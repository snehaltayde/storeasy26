import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { isPlatformSiteHost } from "@/lib/platform-site";

// Vertical pages (S44 / MK04): nutrition + beauty — tied to the kits that
// actually ship, claims limited to built behavior.
export const dynamic = "force-dynamic";

const VERTICALS = {
  nutrition: {
    title: "Storefronts for nutrition & performance brands",
    kit: "Pulse",
    intro:
      "Protein, creatine, wellness — shoppers who compare, reorder and buy on conviction. Pulse is the dark, high-energy kit built for that.",
    points: [
      "Per-product modules for ingredients, usage and lab notes — accordions on every product page",
      "Offers engine built for supplement retail: tier discounts, gift-with-purchase, combo upsells, COD + Razorpay",
      "Collection curation and pinned bestsellers; URL-backed filters shoppers can share",
      "Campaign landing pages with UTM retention for launch drops",
    ],
  },
  beauty: {
    title: "Storefronts for beauty & self-care brands",
    kit: "Glow",
    intro:
      "Rituals, routines and editorial shopping. Glow is the airy serif kit — cream surfaces, warm accents — that makes a catalog feel like a magazine.",
    points: [
      "The same engine as Pulse with a completely different face — proof the platform really is multi-brand",
      "Rich-text and FAQ sections for routines and ingredient education, sanitized and release-governed",
      "Draft preview at phone/tablet/desktop widths before anything goes live",
      "Brand tokens gated by WCAG contrast checks — pretty never beats readable",
    ],
  },
};

export default async function VerticalPage({ params }) {
  if (!isPlatformSiteHost((await headers()).get("host"))) notFound();
  const { vertical } = await params;
  const v = VERTICALS[vertical];
  if (!v) notFound();

  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <p className="text-xs font-bold uppercase tracking-wide text-lime-600">{v.kit} kit · available today</p>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">{v.title}</h1>
      <p className="mt-4 max-w-2xl text-lg text-zinc-600">{v.intro}</p>
      <ul className="mt-8 space-y-3">
        {v.points.map((p) => (
          <li key={p} className="flex gap-3 rounded-xl border border-zinc-200 p-4 text-sm text-zinc-700">
            <span className="text-lime-600">✓</span>
            {p}
          </li>
        ))}
      </ul>
      <div className="mt-10 flex gap-3">
        <Link href="/contact" className="rounded-full bg-zinc-900 px-6 py-3 text-sm font-bold text-white hover:bg-zinc-800">
          Talk to us
        </Link>
        <Link href="/templates" className="rounded-full border border-zinc-300 px-6 py-3 text-sm font-semibold hover:bg-zinc-50">
          See the kits
        </Link>
      </div>
    </div>
  );
}
