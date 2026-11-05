# GEN-04: the brand step (logo, curated palette, one-line description)

Requirement note for GEN-04 in phase 6. Built server side by P6-BRAND (`lib/first-run/brand-step.js`, `GET`/`POST /api/admin/brand-step`); the screen is P6-START-UI's (batch 3), and the drill is P6-DRILLS stage B. The item packet is `docs/cms-reviews/P6-BRAND.md`.

## What the founder can do

On "Start your store" (`/admin/start`), a documents store's founder:
- picks one of six curated palettes (Ink, Slate, Navy, Stone, Forest, Clay; `lib/themes/palettes.js`). The current one is preselected: the palette the design draft draws as, or Slate when the store has no design yet. A founder who made their own colours sees nothing preselected;
- adds a logo from their own media library (alt text optional; an empty alt falls back to the store name when it renders), or removes it ("Remove logo");
- writes a one-line description of at most 160 characters;
- saves, or skips the step.

## Where each part goes

| Part | Stored in | Shows to shoppers |
|---|---|---|
| Palette (colours) | the `doc_design` **draft** (`settings.brand`, a copy of the palette's brand) | after the next Publish (on a closed store, the first Publish opens it) |
| Logo | the `doc_design` **draft** (`settings.logo`, `{ media, alt? }`, a library file only) | after the next Publish |
| Look (theme) | kept as it is; the palette's kit (Pulse) only when the design has none | after the next Publish |
| Description | `config.site.tagline` (control plane), the same field Settings writes | **at once** (see the known limit) |
| The step's record | `config.onboarding.brand_step = { at, skipped, paletteId }` | never |

The design draft is written under the founder's own actor, so the first-run generator skips it from then on (reason `founder`). The brand step never publishes.

The description and the record go in **one** control-plane write that merges into the latest tenant config, so a checklist check-off (`onboarding.manual`) written just before is kept. The description needs the same permission Settings needs for `config.site` (`settings.write`: owners and admins). Staff can save colours and the logo, but not a changed description.

Skip writes no document. It records `{ at, skipped: true }` and keeps a palette an earlier save recorded, so the design settings' Reset (P6-NAV, owner answer OQ-P6-8) still goes back to the founder's chosen palette (`startingPaletteId`).

## Why 160 characters

Settings allows 300 for the tagline. The brand step asks for a one-line description, so it is stricter on purpose. A tagline over 160 that was set in Settings is shown unchanged and kept, unless the founder edits it here.

## Known limits

- **The description is public at once (OQ-04).** `config.site.tagline` has no draft: like every Settings field, it is live as soon as it is saved. On an **open** store a shopper sees the new description right away, while the colours and logo wait for Publish. The step's answer says so (`liveNow: ['description']`), so the screen can say "Your description shows now. Colours and logo show after you publish." On a **closed** store the pages don't show it: the closed page (StoreClosed) shows only the store's name, and the closed metadata (`app/(storefront)/layout.js`) is neutral ("Opening soon.", not indexed, no manifest link).
- **One exception found while building this (not fixed here: the file is not P6-BRAND's).** `app/manifest.webmanifest/route.js` answers `description: siteTagline()` whether or not the store is closed. The closed layout doesn't link the manifest, so a shopper's browser doesn't fetch it, but anyone who opens `/manifest.webmanifest` on a closed store reads the description. This was already true of a tagline saved in Settings; the brand step makes it more likely, because it asks for a description before the store opens. Suggested fix for a later item: the manifest answers the neutral `Shop <name> — fast.` (or no description) while `isStoreClosed()` is true, with a test next to test-release-readers' closed-manifest test. Until then the brand step's "Nothing shows to shoppers until you open your store" is true of the pages, not of that file.
- **Legacy stores** are refused (409 `STORE_USES_LEGACY`). Their Brand and Settings screens stay as they are.
- **The logo is a library file only.** An address on another site, another path or a query string is refused by the logo kind; a library address whose file is not in the library is refused too. HEIC is not accepted by the library (no new dependency): an owner check.
- **Checkout keeps the text wordmark** (P6-LOGO-RENDER's known limit).
