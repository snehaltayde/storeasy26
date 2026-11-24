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
- **Legacy names:** `--c-surface`, `--c-border`, `--c-accent` and the four status names are also the legacy `[data-console]` tokens, so a legacy screen under `.console` is re-skinned; the console shell (line 8) aliases them first.
- **Warning as text:** `--c-warning` on white is likely below 4.5:1 (estimated ~2.9:1, unmeasured); use it for fills and icons, and measure before using it for text.

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
| `--c-warning` | `oklch(68% 0.15 70)` | `oklch(80% 0.14 75)` | Needs attention, draft changes |
| `--c-danger` | `oklch(53% 0.19 27)` | `oklch(70% 0.17 25)` | Destructive actions, failed |
| `--c-info` | `oklch(52% 0.11 245)` | `oklch(74% 0.11 245)` | Neutral notices, in progress |

The Storeasy lime (`#84cc16`) is the platform's logo mark only; it is never a console UI colour and never a store's default.

## Spacing and layout

- **Scale (px):** 4, 8, 12, 16, 24, 32, 48, 64. Nothing in between.
- **Shell:** a 240px sidebar (collapses to icons below 1024px, to a sheet below 768px), a 56px top bar with the store switcher and the account menu, content max width 1200px with 24px gutters (16px on phones).
- **Onboarding:** no sidebar; one centred column, max width 640px, with the step list on the left from 1024px up.
- **Density:** tables use 40px rows on desktop and 48px on touch; forms use one column below 768px and at most two above.
- **Radius:** 6px controls, 10px cards and dialogs, full for pills and avatars. In classes: `rounded-md` (6px, Tailwind's own) for controls, `rounded-card` (10px, `app/console.css`) for cards, popovers, menus, sheets and dialogs, `rounded-full` for pills and avatars. The `--radius-*` scale is not overridden. Shadows: `shadow-card` at rest, `shadow-overlay` for menus and sheets.

## Components

- **From shadcn, restyled:** Button, Input, Textarea, Select, Checkbox, Switch, RadioGroup, Label, Form (react-hook-form + zod for validation messages), Dialog, AlertDialog (every destructive action), Sheet, DropdownMenu, Command (store switcher and search), Tabs, Table, Badge, Card, Tooltip, Popover, Skeleton, Separator, Sonner toasts, Sidebar.
- **Our own, built from those:** `PageHeader` (title, description, primary action), `StatusBadge` (maps a domain status to a status colour and plain word), `EmptyState` (one sentence and one action), `DataTable` (sort, filter, paginate, row actions), `StepList` (onboarding progress), `MoneyCell`, `RoleGate` (hides a control the role cannot use and shows the reason on hover).
- **Installed so far (Phase 0 line 7):** Button, Input, Separator, Skeleton, Tooltip, Sheet, DropdownMenu, Avatar, Sidebar (plus the `use-mobile` hook and `cn`), in `components/ui/`. The rest of the list above arrives with the first screen that needs it. **Command** (the store switcher and `⌘K`) is deferred with `cmdk`; Sonner, Form (react-hook-form + zod), Dialog and Table are deferred too. How to add one: `components/ui/README.md` (generate in a scratch project, never run the shadcn CLI in this repo).
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
