import { cx } from "./cx";

// Console cards (S50): the one surface recipe, replacing ~44 hand-rolled
// `rounded-2xl border border-zinc-200 p-5` copies and the local
// Section/Panel helpers. Hook-free.

export function Card({ className = "", as: As = "section", padded = true, id, children }) {
  return (
    <As id={id} className={cx("rounded-card border border-edge bg-surface shadow-card", padded && "p-5", id && "scroll-mt-20", className)}>
      {children}
    </As>
  );
}

export function CardHeader({ title, description, badge, actions, className = "" }) {
  return (
    <div className={cx("mb-4 flex flex-wrap items-start gap-2", className)}>
      <div className="min-w-0 flex-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          {title}
          {badge}
        </h2>
        {description && <p className="mt-0.5 text-xs text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardFooter({ className = "", children }) {
  return <div className={cx("mt-4 flex flex-wrap items-center gap-2 border-t border-edge pt-4", className)}>{children}</div>;
}
