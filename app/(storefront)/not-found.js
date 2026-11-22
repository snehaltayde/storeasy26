import Link from "next/link";
import { requestResolution, tfetch } from "@/lib/tenant-request";
import { siteName } from "@/lib/site";
import ReloadOnSoftNotFound from "@/components/ReloadOnSoftNotFound";

export const metadata = { title: "Page not found" };

// Neutral surface for a gated host — no tenant data, no store links (every
// storefront route on this host is itself gated).
function GatedSurface({ code, title, body }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
      {code ? <p className="text-6xl font-extrabold tracking-tight text-zinc-200">{code}</p> : null}
      <h1 className="mt-4 text-2xl font-bold">{title}</h1>
      <p className="mt-2 text-zinc-500">{body}</p>
    </div>
  );
}

// S25 fail-closed: this page is outcome-aware. On a gated host it renders the
// neutral platform response (inside the layout's bare shell); on a resolved or
// legacy host it stays the store's regular 404.
export default async function NotFound() {
  const r = await requestResolution();
  if (r.outcome === "suspended") {
    // The display name comes from the control-plane tenants row only — safe:
    // no tenant-DB read, no secret decryption.
    return (
      <GatedSurface
        code=""
        title={`${r.name || "This store"} is temporarily unavailable`}
        body="Please check back soon."
      />
    );
  }
  if (r.outcome === "unknown" || r.outcome === "unavailable") {
    return <GatedSurface code="404" title="Store not found" body="There is no store at this address." />;
  }
  // S36 (SF23): tenant-branded 404 — the store's own name, and the accent
  // utilities already follow the tenant's brand variables.
  let name = "";
  try {
    name = await tfetch(() => siteName());
  } catch {
    name = "";
  }
  return (
    <div className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
      <ReloadOnSoftNotFound />
      <p className="text-6xl font-extrabold tracking-tight text-accent-200">404</p>
      <h1 className="mt-4 text-2xl font-bold">This page isn’t on {name ? `${name}’s` : "the"} shelves</h1>
      <p className="mt-2 text-zinc-500">
        The page you're looking for doesn't exist or may have moved.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link
          href="/"
          className="rounded-full bg-zinc-900 px-6 py-3 text-sm font-semibold text-white hover:bg-zinc-800"
        >
          Back to home
        </Link>
        <Link
          href="/collections"
          className="rounded-full border border-zinc-300 px-6 py-3 text-sm font-semibold hover:bg-zinc-50"
        >
          Browse collections
        </Link>
        <Link
          href="/search"
          className="rounded-full border border-zinc-300 px-6 py-3 text-sm font-semibold hover:bg-zinc-50"
        >
          Search products
        </Link>
      </div>
    </div>
  );
}
