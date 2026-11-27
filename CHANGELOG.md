*** Storeasy Changelog ***

Format (as WooCommerce does): newest version first. Each line starts with one tag:
Add (new feature), Fix (bug fix), Tweak (change to existing behaviour), Update (pricing, content, dependencies), Dev (developer or ops change), Security.
Versions: MAJOR.MINOR.PATCH. A release with an Add is a MINOR bump; fixes and tweaks alone are a PATCH bump.

= 1.0.1 - 2026-11-27 =

* Fix - Storefront: product images sometimes failed to load. The offline helper (service worker) was blocked from fetching Shopify CDN images, and crashed when it had no saved copy.
* Fix - Store console: the Brand step preview and the editor failed because production still pointed at a retired search server. Search now uses the built-in database search until a new search server is set.
* Fix - Operator sign-in and every console page were slow: server code ran in the US while the databases are in Mumbai. Server code now runs in Mumbai (bom1).
* Dev - SOP for setting up a new store with its own Shopify custom app (docs/SOP-NEW-STORE.md).

= 1.0.0 - 2026-11-27 =

First production release on https://storeasy.in.

* Add - Marketing site: new landing page with a floating navigation bar, animated artwork for every section, a hero comparing a typical app bill with Storeasy, and a sourced estimate of what twelve common Shopify apps cost each month.
* Add - Plans: Launch ₹9,999, Growth ₹24,999 and Scale ₹60,000 a month, plus Enterprise ("Talk to us").
* Add - Everything built in Phases 0–9: multi-store platform with one database per store; merchant console with the document CMS, themes, offers, bundles and search; checkout with Razorpay, COD and OTP-confirmed COD; saved addresses; markets and currencies; reviews, subscriptions, WhatsApp, Shiprocket tracking and the AI copilot as first-party plugins; and the operator console with billing, flags, support access and incidents.
* Dev - Production on Vercel (storeasy.in, www.storeasy.in and *.storeasy.in for stores) with a fresh Turso control-plane database; each new store gets its own Turso database.
* Dev - Platform job runner scheduled every minute.
* Dev - Platform migration 0020 moves the old ₹999 / ₹2,999 plan prices to the new tiers; stores already subscribed keep the version they bought.
