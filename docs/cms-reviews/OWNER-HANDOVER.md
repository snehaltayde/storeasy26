# Storeasy CMS: owner handover

## Where things stand

1. All six CMS phases (1 to 6) are built, reviewed and merged on the local branch `cms/phase-1` (481 commits ahead of `main`). Nothing is merged to `main` or pushed to GitHub yet.
2. Nothing is hosted: no staging deploy, no hosted Turso run, no real Typesense, no real Shopify or Razorpay run. Every check so far ran on your Mac, mostly in desktop Chrome on the local test store ("the harness").
3. No real store has moved to the new editor. Every store is still on the old editor, and should stay there until section 3 below is done.
4. How to use this list: start with section 2 (decisions only you can make). Then set up staging and work through sections 3 to 6. Sections 7 to 9 can be done whenever. Tick a box when it is done. Codes in brackets (for example [P4-GUARD]) only tell you which review packet in `docs/cms-reviews/` explains it.
5. Test orders always go to snehal@mediastic.in and are cancelled straight after. Never type card or bank details into a shared or screen-shared session; make test payments yourself.

Already done (no action needed): 40 of the 503 collected checks were already finished by later work and are left out of this list. Two of them were open decisions until today: the doubled 'Shop Shop all…' hero subtitle (P6D-1) is fixed (catch-all collections such as 'Shop all' are now left out of the subtitle), and you already chose on 5 November that a bundle made inside the editor turns on at once (OQ-C), so only its staging check remains (section 4).

Words used below:
- **Old editor / new editor:** the old screens (Designer, Pages, Theme and so on) versus the new single editor. 'Moving a store' means switching it from the old to the new; a 'reversal' moves it back.
- **Hero:** the big banner at the top of the home page. A 'hero test' is an A/B test of that banner.
- **Staging:** a private hosted copy of the app for testing, not seen by shoppers. It does not exist yet.
- **The harness:** the local test store on your Mac that the agents used for every drill.
- **Dry run / rehearsal:** a dry run reports what a move would change without changing anything; a rehearsal does the move on a copy.
- **Theme pin / theme kit:** the record of which look (Glow, Pulse and so on) a store uses, shown in the platform console.
- **Publish set:** several pages published together in one go.

---

## 2. Decisions only you can make

Each line says what is built today ("Now") and what changes if you say otherwise ("If no").

### Most important first

- [ ] **Proof that a store being moved refuses old-editor saves on the real hosted database (runbook step 0.3).** Now: proven only on local databases; an ordinary old-editor save is refused before it ever reaches that guard. Choose (a) a staging-only script that sends one guarded save straight to a 'migrating' staging store, or (b) accept the local proof and record hosted Turso as untested. If no choice is made, no real store may move. [P4-GUARD, P4-DRILLS]
- [ ] **Reversal (moving a store back to the old editor) needs a matching dry run but no rehearsal.** Now: built that way, because a reversal returns to the exact release from before the move; this differs from plan section 0. If no: a rehearsal is added before every reversal. Needed before the first real reversal. [P4-REVERSE, P4-FIX6]
- [ ] **Merge the two side bug-fix branches and fix the open redirect on `main`.** Now: the payment-confirmation fix (`claude/gallant-keller-7d3213`) and the closed-store fix (`claude/musing-williamson-4c86b3`) sit unmerged and wait for your OK. `main` still has the preview redirect hole (a link like `/api/preview?to=/%5Cevil.com` sends any visitor to another site); it is fixed only on `cms/phase-1`. If no: `main` stays exposed until the CMS branch merges. [P2-FIX4, bug-fix branches]
- [ ] **Open questions left on their built-in defaults.** Each was built on a default answer; confirm or change each:
  - [ ] Shopify product updates keep writing while a store is being moved, counted as an allowed difference. If no: they are queued until the move ends. [OQ-5]
  - [ ] Staff can edit the cart offer, only an owner or admin can publish it; tell the team. If no: staff publish rights are restored. [OQ-6]
  - [ ] Nothing in the shopper's browser needs the Shopify title or SKU in the cart; both are now removed. [OQ-7]
  - [ ] Saved templates are counted, not converted, and stay usable through 'Make a page from this'. [OQ-8]
  - [ ] After a reversal, product names, descriptions, photos, brand and type come back at the next move; everything else published in the new editor stays only as older versions. [OQ-9]
  - [ ] Engineers may read real store sizes (counts only) for pavos or BeastLife to size the speed-test store. Now: not allowed, so the test store is a guess. [OQ-11]
  - [ ] The 'same as Shopify image' rule ignores the part after '?' in image addresses; check on a dev store that this is safe. [OQ-14]
  - [ ] Approve a private staging deploy of one test store for speed measurement. Now: no hosted speed numbers or budgets exist. [OQ-19]
  - [ ] Overlapping bundles can give a different cart saving than the card shows. [OQ-D]
  - [ ] The bundle 'Add' button adds products one at a time, so a failed add can leave half a bundle in the cart. If no: build an all-at-once add. [OQ-G]
  - [ ] The riskiest-assumption test (5 founders who pay for 2+ apps, timed tasks, 'which apps would you cancel?'). If fewer than 3 of 5 would cancel one, reopen the 'no reviews' question before investing further. [OQ-07, spec section 12]
