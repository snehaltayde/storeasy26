// Home page while the store has no products yet (GEN-03). Shoppers read this,
// so it says nothing about setup: the founder's next step lives in the console.
export default function EmptyCatalog() {
  return (
    <section className="py-20">
      <div className="mx-auto max-w-xl rounded-sf-card border border-sf-border bg-sf-surface-muted p-8 text-center">
        <h2 className="text-xl font-bold">New products are on the way</h2>
        <p className="mt-2 text-sm text-sf-text-muted">We&rsquo;re getting things ready. Please check back soon.</p>
      </div>
    </section>
  );
}
