import { Inbox, Lock, RotateCcw, TriangleAlert } from "lucide-react";
import { cx } from "./cx";
import { Button } from "./Button";

// Small console pieces (S50): skeletons, empty/error/permission states,
// key-value lists, stat cards. Hook-free (client pieces live elsewhere).
// House rule: `return null` while loading or on error is BANNED — render
// one of these instead.

export function Skeleton({ className = "" }) {
  return <div className={cx("rounded bg-surface-sunken motion-safe:animate-pulse", className)} aria-hidden />;
}

export function SkeletonText({ lines = 3, className = "" }) {
  return (
    <div className={cx("space-y-2", className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cx("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

export function EmptyState({ icon = null, title, body, action, className = "" }) {
  return (
    <div className={cx("flex flex-col items-center gap-1.5 py-10 text-center", className)}>
      <span className="text-fg-subtle">{icon || <Inbox size={20} aria-hidden />}</span>
      <p className="text-sm font-medium text-fg">{title}</p>
      {body && <p className="max-w-sm text-xs text-fg-muted">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "Couldn't load this", detail, onRetry, className = "" }) {
  return (
    <div className={cx("flex flex-col items-center gap-1.5 py-10 text-center", className)} role="alert">
      <TriangleAlert size={20} className="text-danger" aria-hidden />
      <p className="text-sm font-medium text-fg">{title}</p>
      {detail && <p className="max-w-sm text-xs text-fg-muted">{detail}</p>}
      {onRetry && (
        <Button size="sm" icon={<RotateCcw size={13} aria-hidden />} onClick={onRetry} className="mt-2">
          Try again
        </Button>
      )}
    </div>
  );
}

// Honest denial, consistently worded. `need` is human copy ("change settings").
export function PermissionNote({ role, need, className = "" }) {
  return (
    <div className={cx("flex items-center gap-2 rounded-ctl bg-surface-sunken px-3.5 py-2.5 text-xs text-fg-muted", className)}>
      <Lock size={13} className="shrink-0" aria-hidden />
      <span>
        Your role{role ? ` (${role})` : ""} can&rsquo;t {need || "view this section"} — ask an owner or admin.
      </span>
    </div>
  );
}

export function KeyValue({ items, className = "" }) {
  return (
    <dl className={cx("grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm", className)}>
      {items
        .filter((i) => i && i.value != null && i.value !== "")
        .map((i) => (
          <div key={i.key} className="contents">
            <dt className="text-fg-muted">{i.key}</dt>
            <dd className={cx("min-w-0 break-words text-fg", i.mono && "font-mono text-xs leading-5")}>{i.value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function Stat({ label, value, sub, tone, className = "" }) {
  return (
    <div className={cx("rounded-card border border-edge bg-surface p-4 shadow-card", className)}>
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <p className={cx("mt-1 text-2xl font-semibold tracking-tight tabular-nums", tone === "danger" ? "text-danger" : tone === "muted" ? "text-fg-subtle" : "text-fg")}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-fg-subtle">{sub}</p>}
    </div>
  );
}
