"use client";

// Phase 2 line 6 (6b): the inspector's small parts, built on components/ui,
// with the props the inspector's ~100 call sites already pass (the old
// components/console Button, IconButton, Input, Textarea, Select, Badge and
// Dialog), so each control keeps its behaviour and only its look changes.
//   Button      variant primary | secondary | ghost | danger | dangerOutline,
//               size sm | md, busy (disabled, a spinner, aria-busy), icon
//   IconButton  label (the accessible name and the tooltip), icon
//   Input, Textarea, Select   invalid (aria-invalid), mono; Select is a native
//               <select> (its <option> children and onChange stay as they are)
//   Badge       tone neutral | success | warning | danger | info
//   Dialog      { open, onClose, title, size, footer, children } on the
//               components/ui dialog (Radix: focus trap, Esc closes)
//   Banner, SkeletonText, EmptyState   the old props, on components/ui and
//               components/kit
import { Loader2 } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Badge as UiBadge } from "@/components/ui/badge";
import { Dialog as UiDialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/components/ui/utils";
import { EmptyState as KitEmptyState } from "@/components/kit/empty-state";

const VARIANT = { primary: "default", secondary: "outline", ghost: "ghost", danger: "destructive", dangerOutline: "outline" };

export function Button({ variant = "secondary", size = "md", busy = false, disabled = false, icon = null, className = "", children, type = "button", ...rest }) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-slot="button"
      className={cn(buttonVariants({ variant: VARIANT[variant] || "outline", size: size === "sm" ? "sm" : "default" }), variant === "dangerOutline" && "border-destructive/40 text-destructive", className)}
      {...rest}
    >
      {busy ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, icon, variant = "ghost", busy = false, disabled = false, className = "", type = "button", size: _size, ...rest }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-slot="button"
      className={cn(buttonVariants({ variant: VARIANT[variant] || "ghost", size: "icon-sm" }), className)}
      {...rest}
    >
      {busy ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : icon}
    </button>
  );
}

const CONTROL =
  "w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20";

export function Input({ invalid = false, mono = false, className = "", ...rest }) {
  return <input data-slot="input" aria-invalid={invalid || undefined} className={cn(CONTROL, "h-8", mono && "font-mono", className)} {...rest} />;
}

export function Textarea({ invalid = false, mono = false, className = "", ...rest }) {
  return <textarea data-slot="textarea" aria-invalid={invalid || undefined} className={cn(CONTROL, "min-h-20", mono && "font-mono text-xs", className)} {...rest} />;
}

export function Select({ invalid = false, className = "", children, ...rest }) {
  return (
    <select data-slot="native-select" aria-invalid={invalid || undefined} className={cn(CONTROL, "h-8", className)} {...rest}>
      {children}
    </select>
  );
}

const TONE = { neutral: "muted", success: "success", warning: "warning", danger: "danger", info: "info", accent: "secondary" };
export function Badge({ tone = "neutral", className = "", children, ...rest }) {
  return (
    <UiBadge variant={TONE[tone] || "muted"} className={className} {...rest}>
      {children}
    </UiBadge>
  );
}

const SIZE = { sm: "sm:max-w-sm", md: "sm:max-w-md", lg: "sm:max-w-2xl" };
export function Dialog({ open, onClose, title, size = "md", description = null, children, footer = null }) {
  return (
    <UiDialog open={!!open} onOpenChange={(v) => !v && onClose?.()}>
      {open && (
        <DialogContent className={cn("max-h-[85svh] overflow-y-auto", SIZE[size] || SIZE.md)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
          </DialogHeader>
          <div className="min-w-0">{children}</div>
          {footer && <DialogFooter>{footer}</DialogFooter>}
        </DialogContent>
      )}
    </UiDialog>
  );
}

// A message box: tone info | success | warning | danger, a title, words and
// actions beside them (the old Banner's props)
const BANNER = { info: "border-info/30 bg-info/5", success: "border-success/30 bg-success/5", warning: "border-warning/40 bg-warning/10", danger: "border-destructive/30 bg-destructive/5" };
export function Banner({ tone = "info", title = null, actions = null, className = "", children }) {
  return (
    <div role={tone === "danger" ? "alert" : undefined} className={cn("flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm text-foreground", BANNER[tone] || BANNER.info, className)}>
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={title ? "mt-0.5 text-muted-foreground" : undefined}>{children}</div>}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}

export function SkeletonText({ lines = 3, className = "" }) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

// the kit's empty state with the old props (body is its description)
export const EmptyState = ({ title, body = null, action = null, icon = null, className }) => <KitEmptyState title={title} description={body} action={action} icon={typeof icon === "function" ? icon : null} className={className} />;
