import { cx } from "./cx";
import { humanizeStatus, statusTone } from "./status";

// Console badges (S50): 11px medium chips (the 10px-bold-uppercase chip is
// retired). StatusBadge humanizes labels and keeps the raw status on title.
// Hook-free.

const TONES = {
  neutral: "bg-surface-sunken text-fg-muted",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
  info: "bg-info-bg text-info",
  accent: "bg-caccent-bg text-caccent",
};

export function Badge({ tone = "neutral", className = "", title, children }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium", TONES[tone] || TONES.neutral, className)}>
      {children}
    </span>
  );
}

export function StatusBadge({ status, label, className = "" }) {
  return (
    <Badge tone={statusTone(status)} title={String(status)} className={className}>
      {label || humanizeStatus(status)}
    </Badge>
  );
}
