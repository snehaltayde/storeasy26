import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { cx } from "./cx";

// Console banners (S50): persistent inline messages — validation errors,
// conflicts, permission notes, degraded states. (Transient action results
// are toasts; see Toast.js.) Replaces ~7 ad-hoc message patterns. Hook-free.

const TONES = {
  success: { cls: "border-success-edge bg-success-bg text-success", Icon: CircleCheck },
  warning: { cls: "border-warning-edge bg-warning-bg text-warning", Icon: TriangleAlert },
  danger: { cls: "border-danger-edge bg-danger-bg text-danger", Icon: CircleAlert },
  info: { cls: "border-info-edge bg-info-bg text-info", Icon: Info },
  neutral: { cls: "border-edge bg-surface-sunken text-fg-muted", Icon: Info },
};

export function Banner({ tone = "info", title, actions, className = "", children }) {
  const { cls, Icon } = TONES[tone] || TONES.info;
  return (
    <div role={tone === "danger" ? "alert" : undefined} className={cx("flex items-start gap-2.5 rounded-ctl border px-3.5 py-2.5 text-sm", cls, className)}>
      <Icon size={15} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cx(title && "mt-0.5", "text-[13px] leading-snug")}>{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
