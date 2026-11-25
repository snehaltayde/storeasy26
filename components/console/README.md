# Console primitives (S50)

The design system for both consoles (/admin, /platform) before Phase 0
line 8; the new console UI is `components/ui/` and `docs/UI.md`.
Tokens live in `app/console.css`, scoped to `[data-console]` — the console
route group's `<html>` carries the attribute, so tenant brand variables never
re-skin the console and console tokens never touch the storefront.

**Operator console only (Phase 2 line 11).** The merchant console no longer
imports anything here (`pnpm test:no-legacy-ui`). The files left are the ones
the operator console's old screens (`app/(console)/platform/`,
`components/platform/`) still use; they render inside a `data-legacy` region,
where `.console [data-legacy]` in `app/console.css` gives them their old
tokens. Phase 3 rebuilds those screens on `components/ui` and removes this
folder. Toasts moved to `components/kit/toast.js`. Do not add new imports of
these parts.

## House rules

- **Primary action = near-black.** Lime is never a button background and
  never means success (success is emerald). Lime survives only as `caccent`
  (wordmark, CUSTOMIZED chips).
- **States are mandatory.** Every fetching panel renders exactly one of
  loading (Skeleton) / error (ErrorState with retry) / empty (EmptyState) /
  data. `return null` while loading or on error is banned.
- **Toast vs Banner.** Toasts (useToast) = transient action results. Banner =
  anything persistent: validation, 409 conflicts, permission notes, degraded
  states.
- **Destructive = dialog.** ConfirmDialog for ordinary deletes; DangerDialog
  with `typedConfirmation` for offboard-grade actions. No window.confirm/
  prompt anywhere.
- **Busy is the caller's** (Button `busy` prop), except dialogs, which own
  their in-flight state via async `onConfirm`.
- **Icons**: lucide-react only, 13–16px, `aria-hidden` beside text; icon-only
  controls use IconButton (label required). No unicode glyphs as controls.
- **Status chips**: StatusBadge over the one map in `status.js`; humanized
  label, raw status kept on `title`.
- **Type ramp**: page title 24px semibold (each old screen's own h1; the old
  PageHeader is gone, the new one is `components/kit/page-header.js`), section 14px
  semibold (CardHeader), body 14px, supporting 12px, chips 11px medium.
- **Motion** behind `motion-safe:`; focus via the shared `focus-ring`
  utility on every interactive element.
- **Imports**: pure UI only — never `lib/db`, `lib/platform/*`,
  `lib/secrets`, `node:crypto` (test:security enforces this for client
  files).