- [ ] **Fixed lime 'success' status colours** (in the brand file) show on every generated store whatever its palette. Now: kept fixed. If no: they follow the store's own colours. [P6-GEN, P6-DRILLS]
- [ ] **The 13 words a generated store must never say** (reviews, rated, stars, certified, award, clinically, guaranteed, best-selling, #1, organic, dermatologist, lab-tested, money-back), especially 'organic' and 'guaranteed'. A founder's own words are never checked. If no: give your own list. [P6-FIXTURE, CLAIMS]
- [ ] **'#1' rule** also flags some colour codes such as '#1abc'. Now: accepted. If no: switch to a word list. [P6-FIX2]
- [ ] **Starter policy pages on an already-open store.** Now: a closed store cannot open until each untouched starter page is saved or marked 'I've read it'; an open store only gets 'Publish your privacy page and your returns page' with no read step. If no: open stores must also read a starter before it counts. [P6-DRILLS]
- [ ] **Wording sign-offs.** All founder and shopper wording waiting for you is listed in section 7. Nothing there blocks the build, but some of it is legal text shoppers will read.

### Moving stores and the new editor

- [ ] Home hero title that follows the store name. Now: a moved hero has no title of its own, so the first hero edit blocks publishing until the founder types one, and experiments report a half-customised home as blocked. If no: build a real store-name placeholder (needs an owner for three files). After a real move, open the home page in the editor and try a subtitle-only experiment. [P4-MAPPER, P4-FIX1]
- [ ] Old product description HTML saved before cleaning shows as a shopper-visible change in the dry run. Per store: accept it as an allowed difference, or have the founder save those modules again before the move. [P4-OVL07, P4-EQUIV, P4-CUTOVER]
- [ ] A running hero test during a rehearsal: pause it so the hero is compared as a page, or accept a data-only comparison. [P4-EQUIV]
- [ ] The rehearsal comparison can fail on the hero alone while a hero test runs (a timing quirk). Assign the fix, or rehearse again when only the hero differs. [P4-EQUIV F2, P4-DRILLS]
- [ ] The page comparison ignores asset addresses, full date-times and id attributes; a change only there is never reported. Confirm. [P4-EQUIV]
- [ ] After a move, products and collections show only as 'Product content' or 'Collection content' in Media and Publishing, so you can't tell which product uses a photo. Assign a fix plus a one-off rename for moved stores. [P4-DRILLS F1]
- [ ] New-editor stores show the error page when a product's or collection's content can't be read (old editor just hid extras), and collection pins fail closed. Confirm, or ask pins to degrade gently; watch product page errors for a day after each move. [P4-OVL07, P4-EDITOR, P4-FIX2]
- [ ] A product deleted from Shopify while the store was back on the old editor gets its content row back at the next move (unseen by shoppers). Confirm. [P4-REVERSE]
- [ ] Product gallery images go live only from Shopify's image server or the store's own media library. Confirm no store uses another site. [P4-LIVEROW]
- [ ] Editor limits of 30 gallery images and 20,000 description characters per product. Confirm. [P4-LIVEROW]
- [ ] Free gift lines in the cart use the founder's published product name, else the name saved with the offer. Now: that. If no: use Shopify's name, which would visibly rename gifts on stores with nothing published today. [P4-EFFECTIVE]
- [ ] Only the first 50 collections show in the editor's switcher. Confirm, or ask for a search box. [P4-EDITOR]
- [ ] A product or collection draft shows to any valid preview session on that page, not only when open in the editor. Confirm. [P4-OVL07]
- [ ] Keep the bare /admin/catalog page for Bundles and Quiz until they move into the editor, or move them first. [P4-ED05]
- [ ] Old-editor stores' media usage errors: keep today's handling, or make them refuse safely (changes old output and tests). [P4-MEDIA]
- [ ] Name someone to add the new store tables to the platform export, so exports include them. [P4-SCAFFOLD]
- [ ] Should /platform 'New store' (which replaced the 'New tenant' form in Phase 1 line 9) offer 'start on the old editor' (today only the command line has it)? [P4-PROVISION]
- [ ] The phase 3 smoke check reports 22 'orphan' image references because it doesn't count checkpoints. Update the drill or accept. [P4-HARNESS]
- [ ] An image used only in an older page version can never be force-deleted. Now: always refused. If no: allow it, accepting a missing image if that version is restored. [P2-DOCS]
- [ ] Draft checkpoint every 5 minutes. Confirm or give a number. [P2-DOCS]

### Publishing rules

- [ ] Publish rules: at most 200 items per set, 3 tries before 'busy', 'not found' for a missing page, a hidden section never blocks its page, only owners and admins publish. [P2-PUBLISH]
- [ ] How a refused publish is reported ('failed, nothing written', a 500 'Publish failed; nothing changed', never a conflict rebuild), and update plan decision 2. [P2-ATOM, P2-HARDEN]
- [ ] The editor's technical rules in the P3-SCAFFOLD design table (for example a new 'can't take offline' answer, no live link after a page is taken offline, each page row saying who may publish it). The code is already built on them; an engineer can walk you through it, or accept. [P3-SCAFFOLD]
- [ ] Structure problems in hidden or inherited sections block the page's publish, including migrated pages. [P2-FIX4]
- [ ] A missing header/footer version shows shoppers the error page (not a plain neutral header/footer); the journal list stays unguarded for now. [P2-DRILLS, P3-CLOSED]
- [ ] Drafts now save broken values, too-long titles and bad menu links as 'unfinished' instead of refusing them; publishing still refuses. [P3-VALIDATE]
- [ ] Missing image alt text now only warns at publish (phase 2 blocked it). [P3-CHECKS]
- [ ] A never-published store's first publish must include the home page. [P3-CHECKS]
- [ ] A normal publish clears the 'taken offline' marker; 'publish again?' appears only for exactly the content taken offline. [P3-CHECKS]
- [ ] A page counts as 'offline' only if taken offline and no longer pointing at its live version (narrower than the brief). [P3-COMMIT]
- [ ] An offline page keeps its web address until archived. [P3-DRILLS]
- [ ] After undoing a publish made while a page was offline, no further Undo is offered. [P3-UNDO]
- [ ] A restored removed or moved section goes after its nearest live neighbour. [P3-CHANGES]
- [ ] 'Too many kept drafts' tells founders to tidy them in Earlier versions, but they can't be deleted. Build a tidy option or reword. [P3-CHANGES]
- [ ] Each extra keep during 'Use the newer version' adds a kept draft, so that limit comes sooner. [P3-STORE]
- [ ] Two tabs typing on the same page at the same version share one local backup. [P3-STORE]
- [ ] Add a rate limit to the editor's save/publish endpoint? Now: none beyond login and the 10 kept drafts. [P3-CHANGES]
- [ ] Should publish checks also compare a link's page name and kind with its target, to catch older links to an old page id? [P3-INSPECTOR]
- [ ] Previewing what an Undo would change is refused unless the request carries a version number, even though the preview doesn't use it. Should it skip that check? (Engineering detail; founders don't see it.) [P3-FIX3]
- [ ] Publish has no size limit, so a page over 512 KB can publish but not save as a draft. Accept. [P3-FIX1]
- [ ] If the database can't say whether a never-published store is open, checkout, contact and quiz are refused until it answers (safe side). [P3-FIX1]
- [ ] If the database can't say which editor a store uses, the 8 old editor screens stay up (their saves still refuse) while the new editor shows the error page. Accept, or make the old screens show the error page too. [P3-ROUTES]
- [ ] In the new editor's mode, the sidebar's Storefront group shows only Editor, Media and Publishing, and old Pages opens the home page. [P3-ROUTES]
- [ ] The preview link answers in the editor's own data format only when the editor asks for it; any other visitor gets the same answer as before. Accept. [P3-FIX1]
- [ ] The leads form on a store address answers 'too many requests' after 5 calls an hour from one address. [P3-FIX1]
- [ ] The hidden labels that let a click in the preview open the right field use the publish checks' names, not the names in the design brief. Engineering detail; accept. [P3-FRAME]
- [ ] On a closed store's 'Opening soon' page the editor has no link-up and restarts the preview every 3 seconds. [P3-FRAME]
- [ ] A never-published design lists its colour/font rows against the platform default; should it say 'first publish', and list nothing if it matches the default? [P3-DESIGN, P3-FIX4]
- [ ] Where 'Apply this look with its starter brand' lives in the new editor, or change the Design help text that points to the old theme screen. [P3-DESIGN]
- [ ] A whole-store settings save at the same moment elsewhere can still put back an old theme pin. Accept. [P3-FIX4]
- [ ] Rich text paste: hidden code copied along with a web page's text is cleaned on save only in the new editor; the old editors still refuse such a paste. [P3-FIX4]
- [ ] A banner on a page or campaign page never shows to shoppers though the editor offers it. Show banners there, or stop offering them. [P3-DRILLS]
- [ ] Confirm the intended old-editor changes: AI hero drafts keep buttons and badge; agency and theme kit content is checked; kit sections get new ids; each write adds history; on a new-editor store a kit keeps the founder's hero image. [P2-WRITERS]
- [ ] Restrict hero images hosted outside Shopify's image service (sent full size)? Later. [P2-SECTIONS]
- [ ] Make the next home page size cut (merge the five product rails into one read)? The home page is only about 680 bytes under its 50 KB budget. [P2-PERF]
- [ ] The shortened product and collection names in the drill screenshots (docs/cms-reviews/drills/P2-DRILLS/sections-*): is that the look you want? [P2-DRILLS]

### Preview, sign-in and A/B tests

