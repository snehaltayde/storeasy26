import { cn } from "@/components/ui/utils";

// A page's title row (docs/UI.md "Components"): an optional breadcrumb, the
// title (1.375rem, 600), one sentence of description, and the page's actions
// on the right (they wrap under the title on phones).
// breadcrumb: [{ label, href? }] (the last item is the current page, no link).
// Breadcrumb links are reads, so they carry data-read-control (support's
// stray-control rule on a new-UI route, scripts/drills/shell/run.mjs).
export function PageHeader({ title, description = null, breadcrumb = null, actions = null, className }) {
  return (
    <header data-kit="page-header" className={cn("mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0 space-y-1">
        {breadcrumb?.length > 0 && (
          <nav aria-label="Breadcrumb">
            <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              {breadcrumb.map((b, i) => {
                const last = i === breadcrumb.length - 1;
                return (
                  <li key={`${i}-${b.label}`} className="flex items-center gap-1">
                    {b.href && !last ? (
                      <a href={b.href} data-read-control className="rounded-md hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                        {b.label}
                      </a>
                    ) : (
                      <span aria-current={last ? "page" : undefined}>{b.label}</span>
                    )}
                    {!last && <span aria-hidden>/</span>}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
        <h1 className="truncate text-[1.375rem] leading-tight font-semibold text-foreground">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div data-kit="page-actions" className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
