# Checks the owner has to run

Each phase of the CMS build adds to this list. These checks need something an agent cannot use: a real phone, Safari, staging, a real Shopify store, a real Razorpay payment, a real inbox, or a decision that is the owner's to make. Checks that desktop Chrome on the design harness can cover are run by agents and recorded in the review packets instead.

The full list goes to the owner when all six phases are done. Each entry names the requirement, what to do, and what a pass looks like.

## Phase 1, batch A

### Page editor (AU-05)
- [ ] **Unclosed tag in a real Shopify description.** On a test store, in Shopify's own admin, end a product description with `< <img src=x onerror=alert(1) `. Pass: the product page shows it as text, no dialog opens, and the page has no image from it. Then try `a <!-- private > note --> b`. Pass: only `a` and `b` show. The harness run covers this with local data; this check covers a real sync.

### Shopify boundary and test gate (SHOP-01 to SHOP-06)
- [ ] **CI gate on GitHub.** Push a branch and watch `.github/workflows/test.yml` pass. Then push a throwaway branch that adds `productUpdate` anywhere in `lib/`. Pass: the run fails on `test:shopify-boundary`. Needs a push, which is yours to do.
- [ ] **Turn on the local hooks.** Decide whether to run `pnpm hooks:enable`. It sets `core.hooksPath`, so every commit and merge runs the whole suite (about 35 seconds) and stops if any suite fails. It was left off on purpose while parallel sessions committed.
- [ ] **OAuth scopes against a dev store.** Run `pnpm shopify:oauth` against a development store. Pass: the scopes it asks for match the one scope list, with no write scopes for products or content.

### Shopper copy (GEN-03)
- [ ] **Checkout with the store's own shipping rates and a real Razorpay test payment.** Pass: the summary and Pay button match the amount charged, for both COD and online payment. You perform the payment.
- [ ] **Sender name on real email, on staging.** Request a sign-in code. Pass: it arrives from the store's name. Repeat with a store name containing a dot (`St. Mark's`) and one in non-English letters. A refused sender would stop that store's sign-in emails.

### Phone photo uploads (MED-01)
- [ ] **A real 5MB phone photo,** from both Storefront > Media and an image field's picker. Pass: it uploads, looks sharp, and keeps its colours (Display P3).
- [ ] **Safari.** A transparent PNG over 1.5MB stays transparent. The same file renamed `.jpg` is handled. A long image (for example a size chart) keeps its size.
- [ ] **HEIC** on iPhone Safari, Mac Safari, desktop Chrome, Android Chrome and the oldest iOS you support. Pass: converted where the browser can, otherwise a plain message and nothing sent.
- [ ] **Sideways photos** on the oldest supported iOS Safari. Pass: they upload the right way up.
- [ ] **Large camera photos on a real iPhone and Android,** including 48MP if available. Pass: the tab does not run out of memory.
- [ ] **One full-size upload on staging.** Pass: it gets through the hosting request limit and the proxy, with a preview.

## Bug-fix branches (not yet merged to main)
- [ ] **Payment confirmation when the database blips** (`claude/gallant-keller-7d3213`). Covered by tests with a simulated database. A real Turso run and a real Razorpay payment are yours.