- [ ] Preview shows every saved draft, not only drafts of pages open in an editor tab. Now: every saved draft (the 'only open tabs' version was put off to a later phase). If no: ask for the per-tab version. [P2-PREVIEW, P3-PLAN]
- [ ] When a store's editor mode can't be read, a founder's preview shows live content. [P2-FIX4]
- [ ] Signing out ends that person's previews on every device (new-editor stores). On old-editor stores it ends the Designer preview in that browser, but a Designer preview on another device lasts until it expires (up to an hour). The shared first-setup login counts as one person, so signing it out ends every preview opened with it. [P3-SESSION, P3-FIX1]
- [ ] A platform operator's logout doesn't cancel their preview sessions; they expire within the hour. [P3-SESSION]
- [ ] On a closed store the 'Show them' toggle does nothing. Accept, or hide it until the store opens. [P6-LOGO-REG]
- [ ] A browser signed in to the console always sees the live hero, never the test version, and is never counted. This holds only on the web address where you signed in: on another address of the same store (www versus without www, or the platform address versus your own domain) you are counted. Add a 'see what shoppers see' option? [PV-08]
- [ ] Should a client on an approval link see the purple 'A test is running' note with a console link? [PV-08]
- [ ] Should the Home editor's hero card carry the same 'test running' note? [PV-08]
- [ ] Client approval links compare against a brand up to 30 seconds old. [FIX-C]
- [ ] On a closed store, Shopify product, collection and search data (and the product page's own title in search results) still answers. Now: allowed, since it is public Shopify data; only your own unpublished content is hidden. If no: those must close too. [P3-CLOSED, P3-DRILLS]
- [ ] 'A signed-in team member' on a closed store means someone holding a preview link made from the console; a console login alone does not count. Confirm. [P3-CLOSED, P3-DRILLS]
- [ ] Agency members signed in only with the agency cookie see the closed page. Intended? [closed-store branch]
- [ ] Closed pages answer 'OK' (200) with no 'come back later' or 'don't index' signal, so Google may index the 'will be right back' page in a long closure. Answer 503 with retry time, or at least send noindex? [closed-store branch]

### Bundles

- [ ] Bundles have no versions: any edit, turn-off or delete changes live home cards at once, with no publish step. [P5-DRILLS]
- [ ] Before phase 5 ships, look at real stores' bundles: any saved with the same product twice shows 'not ready' until saved again. [P5-DRILLS]
- [ ] Other bundle deviations: bundle sections only on the home page; /bundles/ links tracked by address and not checked at publish; no 'expired' or 'not started' state. [P5-DRILLS 3.3, 3.5, 3.11]
- [ ] A bundle picked in a section is tracked by id, but a /bundles/ link to it by address; nothing connects them. [P5-SETTING]
- [ ] A bundle linked only by a /bundles/ link gets no home-page warning on Disable or Delete. [P5-DRILLS]
- [ ] Turning a turned-off draft bundle back on rewrites its whole offer from its details. [P5-BUNDLEREAD]
- [ ] A turned-off draft bundle can save with a quantity like 1.5 and shows as passing its check; turning it on is refused. [P5-BUNDLEREAD]
- [ ] A bundle with a deleted product shows as sold out with 'Replace it'; a non-whole quantity is 'not ready'; the overlap warning shows only for available bundles. Plus P5-FIX1's new words. [P5-FIX1]
- [ ] The bundle form shows the exact saving with paise plus the whole-rupee amount the cart takes off. Or show only the whole amount, like the card. [P5-EDITOR]
- [ ] An exclusive coupon cancels the bundle saving without explanation in the cart. [P5-DRILLS]
- [ ] A bundle needing 2 of a product with 1 in stock still shows as available. [P5-DRILLS]
- [ ] The demo test data can't save bundles (non-Shopify product ids). Give it Shopify-style ids? [P5-PANEL]
- [ ] Catalog > Bundles' behaviour when the home page check fails is covered only by an automatic test. Accept. [P5-FIX2]
- [ ] The new editor has no phone-size preview switch (the old Designer had one). Add one, or rely on real phone checks. Backlog. [P5D-1]

### First run, brand and setup (phase 6)

- [ ] Syncs started inline, from the command line or the connect step don't build the store; the start page or editor does, only when no home page exists. Accept. [P6-DRILLS]
- [ ] P6D-2: the empty-catalog note promises product rows after the next sync, true only with the background worker. Should the start page refill an untouched generated home? [P6-DRILLS]
- [ ] P6D-3: with checkout off, a disabled Open button shows instead of no button. Accept or hide it. [P6-DRILLS]
- [ ] P6D-4: the brand step accepts any media address as the logo. Check the address shape? [P6-DRILLS]
- [ ] The first run saves home then design in two steps; a failure between them leaves a home with no design until the next run. Accept, or add a guard. [P6-FIX1, P6-FIX2]
- [ ] After a reload, the start page gives no note that colours weren't made. Accept or add a note. [P6-FIX3]
- [ ] 'Start your store' ticks as soon as any home page exists, even an empty one. [P6-ONBOARD]
- [ ] An open store that never did the brand step keeps today's dashboard nudge (differs from the plan). [P6-FIX2]
- [ ] An open store shows 'already open' words on /admin/start rather than a summary. [P6-START-UI]
- [ ] 'Review and open your store' opens the editor, not the publish panel. Accept or ask for a direct link. [P6-DRILLS]
- [ ] Should the opening checks themselves skip opening for a product-only publish (today only the editor skips it)? [P6-OPEN-UI]
- [ ] Keep test rule b (the test store opens with both home and design), or narrow it. [P6-OPEN]
- [ ] Confirm the opening-checks rules, the scope of the 'policy page missing' check, the founder words, and re-run drills p2, p3 and p4. [P6-OPEN]
- [ ] Staff may change colours and logo in the brand step, not the store description. [P6-BRAND]
- [ ] Olive (#808000) is not treated as lime. Or start the lime range lower. [P6-BRAND]
- [ ] Plain readability notes appear on the Glow kit with Slate, Stone, Forest and Clay after a kit switch. Acceptable? [P6-BRAND]
- [ ] Forest and Clay buttons use near-black text on a lighter accent. Happy with the look? [P6-PALETTE]
- [ ] On the Pulse kit, dark accents get a lighter hero highlight and a readability note may show. Should founders see that note? [P6-PALETTE]
- [ ] The checkout page keeps the text store name even with a picture logo. OK for now? [P6-LOGO-RENDER]

### Colours and readability (phase 1)

- [ ] Darken the default look's hard-to-read colours (small grey text, placeholders, wordmark accent, red error on pink)? Now: kept. [TOK-01]
- [ ] Keep the darker lime (#456c09) for links and wordmark on Pulse stores using the kit's colours. [TOK-01]
- [ ] Darken form field outlines (about 1.3:1 against the 3:1 guideline)? [TOK-01]
- [ ] The fix suggested for an unreadable colour is 'nearest colour that passes' (a mid grey for dark on black), or suggest near-white/near-black. [TOK-01]
- [ ] Should the Brand screen say the default look's own hard-to-read pairs are never flagged? Now: quiet. [TOK-01 fix 1]
- [ ] Keep the darker green (#4d7c0f, #3f6212) for wordmark and hero highlight on unbranded Glow stores. [TOK-01 fix 1]
- [ ] Keep the darker greys on every store (wishlist '?', policy page links, applied coupon words). [P1-CONTRAST]
- [ ] About 1 in 1,000 unusual brands would now be refused at publish over faint coupon words; about 1 in 100 accent-only brands get a slightly different link colour. [P1-CONTRAST]
- [ ] Leave the invisible lime difference on Pulse stores (#a8eb43 vs #a3e635). [P1-CONTRAST]

### Older items from phase 1

- [ ] Turn on local git hooks that run all tests (about 35 seconds) before each commit and merge? [SHOP-01]
- [ ] Make the migration check a required step before deploys (CI job, deploy script, or written rule as today)? [P1 batch B]
- [ ] Deploy staging now or wait for hosting with the background job runner set up. Pass: a 2,000+ product store's first sync finishes with the console closed. [GEN-02, OQ-19]
- [ ] What counts as 'confirmed' products for first run: latest sync complete, or any one complete sync. [GEN-02]
- [ ] Accept the error code names SAVED_RELOAD_FAILED and RELOAD_NEEDED, or rename. [DOC-04]
- [ ] Fix 'We couldn't reach your store's data' showing for another service's failure (e.g. Razorpay in Billing) once the database-retry branch merges? [DOC-04]
- [ ] Change the 'Couldn't save' title when the save worked but the reload failed? [DOC-04]
- [ ] Fix now or later: a failed sign-in lookup answers 'not signed in', and the media usage check hides read failures (a delete may not warn). [DOC-04]
- [ ] Move shoppers' browser-stored cart data to the server once titles are editable? [MIG-05]
- [ ] Free gift lines show no 'Shopify title' line until a later item. Accept or bring it forward. [MIG-05]
- [ ] Build offers 'for a collection' (needs an offer engine change), and in which phase? [COM-03]
- [ ] Free-item warning thresholds (Rs 2,000, $25, 25 euro, 20 pounds, AED 90, SGD 30, AUD 40, CAD 35), or give your own. [COM-03]
- [ ] Discounts outside India round to whole units (12.5% off $20 shows '$3 saved'). Change it (offer engine change) or keep. [COM-03]
- [ ] Editor 'Desktop' preview: a 1280px page shrunk to fit, or 1440px; add an 'actual size' option? [ED-01]
- [ ] Keep the console navigation folded behind the menu button (as built), or the 64px icon rail. [ED-01]
- [ ] Designer screen descriptions are now only read out by screen readers. OK? [ED-01]
- [ ] Below 1280 wide, store name, switcher and unpublished dot show only in the menu. OK for agencies? [ED-01]
- [ ] Picking a section keeps closing the drawer at 1024 to 1279 wide? [ED-01]
- [ ] Shopper-facing settings (shipping rates, store name, checkout mode, payment key, maintenance) can reach shoppers up to 30 seconds late. Accept, or version them too. [FIX-C]
- [ ] A store before its first publish can show the old brand for up to 30 seconds after a save. [FIX-C]
- [ ] Tighten later the other old-store reads that treat any failure as empty (wishlist, bundles, customers and others)? [FIX-C]
- [ ] A checkout tab opened before a deploy can't order until reloaded. Accept, or allow old requests briefly. [P1-RATES]
- [ ] Read shipping rates fresh on the checkout page (one extra database read) so shoppers rarely see 'total changed'? [P1-RATES]
- [ ] Does the speed-test store (400 products, 30 collections, 20 pages, 60 posts, 12 home sections, 8 offers, 4 bundles) look like a store you'd onboard? [PERF-04]
- [ ] Confirm the first-publish change list may quote the page title. [P3-DIFF]
- [ ] In the founder's preview, a menu item with an off-store link shows as typed. Accept, or add a menu-level note. [P3-VALIDATE]
- [ ] Payment branch: a second, different payment on an already-paid order is refused and logged as NEEDS ATTENTION. Who watches and refunds it in Razorpay? Should the retry-queue path (flagged only after 5 tries) be faster or louder? [payment branch]

---

## 3. Before any real store moves to the new editor

Do not move any real store until every box here is ticked and the plan section 6 cutover gates are met. Deploy rules DR-1, DR-2 and DR-3 stand.

- [ ] Settle the runbook step 0.3 hosted proof (section 2), then on staging prove a 'migrating' store refuses an old-editor save as one all-or-nothing batch and writes nothing; the only passing words are 'Your store is being updated. Try again in a few minutes.' [P4-GUARD, P4-LIVEROW, P4-CUTOVER]
- [ ] Database updates before each deploy, staging first, every store including suspended ones and the env store: 0018 to 0020 (phase 1), 0021 (phase 2, marks every store as old editor), 0022 (preview sessions), 0023 to 0025 (phases 3 and 4). Run `pnpm tenant:migrate -- --all`, `pnpm migrate`, then `pnpm tenant:migrate -- --check --include-env`; it must end cleanly ('Safe to deploy.'). Re-seed the design test store after 0023. [P1 batch B, P2-ATOM, P2-PREVIEW, P3-COMMIT, P4-SCAFFOLD]
- [ ] Never roll back past the reader version gate while any store has a new-format live pointer, and scan every store's live version values before deploying. [DR-1, DR-2]
- [ ] Restoring an export of a new-editor store has never been tested (only the export side). Test it before relying on exports. [DOC-12]
- [ ] Confirm the Turso plan includes point-in-time restore, and record the time just before each real move and reversal (--backup-ref). [P4-CUTOVER, P4-REVERSE]
- [ ] Per store, a real hosted dry run (`pnpm migrate:documents -- --tenant <id> --dry-run --hosted --confirm <id>`, plus --store-open or --not-launched for a never-published store). Read the plain report with the founder, check the routes list covers every page and old address, keep the digest. [P4-MAPPER, P4-FIX1]
- [ ] Per store, in order: dry run read with the founder, rehearsal on a restore-drill copy on the local harness, real move, post-checks (runbook sections 1 and 3 to 7). [P4-CUTOVER, P4-DRILLS]
- [ ] Copying the store's platform record into the local harness for the rehearsal is a manual developer step until a tool exists. [P4-CUTOVER]
- [ ] Make the restore-drill copy only on your own Mac and delete it (with its -wal and -shm files) afterwards; it holds customer data. [P4-HARNESS]
- [ ] During the rehearsal run --make-routes; if a hero test runs, it says so and routes.json includes it. If --compare exits with code 2, the harness was broken before the move: fix and capture again. [P4-FIX4]
- [ ] Before the first real move, read the before-and-after comparison in the rehearsal report and approve the two allowed differences (section ids, hero test variant). [P4-EQUIV]
- [ ] Rehearsal and real move version ids may differ; compare source fingerprints only. [P4-FIX1]
- [ ] The move must cancel scheduled release-publish jobs when it locks the store, or they error into the failed-jobs queue. [P4-GUARD]
- [ ] Warn the founder and pick a quiet time before each move and reversal; tell the team staff can no longer publish the cart offer. [P4-DRILLS]
- [ ] Don't change brand or theme settings in the platform console while a move runs. [P4-CUTOVER]
- [ ] At cutover, write the store's theme pin from its live design; after each move and reversal check the console shows the right theme kit. [P3-DESIGN, P4-CUTOVER]
- [ ] After a move that follows a reversal, check the restored products by hand (the rehearsal leaves them out). [P4-REVERSE]
- [ ] On a local production build (`next build` then `next start`), run the closed-store leak probes against a closed copy and against a generated unpublished store (rsc-probe, matrix 'closed' probe, quiz-probe); no unpublished text may leak. So far only on the dev server. [P3-CLOSED, P3-FRAME, P6-DRILLS]
- [ ] Check a phone and Safari pass on the bundle screens (section 6) before bundles go live on a real store. [P5]
- [ ] During a real maintenance window, watch Google Search Console and Merchant Center: pages answer 200 with the closed page and the sitemap answers 404. [closed-store branch]
- [ ] After deploy to production, on a real store with a running hero test, previewing and browsing while signed in must never raise the counts. [PV-08]

---

## 4. Staging checks

Staging does not exist yet. First deploy to staging and set up a new-editor (documents) test store there, new or moved by you. Use throwaway test stores, never real ones.

### Hosted database: all or nothing, races and lost answers
- [ ] Old-editor publishing on hosted Turso: one publish, two at once (one live, one 'Another publish just went live, review again', no stray row), a publish while the database is locked, a lost answer after commit (success, no duplicates), and a read right after sees it. [P2-ATOM, P2-GUARD]
- [ ] New-editor publishing: one publish; two different pages at once (both live); the same page twice (one conflict); publish under a lock (live or 'busy', never half-written); a lost answer after commit (success, no duplicates); one build reusing another document's version id ends failed with nothing written. [P2-PUBLISH, P2-HARDEN, P2-FIX4]
- [ ] New-editor saves: one save; two saves racing (one conflict); two new pages racing for one address (one 'address taken'); a save under a lock; a new page whose answer is dropped still reports success; reads per autosave stay flat as the publish log grows. [P2-DOCS, P2-DOCFIX]
- [ ] Publish then load the home page at once: an unseen version renders after one re-read or shows the error page, never default content. [P2-READ]
- [ ] Undo, take offline, whole-set Undo, Undo racing an autosave, and Undo racing a publish ('published elsewhere') each save all or nothing. [P3-COMMIT, P3-UNDO]
- [ ] 'Publish both' as one set, and 'publish again' after taking a page offline, through the real server. [P3-CHECKS]
- [ ] A lost publish answer is settled correctly by the follow-up live check. [P3-PUBLISHUI]
- [ ] Publish the header with a page its menu links to while hiding or renaming that page: refused. [P3-FIX2]
- [ ] 'Keep the live version' and 'Keep mine as an earlier draft', two tabs keeping at once (limit 10 holds), and an out-of-date keep naming the other person. [P3-CHANGES]
- [ ] Schedule a release and publish by hand just before its time: the scheduled release is live afterwards. [P2-GUARD]
- [ ] Adopt a hero variant on an old-editor and a new-editor test store and re-read each. [P2-WRITERS]
- [ ] First-run save is all or nothing, and a lost answer is read back as success. [P6-GEN-WRITE]
- [ ] A queued Shopify sync either builds the store in its time slice (first_run in logs) or logs first_run_deferred, and then the start page builds it. [P6-GEN]
- [ ] A design publish writes the theme pin and its time; a slow platform database still lets it succeed with a timeout logged; invalid settings JSON is left unchanged with a failure logged. [P3-FIX4, P3-FIX5]
- [ ] Payment branch: a refused connection and a lost response give the error types the retry code expects. [payment branch]

### Preview, sign-in and closed store
- [ ] Create, use, toggle and revoke a preview session; preview from another region right after a save. [P2-PREVIEW]
- [ ] Logout really cancels preview sessions. [P3-SESSION]
- [ ] Check a preview, an ended preview (cancelled from another tab), 'See the live store', and 'Edit this page' from the live store while signed in. [P3-FRAME]
- [ ] 'See the live store' and back: the label says 'Updating' and 'Reconnecting…' until 'Up to date'. [P3-EDITOR]
- [ ] Two editor tabs: change the accent colour in tab A after tab B opened Home; tab A shows it and says 'Up to date' only once it does. Also one tab. [P3-FIX5]
- [ ] Hostile preview links (`to=/%5Cevil.com`, `to=/%09/evil.com`, `token=bad&to=/%5Cevil.com`) land on the store's home; `to=/collections` lands on /collections. [P2-FIX4]
- [ ] Closed-store branch: with maintenance on, a signed-out product page shows the closed page, view-source has no product title or description, tab reads '<Store> will be right back'; a signed-in founder sees the real site. [closed-store branch]
- [ ] On a real https host, 'Store team sign-in' on the closed page stores the pass cookie and shows the real site. [closed-store branch]
- [ ] /manifest.webmanifest on a closed store says 'Opening soon.' and shows the description only after first publish. [P6-FIX1]
- [ ] After deploy, the closed page of a Glow test store has a readable 'Scheduled maintenance' label; a Pulse (dark) store's looks as before. [P2-VGATE]
- [ ] With a real hero test: type, save, reload, open preview, browse signed in, and leave the Designer open over an hour; no exposures and no count changes. [PV-08]

### Shopify sync, search and catalog
- [ ] Shopify connect asks only for the approved permissions, with nothing to write products or content. [SHOP-01]
- [ ] Sync a dev store with 1,000+ products and a 250+ collection: 'N of M' matches Shopify's count; product, variant and collection counts match; total recorded; an edit during sync survives; no products page nears the 15-second limit. [GEN-02]
- [ ] Stop a sync midway: with the job runner it resumes with no page fetched twice; without it, with the dashboard open, it moves again within about 3 minutes. [GEN-02]
- [ ] Within a minute of connecting, products start arriving before any background job. [GEN-02]
- [ ] Edit a product title and remove a product from a collection in Shopify; the store shows both within a minute. [GEN-02]
- [ ] During a refresh, a long collection never shows fewer products than before. [GEN-02]
- [ ] The catalog sync pauses while a store is being moved (needs real Shopify). [P4-GUARD]
- [ ] Real Typesense: search shows a renamed product within a few minutes on every Typesense store (including _default) and a full sync keeps it; two renames a second apart end on the second name; a publish still feels instant (search wait capped at 2.5 seconds); after an outage overlapping a full sync, a ':sync:' reindex job runs. [P4-SEARCH, P4-FIX2]
- [ ] Before the first real reversal: move a staging store, rename a product, run runbook section 9; Shopify's name shows on page, collections and search; old editors save; console shows the old kit. Search shows Shopify's names after reversal and restored names after the next move. [P4-REVERSE]
- [ ] Move, publish a new page, reverse; the next dry run names the page ('Shoppers won't see it after the move…'); after the move the page shows as unpublished and publishing puts it live. [P4-FIX6]
- [ ] Rename a product from the editor, publish, check product page, card, search and cart, then Reset and publish. [P4-EDITOR]
- [ ] Give a product your own description; Shopify's shows beside it as plain text; change it in Shopify and the notice is plain words; switching products never mixes names. [P4-FIX3]
- [ ] A gift line on a product with nothing published keeps the title and image saved with the offer. [P4-EFFECTIVE]
- [ ] After the media reindex, deleting an image used only by an older version lists '(older version)' and even a forced delete is refused. [P4-MEDIA]
- [ ] Run the media reindex (`pnpm media:reindex -- --tenant <id> --releases`) on every new-editor store after deploy. [P4-MEDIA]
- [ ] Old-editor store: when reading its mode fails, the upsells list and page reads answer 503 instead of old data. [P4-FIX4]
- [ ] Open each of the 8 old addresses on a new-editor test store; each lands in the right editor page. Old-editor test store looks as before. Also look at the old-address redirects. [P3-ROUTES, P4-ED05]
- [ ] After deploy, an old-editor store's /journal and /sitemap.xml list exactly what they did before. [P2-READ]
- [ ] After migration 0019, edit a live offer and press Go back; old settings return and a real cart shows them. [COM-03]

### Store setup and first run
- [ ] Full first run on a throwaway new-editor store: connect Shopify, sync, /admin/start builds the store, brand step, 'Before you open your store', a cash test order (cancelled), first publish. Home and design are made together; a later sync never overwrites a founder's home edit; Setup checklist works through first publish and shows Launch done; sitemap shows only / while closed; then remove the store. [OQ-4, P4-PROVISION, P6-GEN-WRITE, P6-ONBOARD]
- [ ] Setup page before and after first publish. [P4-PROVISION, P6-DRILLS]
- [ ] Dashboard: one 'Start your store' nudge before the brand step, 'Setup: x/y done' after, none after opening. [P6-NAV]
- [ ] The command-line provisioning (the console's 'New tenant' form is now 'New store', which refuses a taken address up front) with an existing throwaway store's name is refused and that store stays open on the old editor. [P4-PROVISION]
- [ ] Before deploy, no store setup run is half-done on the hosted platform. [P4-PROVISION]
- [ ] A throwaway store whose database name starts another's (shop beside shop2) reports its database created; then remove it. [P4-FIX5]
- [ ] A throwaway store with --db-url pointing at another store's database written differently stops in plain words and registers nothing. [P4-FIX5, P4-FIX6]

### Errors, brand and settings
- [ ] Break one test store's database connection, save and publish in the Designer: 'We couldn't reach your store's data just now, so nothing was saved/published', and a database-unavailable log line. [DOC-04]
- [ ] With the AI provider blocked, Generate in AI Insights says the AI service couldn't be reached. [DOC-04]
- [ ] Break the pages table: the page editor shows 'This page hit an error' with Try again, then 'Your changes were saved, but this page couldn't refresh'; never a 404 or a silent save. [FIX-C]
- [ ] Force a section to fail; section_render_failed and section_binding_failed show in the Vercel logs for that store. [P3-VALIDATE]
- [ ] With several server instances, save shipping rates and reload five times; always the saved rates. Save the brand, open Publishing and publish: the change is listed and publishes, no conflict. [FIX-C]
- [ ] Watch the console for a day for 'Service temporarily unavailable' from Turso blips; ask for a retry if any. [FIX-C]
- [ ] A store with its own brand (e.g. pavos.in) looks right with the new colour rules; an unbranded store looks unchanged. [TOK-01]
- [ ] Dark text on dark background in Brand: saves, 'Hard to read' names it and suggests a colour, Publishing refuses with the same words, the suggestion publishes. [TOK-01]
- [ ] Reset Brand and publish on a store with its own colours and a pinned theme; apply Pulse with its colours: no 'Hard to read' banner. [TOK-01 fix 1]
- [ ] New unbranded store, Glow kit, both boxes unticked: publishes, and green header and hero text is readable on cream on your phone. [TOK-01 fix 1]
- [ ] Designer at 1440: desktop layout at 71%, section clicks select, Save and Publishing work, a failed page shows 'This page hit an error' with menu and Try again. [ED-01]
- [ ] On a new-editor test store: apply a look, change a colour, preview with your new colours shown, publish, then Undo. After each step, the platform console's overview, themes and store detail screens show the live theme kit. [P3-DESIGN]
- [ ] Hosted edge runtime: home, product, collection, collections list, search, checkout step 1, sign-in, a CMS page and the closed page show real content; Designer preview works. [P1-HARNESS]
- [ ] Sign-in code emails arrive from the store's name, including 'St. Mark's' and a non-English name. [GEN-03]
- [ ] Full-size photo upload gets past the hosting size limit and shows a preview. [MED-01]
- [ ] Library photos load from the store's own media address (200), not the image optimizer; store A's media address on store B's domain answers 404. [P1-IMAGES]
- [ ] Home page response is compressed (br or gzip). [PERF-04]
- [ ] Broken HTML and a hidden comment in a Shopify product description show as plain text, with no pop-up or image. [AU-05]

### Bundles (phase 5)
- [ ] Preview a hidden bundle section on a new-editor store. [P5-HIDDEN]
- [ ] Disable and Delete on a bundle used on the live home page warn 'Shoppers will stop seeing this bundle on your home page right away.' and show 'On your home page'. [P5-PANEL]
- [ ] Creating a bundle in the editor turns it on at once (you chose this): check on staging that its discount and its page are live for shoppers before publish, and stay if the draft is thrown away. [OQ-C]
- [ ] A staff role without storefront read rights sees 'You can't see bundles here.' [P5-EDITOR]

### Speed (needs the OQ-19 staging deploy)
- [ ] Measure the 11 phase 1 requests on staging, save a hosted run in docs/perf/, write the first budgets into docs/perf/budgets.json, and confirm the check passes and fails when pushed over. [PERF-04]
- [ ] New-editor home page, policy page, sitemap and /journal; a store without its own header/footer menu; cart, product and collection read counts match local numbers. [P2-READ, P2-PERF, P4-EFFECTIVE]

---

## 5. Payments and test orders

Test orders go to snehal@mediastic.in and are cancelled straight after (in the console and in Shopify). Never type card details yourself in a shared or screen-shared session; make Razorpay test payments yourself.

- [ ] Checkout with the store's own shipping rates, once cash on delivery and once a Razorpay test payment: summary and Pay button match the amount charged. [GEN-03]
- [ ] Deploy before migrating a store still at 0017: a cash order and a Razorpay test payment both complete; after migrating, new order lines carry the SKU. [P1 batch B]
- [ ] Push a test order to a real Shopify dev store and find it in Shopify admin by the SKU the console shows. [MIG-05]
- [ ] Free-gift offer above the threshold: gift in cart, draft order discount names the offer; clear the name and change the amount, order again: description names the new amount. [COM-03]
- [ ] Change shipping rates, then within 30 seconds place a cash order: 'Shipping changed — your new total is Rs X…' shows, the button updates, pressing again orders at that amount. [P1-RATES]
- [ ] Same with Pay online: the first press is refused with no Razorpay window; after the redraw the Razorpay amount equals the button. [P1-RATES]
- [ ] Hero test conversions: a browser already counted, signed in, paying online adds no conversion; a private never-signed-in window adds exactly one. [PV-08]
- [ ] From a preview of a closed, never-published store, place one cash order, confirm it reaches Shopify, cancel it (orders carry no 'test' mark). [P3-CLOSED]
- [ ] One test order through a bundle card: the bundle discount on the Shopify order matches the card's saving. [P5-DRILLS]
- [ ] On a store with real Razorpay keys, the payment item shows 'Shoppers can pay' with no 'Cash on delivery only' line. [P6-OPEN]
- [ ] Payment branch: stop the database during payment verification; checkout waits about 30 seconds then shows 'Confirming your payment', with a sensible message if no status link comes back. [payment branch]
- [ ] Payment branch: after that message, press Pay again; Razorpay refuses a second payment for the same order. [payment branch]
- [ ] Payment branch, once the duplicate-order fix lands: a browser callback and a webhook together make only one Shopify order. [payment branch]

---

## 6. Phone, Safari and browser checks

Almost every drill ran only in desktop Chrome. 'Phone width' in the drills was a Chrome window, not a phone.

### Real phone and Safari
- [ ] Checkout on iPhone Safari with one item: nothing moves sideways and 'Payment' in the step row is fully visible. [TOK-01]
- [ ] First visit on a real iPhone: the cart drawer's Checkout button is tappable without answering the cookie banner (in Chrome the banner covers it), or accept that. [P1-HARNESS]
- [ ] Photo uploads: a 5MB phone photo keeps sharpness and colours; in Safari a transparent PNG over 1.5MB stays transparent, a PNG renamed .jpg works, a long size chart keeps its size. [MED-01]
- [ ] iPhone HEIC photos from iPhone Safari, Mac Safari, desktop Chrome, Android Chrome and your oldest iOS: converted, or a plain message and nothing sent. [MED-01]
- [ ] Sideways photos on the oldest iOS Safari arrive the right way up; 48MP photos on a real iPhone and Android don't crash the tab. [MED-01]
- [ ] Logo upload from a phone: PNG, large JPEG and SVG work; HEIC is refused in plain words. [P6-BRAND]
- [ ] Logo on real screens with PNG, large JPEG and size-less SVG: header on phone (32px) and desktop (40px, max 180px wide), both footer styles (48px), Chrome and Safari; nothing cut or squashed. [P6-LOGO-RENDER]
- [ ] Bundle screens at 375 and 768 wide and in Safari: card and grid, preview notes, publish warnings, inspector picker, grid rows, 'Create a bundle' and 'Pick again', Catalog > Bundles and its form. [P5]
- [ ] Phase 4 screens on a phone and Safari: product form and switcher, a renamed product's page, card and cart, adding a library image, archiving a file, the order 'Shopify title' line, the move and reversal screens. [P4]
- [ ] Read every word of 'Before you open', the start page and the Setup checklist on a phone; an untouched starter page clearly blocks opening. [P6-POLICY-START]
- [ ] Setup page on a new closed store, desktop and phone: start privacy and returns pages, open each, mark one read, save the other, see the step done. [P6-ONBOARD]
- [ ] Brand step on a phone: six palettes, Save with no change, Remove logo, Skip, and the 'Your description shows now…' line on an open store. Check all six palettes' names and colours on phone and desktop (the drill only saw Slate and Forest). [P6-BRAND, P6-PALETTE]
- [ ] A store name that is only emoji or unspaced Devanagari: hero title and alt text end on a whole character (phone and Safari). [P6-FIX1]
- [ ] Hero with an image, preview bar and colours toggle, and a policy page on a real phone and Safari. [P2-DRILLS]
- [ ] Preview banner, 'preview ended' bar, the offline line and 'Edit this page' on a real phone. [P3-FRAME]
- [ ] Closed store 'Opening soon' page on a real phone; closed page in Safari and on a phone. [P3-CLOSED, closed-store branch]
- [ ] On a phone and installed app with a tab open when maintenance starts, tap a product; decide whether what shows until reload is OK. [closed-store branch]
- [ ] Phone Safari: dashboard sync card readable, Try again works. [GEN-02]
- [ ] iPhone Safari: create and edit a discount code with no sideways scroll; pickers work; the two 'Name in the cart' lines stack. [COM-03]
- [ ] Safari and phone: the Publishing warnings banner and Media 'Still referenced' dialog wrap; Settings and Publishing show saved values at once with no sideways scroll. [DOC-04, FIX-C]
- [ ] Wishlist '?' placeholder, policy page links and applied coupon words readable in daylight on your phone. [P1-CONTRAST]
- [ ] Mid-range phone: note a collection page's download size with full-size library photos; if too heavy, move the smaller-copies work up. [P1-IMAGES]
- [ ] Designer with a hero test running, Mac and iPhone Safari: your title in both tabs, the purple note reads well, 'See the test' opens Experiments in a new tab. [PV-08]
- [ ] Change list in the Publish panel and Undo confirm box at 375px. [P3-DIFF]
- [ ] Section tree inside the editor's drawer below 1280px. [P3-TREE]
- [ ] Mac Safari: harness storefront and Designer render and connect; at full screen and 1100 wide the tree, preview and settings sit right, the drawer works by keyboard and Escape. [P1-HARNESS, ED-01]
- [ ] iPad landscape: Sections drawer works by touch, preview at least 600px. [ED-01]
- [ ] Your own laptop (1366 or 1280 wide, under 900 tall): no page scroll, panels scroll on their own, preview readable. [ED-01]
- [ ] Always-visible scroll bars at 1440 and 1366: preview at least 900px at 1440, nothing sideways, no control cut off. [ED-01]
- [ ] New-editor preview on phone and desktop: banner and hero with off-store buttons and a failing section show their notes in preview only. [P3-VALIDATE]
- [ ] A screen reader reads the header logo as the home link, using the alt text or the store name. [P6-LOGO-RENDER]

### Desktop Chrome drills not yet run
- [ ] Harness, new-editor test store: Publishing shows 'This store publishes with the new editor', the sidebar badge counts, the Storefront note shows, old editors' saves refuse plainly. [P2-GUARD]
- [ ] Hero variant and AI hero idea on an old-editor store keep buttons and badge; on a new-editor store the change lands in the draft only. [P2-WRITERS]
- [ ] New-editor preview: bar words, Show/Hide toggle, empty banner placeholder, private window sees only live content. [P2-PREVIEW]
- [ ] An unfinished banner or rail shows 'not finished yet' and clicking selects it. [P2-SECTIONS]
- [ ] Publish a policy typo fix while the home draft has unsaved changes. [P2-PUBLISH]
- [ ] Log out and reload a preview tab: live store with no bar; on an old-editor store the Designer preview returns after signing in. [P3-SESSION]
- [ ] Editor preview opens with the cookie set by the confirm request, no request for '/', draft in the frame; a broken token shows 'didn't open'. [P3-FIX1]
- [ ] Close a tab mid-save, reopen, reload twice without answering the 'edits that weren't saved' offer: still offered, leaving warns. [P3-STORE]
- [ ] Keep typing during 'Use the newer version'; Earlier versions shows the extra text as 'Kept from another tab'. [P3-STORE]
- [ ] A menu link to a page changed to Campaign blocks publishing with a missing-page note. [P3-INSPECTOR]
- [ ] Add, move, hide, show, copy and delete every section kind; new sections are selected; greyed-out tooltips read well. [P3-TREE]
- [ ] Publish panel pieces: take offline with linking pages, whole-set Undo with a page going offline ('Undo all N pages… \"<page>\" goes offline.'), Earlier versions restore, offer review, republish, Recently published without Undo on rows that can't be undone. [P3-PUBLISHUI, P3-FIX3]
- [ ] Real paste from a live Shopify product page and from Word into rich text: words, bold and links survive; a refused paste shows the note and 'Edit as HTML'. [P3-RTE, P3-FIX4]
- [ ] Slow connection: open product A, click B then quickly C; ends on C, never stuck on 'Opening C…', no Publish buttons while opening. [P4-FIX5]
- [ ] Slow connection: while product B opens, pick a section of another page; it opens with that section and field focused. [P4-FIX6]
- [ ] Open a product with an unpublished draft and save; 'up to date' only once the page shows the draft. [P4-FIX2]
- [ ] Old-editor Media: delete a file used by an old home section and a page draft: no 'Delete anyway', places listed plainly. [P4-FIX2]
- [ ] Upload a file identical to an archived one: '<file> was archived. It's back in your library now.' [P4-FIX2]
- [ ] With the live release unreadable on a local copy, editor pickers still list products. [P4-FIX4]
- [ ] A page with an old banner shows the note and publishes. [P4-ED05]
- [ ] Renamed product in pairs and pinned lists shows the new name with 'Shopify title: …' under it. [P4-PICKER]
- [ ] Design editor frame doesn't offer 'Hide them'; the home page still does. [P4-EDITOR]
- [ ] Catalog page on a new-editor store says brand and product type are set in the editor. [P4-FIX3]
- [ ] Setup page of a new new-editor store before and after first publish, and the preview test order. [P4-PROVISION]
- [ ] Bundles not drilled: overlap warning only opens the field; 'You can't see bundles here.' and 'Ask an owner to create bundles.'; /bundles/ page for a 1.5 quantity; a full grid of 12; a sold-out bundle that also saves nothing shows the founder note only in preview. [P5-DRILLS, P5-BLOCKS]
- [ ] Re-run the pick, create and console bundle drills after P5-FIX2 (`node scripts/drills/p5/run.mjs pick,create,console`): 'Checking this bundle…' beyond 50, the dialog names /bundles/bundle after cancel, Create off on a grid of 12 and with a 0 quantity, 'Pick again' on an old row. [P5-FIX2]
- [ ] Accept the test-only proof of section data sources, or ask for a browser check. [P5-SOURCES]
- [ ] Press 'Refresh from Shopify' on an open store: /admin/start keeps the 'already open' words, links and sync note. [P6-START-UI]
- [ ] Edit a product description on a closed store and publish: normal review, publishes, store stays closed. [P6-OPEN-UI]
- [ ] 'Logo and colours' after Editor in sidebar and phone menu opens the brand step; Settings logo hint and link work on new-editor stores, unchanged on old ones. [P6-NAV]
- [ ] Store in maintenance mode at 1440: does its dark background show? [P3-CLOSED]
- [ ] Optional: header and footer look as before with and without own menus. [P2-PERF]

### Optional runs on your Mac
- [ ] Design harness (`pnpm dev:design`, open http://localhost:3017 signed out, `pnpm seed:design` in a second terminal, then stop and check ports 3017 and 18017-18019 are free). [P1-HARNESS]
- [ ] Phase 3 smoke (`scripts/drills/p3/smoke.mjs`) and closed.localhost; phase 3 routes drill and its failed-push screenshot. [P3-HARNESS, P3-ROUTES]
- [ ] Phase 4 harness seed and smoke, then the full phase 4 drill (about 25 minutes) and its screenshots; re-run the page comparison twice with --compare. [P4-HARNESS, P4-DRILLS, P4-EQUIV]
- [ ] Phase 5 drills (about 7 minutes) and screenshots in docs/cms-reviews/drills/P5-DRILLS/. [P5-DRILLS]

---

## 7. Legal and shopper wording

Read each as a founder would. Legal ones first.

- [ ] Privacy and returns starter pages on a store with a non-default returns window: the privacy page's '30 days' and 'cookie settings' promises; the returns starter drops '5-7 working days'. They say they are starting points, not legal advice. [OQ-25, GEN-06]
- [ ] Returns refund line 'Refunds go back to the original payment method.' with no day count; may need changing for cash-on-delivery stores. [P6-POLICY-START]
- [ ] Not yet linked to settings: FAQ delivery days, payment methods, the 'reply to your order confirmation email' return hint, and the old list's refund timing. [P6-POLICY-START]
- [ ] Returns window edge cases: a negative window gives 'We don't accept returns on orders.'; 10.5 days shows '10 days'; 0.5 shows '12 hours'. [P6-FIX1]
- [ ] Reversal report's 'A message you can pass on' and the reversal dry run's '…kept there only as an older version'. [P4-REVERSE, P4-FIX6]
- [ ] Checkout: 'Shipping changed — your new total is Rs 1,507. Review and place order.' and 'Your total changed — …'. [P1-RATES]
- [ ] Bundle page 'This bundle isn't available right now.' now also shows when the price saves nothing. [P5-DRILLS]
- [ ] Sync wording ('Bring in products', 'Refreshing your products from Shopify', '…didn't finish', 'Your store keeps everything it had…') and hiding a running refresh once products exist. [GEN-02]
- [ ] Offer wording: 'Save changes' for an off offer, new offers start on, default names, and the warn-only typed-name check. [COM-03]
- [ ] Both A/B test notes, including '(opens in a new tab)'. [PV-08]
- [ ] Earlier versions names: 'Someone on your team', 'Storeasy', or a teammate's email. [P2-DOCS]
- [ ] Publish messages: 'Publishing is busy…', 'Your publish may have gone live. Reload to check.', 'address taken', 'Someone else published this page at the same moment…'. [P2-PUBLISH]
- [ ] Preview words: colours note and toggle, other-tab note, unfinished-section note; 'You're seeing your unpublished changes.' / 'See the live store'; 'Your preview has ended…' / 'Exit'; 'This page is offline. Publishing it brings it back.'; 'Edit this page'. [P2-PREVIEW, P3-FRAME]
- [ ] Hero-race wording, and show the server's note on the theme screen instead of its own toast. [P2-FIX4]
- [ ] 'Only the store owner or an admin can publish.' [P3-COMMIT]
- [ ] Change-list words ('Old addresses that lead here', 'Showing dates', 'Look: applied again', 'Banner 2', 'Fonts' meaning text size). [P3-DIFF]
- [ ] New messages and three refusals in the publish checks, and 'another tab' in lower case. [P3-CHECKS]
- [ ] Two 'Keep the live version' errors ('…never been published…' and '…no longer in this page…'). [P3-CHANGES]
- [ ] Three draft size-limit messages. [P3-FIX1]
- [ ] Section tree refusals ('The home page already has a hero…', 'Only one section can sit above…') and badges 'Unfinished', 'Needs a fix', 'Hidden'. [P3-TREE]
- [ ] Publish panel levels 'Must fix', 'Check', 'Already live like this', the two offer reasons, 'Make your home page first', the republish question, 'Live now' and 'Offline now'. [P3-PUBLISHUI]
- [ ] Rich text: the 'words lost… < or > signs' message for hidden-markup pastes; which tags the refusal names; the tag-naming refusal words; the theme screen's 'hero look wasn't added' note; 'can't be published yet' on AI apply and experiment adopt. [P3-RTE, P3-FIX4, P3-FIX5]
- [ ] Local backup note 'Edits this browser kept'. [P3-FIX5]
- [ ] Dry run 'Not ready' line says 'Settings > Team' but the panel is 'Agency access'; needs fixing. [P4-DRILLS F3]
- [ ] Bundle words: publish summary rows ('Bundle grid: added a bundle'); hidden-section notes ('<Label>: hidden from shoppers' and the broken-section note); the no-saving note winning over sold-out; publish warnings (a deleted bundle is named by raw id, decide); '…so shoppers don't see it'; status chips and form lines; P5-FIX2's 'We couldn't check whether your home page uses this bundle…' and 'Pick again'. [P5]
- [ ] Logo deleted: the publish warning uses picture wording; accept or ask for logo wording. [P6-LOGO-REG]
- [ ] Closed store preview bar 'Your new colours are shown here.' [P6-LOGO-RENDER]
- [ ] Sync refilling an open draft gives a 'changed somewhere else' conflict message. [P6-GEN-WRITE]
- [ ] 'This page was already saved, so it already counts as reviewed…' [P6-FIX1]
- [ ] Setup checklist words ('Start your store', design hints, legal-page hints, Launch hint) and the failed-check line 'We couldn't check your privacy and returns pages just now…'. [P6-ONBOARD, P6-FIX3]
- [ ] Half-finished first-run words (start page and the first-run API) and which cases offer 'Try again'. [P6-FIX2, P6-FIX3]

---

## 8. CI and infrastructure

- [ ] Approve the database test server (sqld) download for GitHub test runs: libsql release libsql-server-v0.24.32, the x86_64 Linux file, with a SHA-256 checksum you compute yourself; then add the step from docs/cms-reviews/P2-ATOM.md to .github/workflows/test.yml. Until then pushed runs fail on the suites that need it. Every phase from 2 to 6 repeats this. [P2-ATOM … P6-FIX3]
- [ ] Push a branch and watch the test run pass; push a throwaway branch with a Shopify product-write call in lib/ and see the Shopify boundary test fail. [SHOP-01]
- [ ] Confirm the main control database on staging and production is one Turso location read over the network, with no embedded copy or read replica for console reads. [FIX-C]
- [ ] Confirm the hosted scheduler runs background jobs often enough for search reindex retries, and set the job runner's address and secret. [P4-SEARCH, GEN-02]
- [ ] Consider adding the runbook check (`node scripts/drills/p4/runbook.mjs --check`) to `pnpm test`. [P4-DRILLS]
- [ ] The build once failed downloading the Fraunces font, and was not rerun after the rich text fix round; check the font download first if CI fails. [P3-PUBLISHUI, P3-RTE]
- [ ] Watch the flaky 'tenant migrated while the instance is warm' test. [P6-DRILLS]
- [ ] Product editor tests leave .test-pe-*.db files in the repo folder; ask for cleanup. [P6-DRILLS]

---

## 9. Other

### Engineering follow-ups to assign
- [ ] Add the two 'store closed' checkout messages to the shopper error file, so preview shows 'cash on delivery only'. [P3-CLOSED]
- [ ] Product rail must use a real 'products available' count per collection (an empty-in-stock collection can still be picked). [P3-TREE]
- [ ] Publish check treats an unchanged link as live even when the same publish hides or renames its page. Assign an owner. [P3-FIX2]
- [ ] Catalog and upsells saves answer the 'being updated' refusal with 422, and upsells delete with 500; they should use the proper error. [P4-GUARD]
- [ ] Editor should understand ?list=products and ?list=pages and link to /admin/editor/templates. [P4-ED05]
- [ ] Agency kit export still reads the old hero, announcement and home sections on new-editor stores. [P4-ED05]
- [ ] The move's test must import the allowed-differences list and pass hero experiments when replaying fixtures. [P4-EQUIV, P4-FIX4]
- [ ] Check the out-of-date backfill fixture writes the same live-row fields as the old editor. [P4-FIXTURES]
- [ ] The six 'shoppers can't see it' rules may move into the allowed-differences file. [P4-MAPPER]
- [ ] Operator commands don't load .env.local; if the hosted move needs it, package.json changes. [P4-SCAFFOLD]
- [ ] The Home tab hiding another tab's unpublished colours waits for the per-tab preview overlay. [P4-EDITOR]
- [ ] Make sure the Setup checklist's first publish still includes the design. [P6-OPEN]
- [ ] The banned-word scan also flags 'review' as a verb; founder text must turn the check off or avoid it. [P6-FIXTURE]
- [ ] The closed page sets lime as its accent; keep in mind if the accent is ever used. [P6D-5]
- [ ] The theme route answers a hero conflict with 422 instead of 409 (nothing is overwritten). Known limit. [P2-WRITERS]
- [ ] Re-run the runbook drill stage so its results carry the new label and step 0.3 wording checks. [P4-DRILLS]
- [ ] On a production build, the editor opens only one preview session each time; editor click markers appear in a new-editor preview. [P3-FIX5, P3-FRAME]
- [ ] Optional: add the real-server Undo probe to the Undo tests. [P3-FIX3]
- [ ] The Undo fix was not re-checked by the mutation test runner, so its proof is weaker than usual. [P3-UNDO]
- [ ] Developer note: if the hidden 'why this section failed' field becomes a normal field, one test must change. [P5-SOURCES]

### Reviews and housekeeping
- [ ] Have code owners review the round 2 catalog read changes (storefront layout, repo, section data, experiments). [P2-PERF]
- [ ] Review three files changed outside the plan for the backup note (editor store, documents API, versions). [P3-FIX5]
- [ ] Merge shared test file edits with their owners (test-preview-overlay, test-documents, test-failure-matrix, test-schema-compat, test-writers, test-cms-api, test-publish-service, test-api-shapes), keeping every side. [P3]
- [ ] Add each item's extra touched files to its file list in the batch files. [P4]
- [ ] Delete any old local-stores folder from before the harness fix (e.g. .design-data/p4-local) once by hand. [P4-HARNESS]
- [ ] Run the five timed founder tasks with 5 real founders, read aloud, no help (the drill only timed a script). [P3-DRILLS]
- [ ] No action: several 'staging not needed' notes (test scaffolds, change list, harness, section tree) touch no database.
