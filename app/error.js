"use client";

import Link from "next/link";

// Route-level error boundary — a transient upstream blip (Turso, search)
// should read as "try again", not a stack trace.
export default function Error({ error, reset }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
      <p className="text-6xl font-extrabold tracking-tight text-zinc-200">500</p>
      <h1 className="mt-4 text-2xl font-bold">Something dropped the weights</h1>
      <p className="mt-2 text-zinc-500">
        A temporary error stopped this page from loading. It's usually gone on retry.
      </p>
      {error?.digest && <p className="mt-1 text-xs text-zinc-400">Ref: {error.digest}</p>}
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <button
          onClick={() => reset()}
          className="rounded-full bg-zinc-900 px-6 py-3 text-sm font-semibold text-white hover:bg-zinc-800"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-full border border-zinc-300 px-6 py-3 text-sm font-semibold hover:bg-zinc-50"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
