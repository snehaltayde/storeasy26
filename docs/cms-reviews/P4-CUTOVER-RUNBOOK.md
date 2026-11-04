# Moving a store to the new editor: the owner's runbook

This is the owner's checklist for moving ONE existing store from the old editor (Storefront, Catalog, Upsells, Releases) to the new editor. Builders never run these steps against a real or hosted store. New stores made after P4-PROVISION already start on the new editor and need none of this: the command refuses them with "This store already uses the new editor".

Every command below is run on your own Mac, in your checkout, with the environment loaded from `.env.local` (the package scripts carry no `--env-file`). Without a database address the command refuses; it never makes a local file instead. Replace `X` with the store's id.

```
node --env-file=.env.local scripts/migrate-documents.js --tenant X …
```

Nothing here ever writes to Shopify.

## 0. Once, before the first store: the database updates and their order

1. Apply the database updates to every store (the env store with `pnpm migrate`), then check them all, the env store included (these package scripts load `.env.local` themselves):
   ```
   pnpm tenant:migrate -- --all
   pnpm tenant:migrate -- --check --include-env
   ```
   The check must say every store is current.
2. Deploy order: **0023 before any code that writes refs**; **0024 and 0025 before the batch 2 code deploys**. Do not deploy code that needs a database update before that update has run everywhere.
3. **Staging check of hosted batch atomicity (Turso), before the first real move.** On a staging store, set the store to "being updated" and try an old-editor save: it must answer "Your store is being updated. Try again in a few minutes." and save nothing. This proves a refused statement rolls back its whole batch on Turso over HTTP, as it does on the file database and on sqld. Put the store back afterwards.
4. Confirm your Turso plan has **point-in-time restore (PITR)**. Without it there is no disaster path; do not move a store.

## 1. Pick a quiet window and warn the founder first

Pick a **quiet window** (few orders, nobody editing) and **warn the founder first**, in these words or your own:

> "We're moving your store to the new editor at <time>. It takes a few minutes. While it runs, editing pauses (the old editors won't save) and the catalog copy from Shopify waits. Your shop stays open: shoppers see it exactly as now and can buy as usual. We'll tell you when the new editor is ready."

Also confirm with the team: after the move, staff can still change the cart offer, but an owner or admin has to publish it (the dry run lists this under "Team access that changes").

## 2. The backup: Turso point-in-time restore

The restore-drill copy (step 3) is a **verification copy, not a backup**. The backup is Turso's point-in-time restore.

1. Just before the real command (step 6), record the time, in UTC, to the second, for example `2026-11-04T10:15:00Z`. Pass it as `--backup-ref`. The command records it in the run.
2. The disaster restore, written out (from `scripts/restore-drill.js` and `docs/platform-guide.md` 5.3b):
   ```
   turso db create <new> --from-db <db> --timestamp <iso>
   ```
   with `<db>` the store's Turso database, `<new>` a new database name, and `<iso>` the time you recorded. Then **repoint the store** at the new database (its control-plane row: `dbUrl` and its token), and check the shop opens.
3. **The supported way back is the reversal tool** (`pnpm reverse:documents`, section 9), not a restore. A PITR restore is the disaster path: it **loses every order** (and every other write) placed after that time. Use it only if the reversal tool can't help.

## 3. A restore-drill copy, served by the local harness

The rehearsal runs on a copy of the store on this machine, never on the store itself.

1. Make the copy (read only on the hosted store):
   ```
   node --env-file=.env.local scripts/restore-drill.js --tenant X --keep
   ```
   It writes `restore-drill-X.db` at the checkout root. **It holds customer data**: keep it on this machine, never commit, upload or share it, and delete it (and its `-wal` and `-shm` files) when the rehearsal is done.
2. Serve the copy with the local harness so a browser can see it: start the harness (`pnpm dev:design`, on its own ports), load the copy into a local sqld database, and point a local control-plane row for store `X` (same id, same config) at that sqld. The page comparison captures from that harness address (`http://localhost:<port>`), and the copy is the `--db` of step 5. The drill for this item (`docs/cms-reviews/P4-CUTOVER.md`, "Drill") does exactly this on the harness and lists the commands.
3. Make the route list for the comparison (it reads the local copy only):
   ```
   node scripts/migrate-render.mjs --make-routes routes.json --tenant X
   ```

