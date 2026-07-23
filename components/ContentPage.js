import Link from "next/link";

// Shared renderer for store content/policy pages (lib/content/pages.js shape).
export default function ContentPage({ page }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <nav className="mb-6 text-sm text-zinc-400">
        <Link href="/" className="hover:text-zinc-600">
          Home
        </Link>{" "}
        / <span className="text-zinc-600">{page.title}</span>
      </nav>
      <h1 className="text-3xl font-extrabold tracking-tight">{page.title}</h1>
      <div className="mt-8 space-y-8">
        {page.sections.map((s) => (
          <section key={s.heading}>
            <h2 className="text-lg font-bold text-zinc-900">{s.heading}</h2>
            <div className="mt-2 space-y-3">
              {s.body.map((p, i) => (
                <p key={i} className="leading-relaxed text-zinc-600">
                  {p}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>
      <p className="mt-12 border-t border-zinc-100 pt-6 text-xs text-zinc-400">
        Operated by RAK Fitness Consumer Pvt. Ltd. · Questions?{" "}
        <Link href="/contact" className="underline hover:text-zinc-600">
          Contact us
        </Link>
      </p>
    </div>
  );
}
