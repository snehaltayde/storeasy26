# P6-PALETTE: the six curated palettes (GEN-01, GEN-04, TOK-02)

Branch `cms/p6-palette`, cut from `b063753` (`cms/phase-1` with P5-FIX2 merged at `441b44d` and P5-DRILLS merged at `211c982`, plus the phase 6 plan). Batch 1. Plan: `docs/cms-reviews/P6-PLAN.md` (decision 4, decision 9, owner answer OQ-P6-8) and `P6-BATCHES.json` (item P6-PALETTE). Migrations owned: none.

This is the author's own report. Reviewers should re-read the code.

Files changed (all in the item's list):
- Code: `lib/themes/palettes.js` (new).
- Tests: `scripts/test-tokens.js` (a new section, "P6-PALETTE", 10 tests).
- Docs: this packet.

Not changed: `lib/brand.js`, `lib/themes/kits.js`, `app/globals.css`, `package.json`, `.github/`, `MANUAL-CHECKS.md`, the untracked `docs/CMS_*.md` files and the two named `.claude/worktrees`. No migration, no new dependency. Nothing calls the new module yet: the generator (P6-GEN-WRITE, P6-GEN), the brand step (P6-BRAND), PUB-12's design rule (P6-OPEN) and Reset (P6-NAV) import it in later items.

Safety: no server was started, no database other than the suites' own file databases was used, no store changed mode, `--hosted` was never passed, Typesense was not used, nothing was written to Shopify and no order was placed. The final `pnpm test` ran with every port-taking suite pinned to 6120 and 7120 to 7129; nothing listened on them afterwards.

## Stages

| Stage | State |
|---|---|
| Implemented | Done |
| Locally tested | Done: `pnpm test` **98 of 98 suites in 211.5 s** (exit 0, ports pinned); `test:tokens` 74 passed (10 new); `pnpm build` passes |
| Browser verified | **NOT DONE** and not needed for this item: nothing renders the palettes yet. The brand step and Reset drills are P6-DRILLS stages B and E |
| Staging | **NOT DONE** |

## What and why

GEN-01 says a generated store never uses the lime default: it starts on a neutral curated palette. GEN-04 says the brand step offers a small curated set, and each palette passes the TOK-02 matrix. Owner answer OQ-P6-8 says the design settings' Reset goes back to the store's starting palette, never lime. Every later phase 6 item needs one shared list of palettes and these few helpers, so this item builds them, pure, before anything uses them.

## Design

`lib/themes/palettes.js` has no imports at all (the plan allows `lib/brand.js` constants only; none is needed). So it is edge-safe and can be loaded by the storefront, the console and the Node-only generator.

**PALETTES**, frozen, in this order:

| id | Label | accent | background | foreground (text) | accent_label |
|---|---|---|---|---|---|
| ink | Ink | #18181b | #ffffff | #09090b | #ffffff |
| slate | Slate | #334155 | #ffffff | #0f172a | #ffffff |
| navy | Navy | #1e3a8a | #ffffff | #0f172a | #ffffff |
| stone | Stone | #44403c | #fafaf9 | #1c1917 | #ffffff |
| forest | Forest | #166534 | #fffbf7 | #1c1917 | #0a0a0b |
| clay | Clay | #9a3412 | #fffbf7 | #1c1917 | #0a0a0b |

Every brand also holds the shape keys at the platform's values (`radius: md`, `type_scale: regular`, `button_shape: pill`, `section_spacing: regular`), so it has every key `validateBrand` reads. It also holds the `accent_label` that `validateBrand` works out, so a palette is stored exactly as the editor stores a brand. A test checks `validateBrand(p.brand).value` deep-equals `p.brand`. Every palette's `kit` is `pulse-1` (the platform's look), so a generated store keeps the Pulse header, hero and fonts. The tests prove each palette is also readable on Glow, so a founder who changes the look stays readable.

**Why every palette has its own text colour.** `brandRoles` derives the greys (muted text, faint text, borders, marks) from a brand's own colours only when its background or text differ from the platform's white and `#0a0a0b` (its `neutralDerived` branch). A brand on exactly those two keeps the platform's own greys, whose faint text (2.62:1), marks and placeholders fail the matrix. So the Ink, Slate and Navy palettes use near-black text that is not `#0a0a0b`. A test proves all six take the derived branch, and a negative test shows the same Ink accent on `#ffffff` / `#0a0a0b` fails `text-faint`.

**DEFAULT_PALETTE_ID** is `'slate'`.

**Helpers:**
- `paletteById(id)`: the palette, or null for anything unknown (including `null` and `'toString'`).
- `designBodyFor(paletteId)`: `{ brand, theme }`, a fresh copy each call, with `theme` as `{ kit: 'pulse', version: 1 }` (the shape the theme kind takes and KITS holds; `pulse-1` is only the KIT_SURFACES key). Null for an unknown id.
- `paletteIdOfBrand(brand)`: the id whose brand equals this one, else null. Colours compare without case (validateBrand lowercases them). `accent_label` is worked out from the accent, so a brand without it still matches; if it is there, it must match too. Any other key or value (a changed radius, an extra key) gives null. `DEFAULT_BRAND` gives null.
- `startingPaletteId(onboarding)`: `onboarding.brand_step.paletteId` when it names a known palette, whether the step was saved or skipped; otherwise `'slate'`. Never null, never lime. It takes the tenant's `config.onboarding` (or null) and reads nothing else.
- `isLimeAccent(hex)`: true when the colour's hue is between 65 and 105 degrees, its saturation is 0.3 or more and its lightness is between 0.08 and 0.95. This covers `#84cc16`, `#a3e635`, `#a8eb43`, `#588a0c`, `#456c09` and the whole lime ladder from 200 to 900. Greens such as `#16a34a` and `#166534` (hue about 142) and yellows such as `#eab308` (hue about 45) are not lime. Anything that is not a 6-digit hex gives false.

## Acceptance

| Item | Status | Evidence |
|---|---|---|
| Unit (test-tokens): 6 palettes x each kit pass validateBrand, pairMatrix (no failing pair), checkBrand (0 errors) and publishBlocked false | **Done** | "every palette: validateBrand has no errors…" and "every palette on every kit: the full pairMatrix has no enforced pair below PAIR_NEEDS, checkBrand has 0 errors and 0 issues, publishBlocked is false" (12 cases, both kits in KIT_SURFACES; publishBlocked is also false over each other palette as live). "every palette derives its greys … and the rendered roles are the measured ones" checks the roles the page renders from `brandCssVars` equal `brandRoles`, measures every enforced pair from the rendered roles, and fails if any palette is outside the `neutralDerived` branch. Fails without the change (module missing: 9 tests fail). Mutation: Ink's text set to `#0a0a0b` fails the matrix test and the derived-branch test |
| Unit: isLimeAccent(DEFAULT_BRAND.accent) true, false for every palette accent; paletteIdOfBrand(forest) === 'forest', null for DEFAULT_BRAND | **Done** | "isLimeAccent: …" (also every ladder step of every palette accent is not lime) and "paletteIdOfBrand: …". Mutation: Slate's accent set to `#84cc16` fails the lime test and six others |
| Unit: startingPaletteId cases ('slate' for null, {}, skipped with no id, unknown id; 'forest' saved or skipped); never lime | **Done** | "startingPaletteId: …" (18 cases, plus a frozen input). Mutation: returning any recorded `paletteId` without the known-palette check fails it |
| Unit: designBodyFor('slate') validates through the design document type in draft and publish mode with no issues | **Done** | "designBodyFor('slate') …": `validateDocument({ ...emptyBody('design'), settings })` in both modes, `ok` and 0 issues, for all six palettes. It also checks `theme.kit === KITS.pulse.id` and `theme.version === KITS.pulse.version`. Mutation: `theme: { kit: 'pulse-1' }` fails it |
| Unit: palettes.js imports nothing outside lib/brand.js (static import scan) | **Done** | "palettes.js imports nothing outside lib/brand.js": scans static, re-export and dynamic imports and `require`, and also refuses `process.` and `node:`. Mutation: adding `import { KITS } from "./kits.js"` fails it |
| pnpm test passes | **Done** | 98 of 98 suites, exit 0 (the gate is 98 here; P6-FIXTURE takes it to 102 when it merges) |

## Tests

`scripts/test-tokens.js`, new section "P6-PALETTE: every curated palette on every kit", 10 tests. The module is loaded with a caught dynamic import, so without `palettes.js` each test fails by name (9 of the 10; the negative Ink test needs only `lib/brand.js`) instead of the whole suite crashing.

## Known limits

- **Thin margins by design.** The derived greys aim 0.05 above the line (`brandRoles`' MARGIN), so each palette's closest pair is 4.55 to 4.59 (needs 4.5): `mark` for Slate, Navy, Forest and Clay, `text-subtle-strong` for Ink, `text-faint-sunken` for Stone. That is what every derived brand gets today. A browser's own colour rounding stays inside the margin, but no browser drill measured these palettes (P1-TOK's drill measured the derivation in general).
- **Correction notes.** The dark accents are corrected on dark surfaces: on Pulse the hero highlight (all but Forest and Clay) and, for Ink, the header wordmark move to a lighter shade of the accent. For Ink, Slate, Navy and Stone the accent hover fill also moves, on both kits, so the white button label stays readable. `checkBrand` then returns a plain note ("… so your store uses …, a lighter shade of your accent"). These are notes, not issues: they never block and are not errors, but the editor may show them on a generated store. P6-NAV and P6-BRAND decide whether to show them.
- **One kit.** All six palettes are on `pulse-1`. A Glow store started from a palette is out of scope (no new kit in phase 6); the palettes pass on Glow anyway.
- **paletteIdOfBrand is exact.** A brand saved with a different radius or button shape from the palette is no longer that palette (null), so the brand step preselects nothing for it. That is what "deep-equals" asks for.
- **isLimeAccent is a hue rule.** Very pale (lightness over 0.95) and very dark (under 0.08) yellow-greens are not called lime; nor are greys. Nothing uses it on founder colours yet.
- **Spec evidence.** GEN-01's evidence `lib/brand.js:13` is now `:28` for `DEFAULT_BRAND` (the plan says `:29`; the constant starts on line 28).

From review:

- Test gap in isLimeAccent's 'near shades by hue' rule: narrowing the hue window from 65-105 to 75-95 degrees left all 74 test-tokens tests passing. The tests only check colours whose hue is about 80 to 84 degrees, so nothing pins the stated 65 and 105 edges. A colour such as #808000 (olive, hue 60) is not called lime, and no test says whether it should be. Suggested fix: add test cases just inside and just outside both edges.
- Test gap in the palette kit: changing Ink's kit to 'glow-1' left every test passing. Only slate's kit is checked to be pulse-1, yet the packet says 'All six palettes are on pulse-1'. Suggested fix: assert p.kit === 'pulse-1' for every palette, or drop the claim.
- The packet's 'Correction notes' known limit leaves things out. It speaks of corrections on dark surfaces (Pulse). In fact checkBrand also returns notes on the Glow kit: Slate, Stone, Forest and Clay get 'hero highlight ... a darker shade of your accent', and Forest also gets one for the header wordmark. On Pulse the notes match the packet (Ink 2, Slate, Navy and Stone 1 each, Forest and Clay 0). None of these is a warning or an error. A founder who switches to Glow will see them.
- paletteIdOfBrand is strict, as the brief's 'deep-equals' asks. So a partial stored brand that draws exactly like a palette returns null: for example { accent:'#334155', background:'#ffffff', foreground:'#0f172a' } with no shape keys, which the brand kind allows and validateBrand fills with defaults. P6-BRAND's preselect would then show nothing for it. This is worth noting in P6-BRAND, or comparing validateBrand(brand).value instead.
- startingPaletteId reads brand_step and paletteId through the prototype chain: Object.create({ brand_step: { paletteId: 'navy' } }) gives 'navy'. This does no harm, because tenant config is parsed JSON. paletteById(...).brand is a frozen object: P6-BRAND's brief says 'settings.brand = paletteById(paletteId).brand', so any later code that changes that body in place would throw. designBodyFor already returns copies, so P6-BRAND should use designBodyFor or a spread.
- Verified, no defect: worktree at f7402fd. pnpm test passed 98 of 98 suites in 201.4 s, exit 0, with ports pinned to 6320 and 7320-7329, and nothing was listening on them afterwards. test-tokens passes 74 of 74. With palettes.js removed, 9 tests fail. With Ink's text set to #0a0a0b, the matrix test and the neutralDerived test fail. These mutations were each caught: saturation and lightness bounds, the accent_label skip, case folding, DEFAULT_PALETTE_ID='navy', Skip dropping the paletteId, a wrong Forest accent_label, a missing shape key, and designBodyFor's brand. Two surviving mutations do the same thing as the original code (the grey guard, and the extra-key check), so they are not test gaps. Every palette's closest pair is 4.55-4.59 against 4.5 on both kits, with 0 errors, 0 warnings and 0 issues. The module has no imports and no node: or process use, and nothing imports it yet, so legacy tenants, releases, editors and preview are unchanged. The diff touches only lib/themes/palettes.js, scripts/test-tokens.js and docs/cms-reviews/P6-PALETTE.md. Both required merges (441b44d P5-FIX2, 211c982 P5-DRILLS) are in base b063753. The review worktree was removed.

## Owner checks

- **Look at the six palettes on a phone and on desktop** once P6-BRAND's brand step exists (P6-DRILLS stage B): are the labels and colours the ones you want founders to see? The colours are the plan's probed values; only the text colours of Ink, Slate and Navy were chosen here (`#09090b`, `#0f172a`, `#0f172a`).
- **Forest and Clay buttons use near-black text** on a lighter shade of the accent (validateBrand's choice, the readable one). Check you are happy with how that looks.
