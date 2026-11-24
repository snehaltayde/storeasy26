# components/ui: shadcn/ui for the consoles

These are shadcn/ui components (radix base, `radix-nova` style), copied in and
restyled to `docs/UI.md`. Consoles only: nothing under `app/(storefront)/` or
`proxy.js` may import from here, and no storefront file may use their utility
names (`scripts/test-console-ui.js` checks both).

In here: `button`, `input`, `progress`, `separator`, `skeleton`, `tooltip`, `sheet`, `dialog`,
`dropdown-menu`, `avatar`, `sidebar`, `radio-group`, `label`, the `use-mobile` hook and `utils.js`
(`cn`). Their tokens live in `app/console.css` under `.console` /
`.console.dark`. Add `.console` to the console root `<body>` to use them.

## Never run the shadcn CLI in this repo

It rewrites `app/console.css`, adds dependencies (it now pulls in `cn` and
`shadcn` itself) and writes `.jsx` files. Generate in a scratch project
instead and copy the result in:

1. Outside the repo: a bare Next app (`next`, `react`, `react-dom` at this
   repo's versions; `tailwindcss` and `@tailwindcss/postcss` 4.3.1; a
   `next.config.mjs`, `app/layout.js`, `app/globals.css` with
   `@import "tailwindcss";` and a `jsconfig.json` with `@/*`).
2. `pnpm dlx shadcn@4.23.0 init -b radix -p nova -y --no-monorepo --no-rtl`
   (if the CLI's version changes, record it in `docs/DECISIONS.md`).
3. `pnpm dlx shadcn@4.23.0 add <name> -y -o`.
4. Copy `components/ui/<name>.jsx` here as `<name>.js`; hooks go here too.

## Restyle checklist (each copied file)

- `import { cn } from "@/components/ui/utils"` (not the `cn` package);
  `@/hooks/use-mobile` → `@/components/ui/use-mobile`.
- The CLI's custom variants come from `shadcn/tailwind.css`, which we don't
  import: write `data-[state=open]:`, `data-[state=closed]:`,
  `data-[orientation=horizontal]:`, `data-[orientation=vertical]:`,
  `data-[active=true]:` instead of `data-open:` and friends.
- Radius: controls `rounded-md` (6px); cards, popovers, menus and sheets
  `rounded-card` (10px); pills and avatars `rounded-full`. No
  `rounded-lg`/`xl`, no `rounded-[min(var(--radius-md),…)]`.
- Shadows: `shadow-card` (resting), `shadow-overlay` (menus, sheets); no
  `shadow-sm`/`md`/`lg`.
- Focus: `focus-visible:ring-2 focus-visible:ring-ring
  focus-visible:ring-offset-2 focus-visible:ring-offset-background` (the
  accent ring).
- Weights 500 (`font-medium`) and 600 (`font-semibold`) only;
  `font-heading` → `font-semibold`.
- No raw colours: no hex, `oklch(`, `rgb(`, and no palette utilities
  (`bg-black/10`, `text-white`, `bg-zinc-…`). Use the tokens (`bg-muted`,
  `text-muted-foreground`, `bg-foreground/20` …).
- Overlays (`sheet`, `dialog`, `dropdown-menu`, `tooltip`) get `motion-reduce:animate-none`.
- Every part keeps its `data-slot`. Sheets close on Esc (Radix Dialog's default;
  don't override `onEscapeKeyDown`).
- Then run `node scripts/test-console-ui.js` and `pnpm drill:sf-styles` with
  `SF_STYLES_BASELINE` set to a capture made before the change.
