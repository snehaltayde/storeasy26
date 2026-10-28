import { headers } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import { isPlatformSiteHost } from "@/lib/platform-site";
import { platformConfigured } from "@/lib/platform/control";

// Case studies index (S48 / MK06) — marketing host only. Only PUBLISHED
// studies appear, and publishing is gated on documented merchant consent and
// a measurement record; until one exists, the honest state is this empty page.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Customer stories" };

export default async function CustomersPage() {
  if (!isPlatformSiteHost((await headers()).get("host"))) notFound();
  let studies = [];
  if (platformConfigured()) {
    const { listCaseStudies } = await import("@/lib/platform/case-studies.js");
    studies = await listCaseStudies({ publishedOnly: true });
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Customer stories</h1>
      <p className="mt-3 max-w-xl text-zinc-600">
        Every story here is published with the merchant&rsquo;s documented permission, names its measurement period and
        method, and separates measured results from expectations — including what else changed at the same time.
      </p>
      {studies.length === 0 ? (
        <p className="mt-10 rounded-2xl border border-zinc-200 p-6 text-sm text-zinc-500">
          No published stories yet. We only publish case studies with the merchant&rsquo;s written consent and a real
          measurement record behind every number — the first ones are in the works.
        </p>
      ) : (
        <ul className="mt-10 space-y-4">
          {studies.map((s) => (
            <li key={s.slug}>
              <Link href={`/customers/${s.slug}`} className="group block rounded-2xl border border-zinc-200 p-5 hover:border-zinc-400">
                <h2 className="font-display text-xl font-bold group-hover:underline">{s.title}</h2>
                <p className="mt-1 text-xs text-zinc-400">measured over {s.period}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
