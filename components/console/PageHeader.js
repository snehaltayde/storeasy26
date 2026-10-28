import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cx } from "./cx";

// Console page header (S50): consistent title block — 24px semibold title,
// optional description, right-aligned actions, optional breadcrumb for
// detail depth. Hook-free.

export function PageHeader({ title, description, actions, breadcrumb, className = "" }) {
  return (
    <header className={cx("mb-6", className)}>
      {breadcrumb && breadcrumb.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1.5 flex items-center gap-1 text-xs text-fg-muted">
          {breadcrumb.map((b, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={12} aria-hidden />}
              {b.href ? (
                <Link href={b.href} className="rounded focus-ring hover:text-fg hover:underline">
                  {b.label}
                </Link>
              ) : (
                <span className="text-fg">{b.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
