import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { isPlatformSiteHost } from "@/lib/platform-site";
import { KITS } from "@/lib/themes/kits";

// Template gallery (S44 / MK03) — read from the LIVE kit registry, labeled
// honestly: what ships is "available"; what doesn't exist yet says "planned"
// and nothing more.
export const metadata = { title: "Templates" };
export const dynamic = "force-dynamic";

const PLANNED = [
  { label: "Wardrobe", vertical: "Fashion & apparel", status: "planned" },
  { label: "Pantry", vertical: "Food & beverages", status: "planned" },
];

export default async function TemplatesPage() {
  if (!isPlatformSiteHost((await headers()).get("host"))) notFound();
  const kits = Object.values(KITS);

  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Theme kits</h1>
      <p className="mt-3 max-w-xl text-zinc-600">
        A kit is a complete look — colors, type, surfaces, starter content — applied as a draft and published
        when you're ready. Kits are version-pinned: your store never restyles without you.
      </p>

      <div className="mt-10 grid gap-5 sm:grid-cols-2">
        {kits.map((k) => (
          <div key={k.id} className="overflow-hidden rounded-2xl border border-zinc-200">
            <div className="flex h-28 items-center gap-3 px-6" style={{ background: k.id === "glow" ? "#fffbf7" : "#0a0a0b" }}>
              {k.swatch.map((c) => (
                <span key={c} className="h-10 w-10 rounded-full border border-black/10" style={{ background: c }} />
              ))}
              <span className="ml-auto font-serif text-2xl font-bold" style={{ color: k.id === "glow" ? "#1c1917" : "#fff", fontFamily: k.fonts.display === "serif" ? "Georgia, serif" : "inherit" }}>
                {k.label}
              </span>
            </div>
            <div className="p-5">
              <p className="flex items-center gap-2 font-bold">
                {k.label} <span className="rounded bg-lime-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-lime-700">available · v{k.version}</span>
              </p>
              <p className="mt-1 text-sm text-zinc-500">{k.vertical}</p>
              <p className="mt-2 text-sm text-zinc-600">{k.description}</p>
            </div>
          </div>
        ))}
        {PLANNED.map((k) => (
          <div key={k.label} className="rounded-2xl border border-dashed border-zinc-300 p-5">
            <p className="flex items-center gap-2 font-bold text-zinc-500">
              {k.label} <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-zinc-500">planned</span>
            </p>
            <p className="mt-1 text-sm text-zinc-400">{k.vertical} — not built yet; this card is the whole promise.</p>
          </div>
        ))}
      </div>

      <p className="mt-8 text-sm text-zinc-500">
        Want a vertical we haven&rsquo;t built? <Link href="/contact" className="font-medium text-lime-700 underline">Tell us</Link> — kits are how we grow.
      </p>
    </div>
  );
}
