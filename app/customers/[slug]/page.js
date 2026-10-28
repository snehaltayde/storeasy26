import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isPlatformSiteHost } from "@/lib/platform-site";
import { platformConfigured } from "@/lib/platform/control";

// Case study (S48 / MK06) — marketing host only, published-and-gated only.
// Layout keeps measured results, method, limitations and confounders as
// first-class sections: the numbers never appear without their context.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function load(slug) {
  if (!platformConfigured()) return null;
  const { getCaseStudy } = await import("@/lib/platform/case-studies.js");
  return getCaseStudy(slug); // publishedOnly by default
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const s = await load(slug);
  return { title: s ? s.title : "Customer stories" };
}

export default async function CaseStudyPage({ params }) {
  if (!isPlatformSiteHost((await headers()).get("host"))) notFound();
  const { slug } = await params;
  const s = await load(slug);
  if (!s) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <p className="text-xs font-bold uppercase tracking-widest text-zinc-400">Customer story</p>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">{s.title}</h1>
      <p className="mt-2 text-xs text-zinc-400">Published with the merchant&rsquo;s documented permission ({s.consent_ref}).</p>

      {s.body && <p className="mt-6 whitespace-pre-line text-zinc-700">{s.body}</p>}

      <section className="mt-8 rounded-2xl border border-zinc-200 p-5">
        <h2 className="text-sm font-bold">Measured results</h2>
        <p className="mt-0.5 text-xs text-zinc-400">
          Period: {s.period} · Method: {s.method}
          {s.baseline ? ` · Baseline: ${s.baseline}` : ""}
        </p>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-400">
              <th className="py-1 font-medium">metric</th>
              <th className="font-medium">before</th>
              <th className="font-medium">after</th>
            </tr>
          </thead>
          <tbody>
            {s.results.map((r, i) => (
              <tr key={i} className="border-t border-zinc-100">
                <td className="py-1.5 font-semibold">{r.metric}</td>
                <td>{r.before}</td>
                <td>{r.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-4 rounded-2xl bg-zinc-50 p-5 text-sm">
        <h2 className="text-sm font-bold">What to keep in mind</h2>
        <p className="mt-2 text-zinc-600">
          <strong>Limitations:</strong> {s.limitations}
        </p>
        <p className="mt-1 text-zinc-600">
          <strong>What else changed in this period:</strong> {s.confounders}
        </p>
        <p className="mt-2 text-xs text-zinc-400">One store's measured outcome over one period — not a promise of yours.</p>
      </section>

      {s.quote && (
        <blockquote className="mt-8 border-l-4 border-zinc-900 pl-4">
          <p className="text-lg font-medium">“{s.quote}”</p>
          {s.quote_by && <cite className="mt-1 block text-sm not-italic text-zinc-400">— {s.quote_by}, used with permission</cite>}
        </blockquote>
      )}
    </div>
  );
}
