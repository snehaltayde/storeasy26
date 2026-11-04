// PUB-06: what a shopper sees on a store that has never published. Server
// component, no state. The store's name is the only store fact on it: no
// brand, no menus, no catalog, no draft. Neutral look (the layout renders it
// under the default kit with no brand variables). Not the maintenance page:
// it never says "maintenance" or "right back", and has no team sign-in link
// (the team opens the store through a preview session from the console).
// The colours sit on <main>, not <body>: globals.css styles body outside any
// layer, which beats the bg-hero / text-hero-fg utilities there.
export default function StoreClosed({ name }) {
  const store = typeof name === "string" && name.trim() ? name.trim() : "Store";
  return (
    <main className="flex flex-1 flex-col items-center justify-center bg-hero px-6 py-16 text-center text-hero-fg">
      <p className="text-sm font-semibold tracking-wide text-hero-muted">{store}</p>
      <h1 className="mt-4 max-w-xl font-display text-4xl font-extrabold tracking-tight sm:text-5xl">Opening soon</h1>
      <p className="mt-4 max-w-md text-base text-hero-muted">We&apos;re getting the shop ready. Check back soon.</p>
    </main>
  );
}
