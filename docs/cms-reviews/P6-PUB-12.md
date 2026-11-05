# P6 · PUB-12 · Before you open your store: the items, and the first-publish suites

Companion note of P6-OPEN (the item packet is `P6-OPEN.md`). It holds the two lists the brief asks for by name.

## The items

`lib/documents/opening.js` `openingReport` returns every item, ok ones included, in this order:

| # | id | From the spec? | Levels it can take | Its fix when not ok |
|---|---|---|---|---|
| 1 | `payment` | Yes ("no way to pay") | block, info, ok | `/admin/billing`, `/admin/settings#commerce`, `who: 'support'` (Shopify mode), `/admin/settings#payments` (cash on delivery only) |
| 2 | `maintenance` | No: split out of payment (plan decision 7), only while it is on | warn | `who: 'support'` |
| 3 | `privacy` | Yes ("policies") | block, info, ok | "Start a privacy page" action, or "Read it" link plus "I've read it" action, or a link to the saved draft |
| 4 | `returns` | Yes ("policies") | block, info, ok | the same, for the returns page |
| 5 | `test_order` | Yes | warn, ok | `/admin/editor` (the preview) |
| 6 | `catalog` | **No: an addition beyond the spec's three items** | warn, ok | `/admin/settings#catalog-sync` |
| 7 | `contact` | **No: an addition beyond the spec's three items** | warn, ok | `/admin/settings#store-profile` |
| 8 | `design` | No: the left-out design rule (owner answer OQ-P6-1) | info, ok | `/admin/editor?doc=doc_design` |

`catalog` and `contact` are additions beyond the spec's three items (payment, policies, test order). Both are warnings behind the one confirm.

## Every suite that first-publishes a documents store

The gate ran with `CHECKOUT_MODE` unset. With no `checkout_mode` on the tenant, `checkoutMode()` answers `direct` (its default), so rule a passes. None of them sends `checkOpening`, so rules c, d and e do not run. Rule b fires only when an unpublished `doc_design` draft is left out of the opening set; a suite that did that would now fail with OPENING_NEEDS_DESIGN, and none did. So each is unchanged apart from the payment block, and the payment block cannot fire for any of them. Each passed unchanged (see `P6-OPEN.md`, Tests).

| Suite | How it publishes | `checkout_mode` on its tenants |
|---|---|---|
| test-publish-service | the documents API and the publish service | none |
| test-publish-checks | the documents API | none |
| test-publish-undo | the documents API | none |
| test-design-doc | the documents API and the publish service | none |
| test-documents | the documents API | none |
| test-editor-store | the documents API | none |
| test-doc-changes | the documents API | none |
| test-legacy-routes | the documents API and the publish service | none |
| test-provision | the documents API | none |
| test-schema-compat | the documents API (`pre23`) | none on `pre23`. Its fixture stores (`direct`, and its `disabled` case) check the capability only and never publish |
| test-failure-matrix | the documents API (`docs`) | none. The new `closed` rows set `disabled` inside their own row only |
| test-media-refs | the publish service | none |
| test-migrate-reverse | the publish service | none |
| test-product-content | the documents API and the publish service | none |
| test-product-editor | the documents API | none |
| test-preview-frame | the publish service | none |
| test-sections-render | the publish service | none |
| test-search-effective | the documents API and the publish service | none |
| test-commerce | the publish service, store `cp` (P3-FIX1) | none. Its `disabled` and `shopify` tenants never publish |
| test-open-checks (new) | the documents API | set per test: `direct` from the fixture, `disabled`, `shopify`, or billing degraded |

"none" with no note was checked with grep: the suite's source never names `checkout_mode`, so its tenants carry none. The three suites that do name it (test-schema-compat, test-failure-matrix, test-commerce) are explained in their row.

Drills that first-publish (`scripts/drills/p2`, `p3`, `p4`) are not gated. Their stores carry no `checkout_mode`, so they open as before; they were not re-run (owner check in `P6-OPEN.md`).
