import { cx } from "./cx";

// Console form controls (S50): ONE input style (replacing the five drifted
// variants, one of which had no focus treatment at all) and ONE Field
// wrapper (replacing the four local Field/F helpers). Hook-free.

const CONTROL =
  "w-full rounded-ctl border border-edge bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus-ring disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-fg-subtle";
const INVALID = "border-danger";

export function Input({ invalid = false, mono = false, className = "", ...rest }) {
  return <input aria-invalid={invalid || undefined} className={cx(CONTROL, invalid && INVALID, mono && "font-mono", className)} {...rest} />;
}

export function Textarea({ invalid = false, mono = false, className = "", ...rest }) {
  return <textarea aria-invalid={invalid || undefined} className={cx(CONTROL, "min-h-20", invalid && INVALID, mono && "font-mono text-xs", className)} {...rest} />;
}

export function Select({ invalid = false, className = "", children, ...rest }) {
  return (
    <select aria-invalid={invalid || undefined} className={cx(CONTROL, invalid && INVALID, className)} {...rest}>
      {children}
    </select>
  );
}

// Field wires label → control (via htmlFor/id you supply) and hint/error →
// an id you can reference with aria-describedby. Hook-free and SSR-stable:
// ids derive only from htmlFor, never from a counter.
export function Field({ label, hint, error, htmlFor, required = false, className = "", children }) {
  const descId = htmlFor && (hint || error) ? `fd-${htmlFor}` : undefined;
  return (
    <div className={cx("min-w-0", className)}>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-fg-muted">
        {label}
        {required && <span className="text-danger"> *</span>}
      </label>
      {children}
      {error ? (
        <p id={descId} className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={descId} className="mt-1 text-xs text-fg-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
