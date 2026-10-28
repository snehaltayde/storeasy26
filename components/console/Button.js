import { Loader2 } from "lucide-react";
import { cx } from "./cx";

// Console buttons (S50). One vocabulary for every console:
//   primary   — the page's main action (near-black; lime is NEVER a button)
//   secondary — ordinary actions
//   ghost     — low-emphasis inline actions
//   danger    — confirmed destructive actions (solid red)
//   dangerOutline — destructive entry points that still open a confirm step
// `busy` disables, shows a spinner and sets aria-busy; the CALLER owns the
// busy state. Hook-free, so server components may render these too.

const VARIANTS = {
  primary: "bg-primary text-primary-fg hover:bg-primary-hover",
  secondary: "border border-edge-strong bg-surface text-fg hover:bg-surface-muted",
  ghost: "text-fg-muted hover:bg-surface-sunken hover:text-fg",
  danger: "bg-danger text-white hover:opacity-90",
  dangerOutline: "border border-danger-edge bg-surface text-danger hover:bg-danger-bg",
};

const SIZES = {
  sm: "gap-1.5 px-2.5 py-1.5 text-xs",
  md: "gap-2 px-3.5 py-2 text-sm",
};

export function Button({ variant = "secondary", size = "md", busy = false, disabled = false, icon = null, className = "", children, type = "button", ...rest }) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex items-center justify-center rounded-ctl font-medium focus-ring disabled:cursor-not-allowed disabled:opacity-50 motion-safe:transition-colors",
        VARIANTS[variant] || VARIANTS.secondary,
        SIZES[size] || SIZES.md,
        className
      )}
      {...rest}
    >
      {busy ? <Loader2 size={size === "sm" ? 13 : 15} className="motion-safe:animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

// Icon-only button — the accessible name is REQUIRED.
export function IconButton({ label, icon, variant = "ghost", size = "sm", busy = false, disabled = false, className = "", type = "button", ...rest }) {
  if (process.env.NODE_ENV !== "production" && !label) throw new Error("IconButton needs a label (it IS the accessible name)");
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex items-center justify-center rounded-ctl p-1.5 focus-ring disabled:cursor-not-allowed disabled:opacity-50 motion-safe:transition-colors",
        VARIANTS[variant] || VARIANTS.ghost,
        className
      )}
      {...rest}
    >
      {busy ? <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden /> : icon}
    </button>
  );
}
