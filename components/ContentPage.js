import Link from "next/link";
import FaqSection from "./FaqSection";

// Shared renderer for store content/policy pages. S38 (SF13): sections are
// typed — text (heading + paragraphs), rich (html, allowlist-sanitized at
// save) and image (library/https src). Legacy sections without a kind render
// as text. SF14: an effective date renders under the title. S39: faq sections
// (keyboard accordions + deep links) and `children` (e.g. the contact form).
export default function ContentPage({ page, legalName = "", children = null }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <nav className="mb-6 text-sm text-zinc-400">
        <Link href="/" className="hover:text-zinc-600">
          Home
        </Link>{" "}
        / <span className="text-zinc-600">{page.title}</span>
      </nav>
      <h1 className="text-3xl font-extrabold tracking-tight">{page.title}</h1>
      {page.effective_at ? (
        <p className="mt-2 text-sm text-zinc-400">
          Effective from{" "}
          {new Date(`${page.effective_at}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}
        </p>
      ) : null}
      <div className="mt-8 space-y-8">
        {page.sections.map((s, idx) => {
          const kind = s.kind || "text";
          if (kind === "rich") {
            return (
              <section key={idx}>
                {s.heading ? <h2 className="text-lg font-bold text-zinc-900">{s.heading}</h2> : null}
                <div className="rte mt-2 text-zinc-600" dangerouslySetInnerHTML={{ __html: s.html || "" }} />
              </section>
            );
          }
          if (kind === "faq") {
            return <FaqSection key={idx} heading={s.heading} items={s.items || []} />;
          }
          if (kind === "image") {
            return (
              <figure key={idx}>
                {/* library images are same-origin, arbitrary https allowed too — plain <img>, not next/image */}
                <img src={s.src} alt={s.alt || ""} className="w-full rounded-brand" loading="lazy" />
                {s.caption ? <figcaption className="mt-2 text-center text-sm text-zinc-400">{s.caption}</figcaption> : null}
              </figure>
            );
          }
          return (
            <section key={idx}>
              <h2 className="text-lg font-bold text-zinc-900">{s.heading}</h2>
              <div className="mt-2 space-y-3">
                {(s.body || []).map((p, i) => (
                  <p key={i} className="leading-relaxed text-zinc-600">
                    {p}
                  </p>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {children}
      <p className="mt-12 border-t border-zinc-100 pt-6 text-xs text-zinc-400">
        {legalName ? `Operated by ${legalName} · ` : ""}Questions?{" "}
        <Link href="/contact" className="underline hover:text-zinc-600">
          Contact us
        </Link>
      </p>
    </div>
  );
}