## 4. The dry run, with the founder

```
node --env-file=.env.local scripts/migrate-documents.js --tenant X --dry-run --hosted --confirm X
```

Add `--store-open` for a store that never published but whose shoppers see it today, or `--not-launched` for one that never published and isn't open. The command never guesses: without the flag such a store is "Not ready".

Read the plain report with the founder. It must say **Ready to move**. Keep the last line, `Dry-run digest: <digest>`: the real command needs it, and refuses if the store changed since (run the dry run again then).

## 5. The rehearsal, on the copy

```
node --env-file=.env.local scripts/migrate-documents.js --tenant X --rehearsal-run --db <the copy's local address> \
  --base http://localhost:<harness port> --routes routes.json --out rehearsal-X
```

It captures every route as a shopper before the move, moves the copy (all steps), captures again, compares the pages (only the differences in `lib/migrate/allowed-differences.js` are set aside), and writes `rehearsal-X/rehearsal.json`. It never writes to the control plane or to search. It must end with **Result: passed**. A page that doesn't load before the move, or a comparison of no pages, is never a pass.

## 6. The real move

Record the backup time (step 2), then, straight away:

```
node --env-file=.env.local scripts/migrate-documents.js --tenant X --dry-run-digest <digest> --rehearsal rehearsal-X/rehearsal.json \
  --hosted --confirm X --backup-ref <the time you recorded>
```

(plus `--store-open` or `--not-launched` if the dry run needed it). The command itself checks, before it changes anything: the store is on the old editor; its database holds the 0021 to 0025 updates; no catalog copy is running; no release is scheduled; the live store reads; no approvals or agency access; no address clash; every kind of content has an editor; the digest is the current dry run's; the rehearsal passed for this very content. Each failed check is a plain "Not moved: …" and nothing changes.

Then it pauses the store, checks again, copies the content into the new editor, compares the copy with the live store for every part a shopper sees, and only if nothing differs switches the store in one step. Last, it records the store's look in the control plane (the theme pin: a control-plane write, so it needs the control plane's token in your environment) and asks search to update.

## 7. Post-checks

1. **Shopper canaries**: open the home page, a page, the journal, a product with extra sections, a product with "goes well with" products, a pinned collection and the cart, as a shopper (a private window). They look as before.
2. **Editor opens**: sign in as the founder; the console opens the new editor; the home page, a product and a collection open; the old screens (Storefront, Catalog, Upsells) lead to the editor.
3. **Theme pin**: the platform console shows the store's kit. The command's report says "Recorded." under "The store's look".
4. Tell the founder the new editor is ready. Give them the report's "Unpublished changes that will carry over as drafts" and "Drafts kept as older versions".

**What shoppers see if the database is slow, on the new editor.** On a store that uses the new editor, if reading a product's own extra content fails, that product's page shows the error page instead of the product (its sections, badge and template fail closed); on a collection page, a failed read of its pinned products shows the error page too; the "goes well with" strip and the page layout fall back to the defaults where they can. On the old editor a failed read hid only those extras. Watch the error rate on product and collection pages for the first day.

## 8. If anything stops midway

```
node --env-file=.env.local scripts/migrate-documents.js --tenant X --status --hosted --confirm X
```

It says, in plain words, whether the store is being updated, which step finished, when it started and how long it has taken, and what to run next:

- `--resume` carries on from the recorded step (give the same proofs as the real move). A run that stopped after the switch only finishes its last steps (theme pin, search).
- `--abort` (before the switch only) puts the store back on the old editor in one step: the old editors save again and the catalog copy carries on. What was already copied stays in the new editor's tables, unseen by shoppers; the next move takes the old editor's content again.
- After the switch `--abort` refuses and names the reversal tool.

While a store is being updated, every old editor refuses and the full catalog copy waits with no end time, so never leave a store in that state: resume or abort.

## 9. Going back: the reversal tool

The supported way back is `pnpm reverse:documents` (P4-REVERSE adds its own section here: what the founder loses, the words to pass on, and its own status and abort). A PITR restore (step 2) is the disaster path only.
