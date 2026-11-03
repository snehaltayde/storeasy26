import Link from "next/link";
import { resolvedContentPage, resolvedContentPageList } from "@/lib/content/resolve";
import { campaignVisible } from "@/lib/cms/store";
import { tfetch } from "@/lib/tenant-request";

// Journal index (S46 / SF20): published, release-governed journal posts —
// scheduled ones (window_start in the future) stay invisible until their
// moment, exactly like every other windowed page.
export const dynamic = "force-dynamic";
export const metadata = { title: "Journal", alternates: { canonical: "/journal" } };

export default async function JournalIndex() {
  const posts = await tfetch(async () => {
    const list = (await resolvedContentPageList()).filter((p) => p.enabled && p.family === "journal");
    const out = [];
    for (const p of list) {
      const page = await resolvedContentPage(p.slug);
      if (page && campaignVisible(page)) out.push({ slug: page.slug, title: page.title, description: page.description, published: page.window_start || null });
    }
    return out.sort((a, b) => String(b.published || "").localeCompare(String(a.published || "")));
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-extrabold tracking-tight">Journal</h1>
      {posts.length === 0 ? (
        <p className="mt-6 text-sf-text-subtle">Nothing published yet — check back soon.</p>
      ) : (
        <ul className="mt-8 space-y-6">
          {posts.map((p) => (
            <li key={p.slug}>
              <Link href={`/journal/${p.slug}`} className="group block">
                <h2 className="font-display text-xl font-bold group-hover:underline">{p.title}</h2>
                {p.description && <p className="mt-1 text-sm text-sf-text-subtle">{p.description}</p>}
                {p.published && (
                  <p className="mt-1 text-xs text-sf-text-faint">
                    {new Date(p.published).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
