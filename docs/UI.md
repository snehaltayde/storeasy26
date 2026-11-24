# UI

This project has its own look. It does not imitate another product and does not ship a
component library's default styling.

This page covers the **consoles** (`/admin`, `/platform`, onboarding). They are built from shadcn/ui components copied into `components/ui/` and restyled with the tokens below. The **storefront** is not covered here: it is drawn from each store's own brand tokens (`app/globals.css`, `--sf-*`, the design document) and never uses shadcn or these console tokens.

## Type

- **Families:** Geist Sans for everything (already loaded by `app/(console)/layout.js`); Geist Mono for numbers that line up (money in tables, order numbers, ids, counts).
- **Scale (rem):** 0.75 caption · 0.8125 small and table text · 0.875 body (the console default) · 1 emphasised body · 1.125 section title · 1.375 page title · 1.75 onboarding headline only.
- **Weights:** 400 body, 500 labels, buttons and table headers, 600 page and section titles. No 700+.
- **Rules:** sentence case everywhere; numbers in tables are right-aligned and tabular; uppercase only for tiny status labels, with 0.04em letter spacing.

## Color

Tokens live as CSS variables in `app/console.css` under `.console` (light) and `.console.dark` (dark) and are mapped to shadcn's names (`--background`, `--primary`, `--sidebar-*`, …). Components use tokens, never raw values.

- **Where `.console` goes:** on the console root `<body>`, not `<html>`: Radix portals (menus, sheets, tooltips) mount into `body`, and on `<html>` the storefront's later `:root { --background }` in `app/globals.css` would win.
- **Dark mode is class-based:** `.console.dark` on the same `<body>`. The `dark:` variant matches only inside `.console.dark`, never on the storefront. There is no toggle yet.
- **Old screens (`data-legacy`):** `--c-surface`, `--c-border`, `--c-accent`, the four status names, `--primary` and `--ring` are also the old `[data-console]` tokens. Every old screen sits in a `data-legacy` region (`<div data-legacy className="contents">`, no box of its own): the shell's `main`, `admin/(auth)/layout.js`, `platform/layout.js`, the roots of `app/(console)/error.js` and `not-found.js`, and the Toast viewport. In `app/console.css`, `.console [data-legacy]` shares the old block with `[data-console]`, restores `globals.css`'s `--background`/`--foreground`, the old line height and text colour, and keeps borders at `currentcolor`, so an old screen looks exactly as before (`pnpm drill:console-styles` proves it). New UI is never put inside a `data-legacy` region; the Phase 2 line that retires the old screens removes the wrapper.
- **Warning as text:** measured (WCAG 2.x, oklch → sRGB): light `--c-warning` is 2.97:1 on `--c-surface`, 2.85:1 on `--c-bg`, 2.66:1 on `--c-sunken`, so it is for fills, borders and icons only. Warning *text* uses `--c-warning-text` (light 5.71 / 5.48 / 5.11:1, and 4.77:1 on a 10% warning tint; dark keeps the warning value, 9.3:1 or more). In classes: `text-warning-text`.
- **Measured contrast of the other text tokens:** `--c-muted` light 6.00 / 5.77 / 5.38:1 on surface / bg / sunken, dark 6.63 / 7.15 / 7.36:1; success, danger and info are 4.65:1 or more on every light surface. The primary button's hover darkens the accent (mix 15% `--foreground`) instead of fading it: `bg-primary/80` would drop white text to about 5.4:1 and lightens towards the page.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--c-bg` | `oklch(98.6% 0.003 95)` (warm paper) | `oklch(17% 0.006 270)` | Page background |
| `--c-surface` | `oklch(100% 0 0)` | `oklch(21% 0.007 270)` | Cards, panels, dialogs |
| `--c-sunken` | `oklch(96.2% 0.004 95)` | `oklch(15% 0.006 270)` | Sidebar, table header, inputs' resting fill |
| `--c-text` | `oklch(22% 0.01 270)` | `oklch(95% 0.004 95)` | Body and titles |
| `--c-muted` | `oklch(50% 0.012 270)` | `oklch(70% 0.01 270)` | Secondary text, hints |
| `--c-border` | `oklch(91% 0.005 95)` | `oklch(30% 0.008 270)` | Lines and outlines |
| `--c-accent` | `oklch(39% 0.09 160)` (deep green) | `oklch(78% 0.13 155)` | Primary buttons, links, focus ring, selected nav |
| `--c-accent-fg` | `oklch(99% 0 0)` | `oklch(18% 0.02 160)` | Text on the accent |
| `--c-success` | `oklch(52% 0.13 150)` | `oklch(75% 0.14 150)` | Paid, published, done |
| `--c-warning` | `oklch(68% 0.15 70)` | `oklch(80% 0.14 75)` | Fills, borders and icons for needs attention, draft changes; never text |
| `--c-warning-text` | `oklch(52% 0.12 62)` | `oklch(80% 0.14 75)` | Warning text and labels (≥ 4.5:1 on every surface) |
| `--c-danger` | `oklch(53% 0.19 27)` | `oklch(70% 0.17 25)` | Destructive actions, failed |
| `--c-info` | `oklch(52% 0.11 245)` | `oklch(74% 0.11 245)` | Neutral notices, in progress |

The Storeasy lime (`#84cc16`) is the platform's logo mark only; it is never a console UI colour and never a store's default.

## Spacing and layout

