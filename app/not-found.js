import Link from "next/link";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
      <p className="text-6xl font-extrabold tracking-tight text-zinc-200">404</p>
      <h1 className="mt-4 text-2xl font-bold">That page has left the gym</h1>
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
