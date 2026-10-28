// Console 404 (S50): neutral — also where gated hosts land when a console
// page's tenant resolution calls notFound().
export default function ConsoleNotFound() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <div className="w-full rounded-card border border-edge bg-surface p-8 text-center shadow-card">
        <p className="text-sm font-semibold text-fg">404 — not found</p>
        <p className="mt-1 text-sm text-fg-muted">This console page doesn&rsquo;t exist, or this store isn&rsquo;t available here.</p>
      </div>
    </div>
  );
}