- **Scale (px):** 4, 8, 12, 16, 24, 32, 48, 64. Nothing in between.
- **Shell:** a 240px sidebar (collapses to icons below 1024px, to a sheet below 768px), a 56px top bar with the store switcher and the account menu, content max width 1200px with 24px gutters (16px on phones).
- **Onboarding:** no sidebar; one centred column, max width 640px, with the step list on the left from 1024px up. The current step's panel is the page's only card and holds its one primary action ("Next: …", "Go to <the step it waits for>" on a blocked step, "Go to your dashboard" once all four are done); the welcome block above it is flat, like the signup screens. A step that still shows an old screen (`data-legacy`, Brand until its line rebuilds it; Import is rebuilt in line 5 and has no tray) puts it on a `bg-muted` tray inside the panel, so the old cards read as content, not a second page.
- **Density:** tables use 40px rows on desktop and 48px on touch; forms use one column below 768px and at most two above. Menu items and sidebar links grow to at least 40px on a coarse pointer (`pointer-coarse:`).
- **The merchant shell (Phase 0 line 8):** `components/admin/shell/AdminShell.js`, built from `components/ui` only. A "Skip to content" link first; the sidebar (`cookiePath="/admin"`, the `sidebar_state` cookie read on the server for `defaultOpen`) with the Storeasy mark (the lime logo) and the nav groups Overview, Orders, Catalog, Storefront, Growth, Store, each item an icon, a label and a badge where one applies (open returns on Orders, setup progress on Setup, a warning dot on Publishing); the current item gets `aria-current="page"` by longest path prefix. The 56px top bar holds the sidebar toggle, the store switcher (DropdownMenu radio group of the caller's own stores, always shown, plus "Open storefront"), the read-only label for support ("Read-only access", or "Platform support access · read-only" for an operator) and the account menu (name, email, role in plain words, a read-only note for support, Sign out). The support-access and incident notices sit at the top of the content area. The nav model is `lib/admin/nav.js`: the server sends only the items `roleAllows`; hidden, never disabled. Group labels are sentence case. Editor routes keep the shell out of the way: no sidebar or top bar, the nav opens in a sheet (`useConsoleNav`, `ConsolePageFrame`).
- **Sidebar behaviour:** expanded at 1024px and up (the founder's toggle and `⌘B` persist in a cookie); 768–1023px it opens as icons with tooltips, and the toggle expands it for that visit only; below 768px it is a sheet. The 56px top bar is the shell's (line 8), not a `components/ui` part.
- **Motion:** every transition and animation in `components/ui` stops under `prefers-reduced-motion` (`motion-reduce:` / `motion-safe:`).
- **Radius:** 6px controls, 10px cards and dialogs, full for pills and avatars. In classes: `rounded-md` (6px, Tailwind's own) for controls, `rounded-card` (10px, `app/console.css`) for cards, popovers, menus, sheets and dialogs (tooltips are small labels and stay `rounded-md`), `rounded-full` for pills and avatars. The `--radius-*` scale is not overridden. Shadows: `shadow-card` at rest, `shadow-overlay` for menus and sheets.

## Components

- **From shadcn, restyled:** Button, Input, Textarea, Select, Checkbox, Switch, RadioGroup, Label, Form (react-hook-form + zod for validation messages), Dialog, AlertDialog (every destructive action), Sheet, DropdownMenu, Command (store switcher and search), Tabs, Table, Badge, Card, Tooltip, Popover, Skeleton, Separator, Sonner toasts, Sidebar.
- **Our own, built from those:** `PageHeader` (title, description, primary action), `StatusBadge` (maps a domain status to a status colour and plain word), `EmptyState` (one sentence and one action), `DataTable` (sort, filter, paginate, row actions), `StepList` (onboarding progress), `MoneyCell`, `RoleGate` (hides a control the role cannot use and shows the reason on hover).
- **Installed so far (Phase 0 line 7):** Button, Input, Separator, Skeleton, Tooltip, Sheet, DropdownMenu, Avatar, Sidebar (plus the `use-mobile` hook and `cn`), in `components/ui/`. Dialog arrived with Phase 1 line 7 (onboarding step 4's "Open your store"). The rest of the list above arrives with the first screen that needs it. **Command** (the store switcher and `⌘K`) is deferred with `cmdk`; Sonner and Form (react-hook-form + zod) are deferred too. How to add one: `components/ui/README.md` (generate in a scratch project, never run the shadcn CLI in this repo). **Phase 1 line 8 adds** Table, Badge (plus status tones `success`, `warning`, `danger`, `info`, `muted`: a tint with the status colour as text; warning text is `text-warning-text`), Textarea, Label and AlertDialog (shadcn 4.23.0), first used by the operator's `/platform/onboarding` screen. That screen is the first operator screen on `components/ui`: `app/(console)/platform/layout.js` is a pass-through and the old operator screens carry their own `data-legacy` region (`page.js`, `loading.js`, `error.js`).
- **When to add one:** only when the same arrangement appears on three screens. Otherwise compose in the screen.
- **Words:** plain sentences, no error codes on screen, every refusal says what to do next. Buttons say what they do ("Publish home page", not "Submit").

## States

Every screen is designed for: loading, empty, error, populated, crowded, and the
least-trusted role's view where that role can reach it. Keyboard behaviour is part of the
design.

- **Loading:** Skeletons shaped like the content, never a lone spinner for more than a button.
- **Empty:** `EmptyState` with the next step; on a brand-new store it points back to onboarding.
- **Error:** what went wrong in plain words, a "Try again", and nothing already typed is lost.
- **Crowded:** tables paginate at 50 rows and keep the header and actions visible; long names truncate with the full name in a tooltip.
- **Support role:** write controls are hidden or disabled with the reason; the page never shows a button that will be refused.
- **Keyboard:** every action reachable by Tab, visible focus ring in `--c-accent`, Esc closes dialogs and sheets, `⌘K` opens the command menu.
