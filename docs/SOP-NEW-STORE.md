# SOP: set up a new store with its own Shopify custom app

Who runs this: a Storeasy operator (platform console, https://storeasy.in/platform).
Time: about 20 minutes, plus the founder's onboarding.
Example used below: a store called **Acme**, address `acme.storeasy.in`, Shopify store `acme.myshopify.com`.

## What you need before you start

- The founder's email, and the store's `.myshopify.com` address.
- Access to the Shopify **Dev Dashboard** for the account (organisation) that will own the app. This is either the founder's own organisation, with you added as a member, or Storeasy's organisation.
- Your operator login: email, password and authenticator code.
- The `ff_self-signup` flag does **not** need to be on: operators can create stores while public signup is closed.

## Part A: create the custom app in Shopify (Dev Dashboard)

1. Open the Shopify Dev Dashboard for the organisation that will own the app, and choose **Create app**. Name it `Storeasy – Acme`.
2. Open **Versions → Create a version** and fill it in:

   | Setting | Value |
   |---|---|
   | App URL | `https://storeasy.in` |
   | Embed app in Shopify admin | Off |
   | Allowed redirection URLs (all three) | `https://acme.storeasy.in/api/admin/shopify/callback` (founder connects from their console)<br>`https://storeasy.in/api/connect/shopify/callback` (operator connects from the platform)<br>`https://www.storeasy.in/api/connect/shopify/callback` |
   | Access scopes | `read_products, read_orders, write_orders, write_draft_orders, unauthenticated_read_product_listings, unauthenticated_read_product_inventory, unauthenticated_read_product_tags` |
   | Webhooks | Leave empty. Storeasy subscribes its own after connecting. |

   If the store later gets its own domain (for example `shop.acme.com`), add `https://shop.acme.com/api/admin/shopify/callback` too. The store's row in the platform console lists every redirect URL it needs.
3. **Release** the version.
4. Open **Distribution → Custom distribution** and enter `acme.myshopify.com`. Keep the install link; the founder doesn't need it, because Connect does the install.
5. Open **Settings** (or **Client credentials**) and copy the **Client ID** and **Client secret**. Keep the secret in a password manager; never paste it into chat or email.

## Part B: create the store in Storeasy (platform console)

1. Sign in at https://storeasy.in/platform.
2. Go to **Platform operations → New store**.
3. Fill in the form:
   - **Owner's email:** the founder's email. The invite goes here.
   - **Founder's name** (optional).
   - **Store name:** Acme.
   - **Shopify store:** `acme.myshopify.com`.
   - **Store address:** leave it as suggested (`acme`) or change it. It must match the redirect URL you used in Part A.
   - **Shopify app:** paste the client id and client secret from Part A, step 5.
4. Press **Create store**. Setup takes about a minute and runs these steps: create the database → prepare the store → register the address → send the invite.
5. If it shows **Setup stopped**, read the step that failed (Signups & onboarding shows the alert), fix it, then press **Try again**. Common causes are in the troubleshooting section below.
6. When it says **Acme is ready**, check that the redirect URL shown there is in the app's list from Part A.

## Part C: the founder finishes onboarding

1. The founder opens the invite email (sent from `hello@storeasy.in`), sets a password and signs in at `https://acme.storeasy.in/admin`.
2. **Step 1, Connect Shopify:** they press Connect, approve the app in Shopify, and come back. Storeasy checks that every scope was granted and subscribes its webhooks.
3. The first product sync starts automatically. Progress shows in **Settings → Sync**.
4. They pick a theme, review the drafted pages, and press **Publish** when ready. Nothing goes live until they publish.

The operator can also connect it for them. While signed in to the platform console, open `https://storeasy.in/api/connect/shopify/start?tenant=acme` (there is no button for this yet).

## Part D: checks before handing over

- [ ] `https://acme.storeasy.in` loads.
- [ ] **Settings → Sync** in their console shows products and collections, with a recent sync time.
- [ ] The store's row in the platform console shows Shopify connected and no open alerts.
- [ ] A test order on a test product reaches Shopify as an order. Use snehal@mediastic.in for test orders and cancel them afterwards.
- [ ] The founder has received their invite.

## Changing an app's credentials later

- **Operator:** go to **Platform → Stores → the store's row → Edit**. Change the Shopify domain, client id or client secret. Leave the secret empty to keep the current one. Each change is recorded in the audit log.
- **Founder (owner or admin):** go to **Settings → Sync → Reconnect** to redo the Shopify connection, for example after the app was uninstalled.

After you rotate a secret in Shopify, update it in Storeasy straight away. Until you do, webhooks fail their signature check and syncing stops.

## Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| Shopify: "The redirect_uri is not whitelisted" | The URL you connected from isn't in the app's allowed redirection URLs | Add the exact URL from Part A (it must match `https://`, the host and the path), release a new version, then try again |
| Setup stopped at "Creating your store's database" with "already exists" | An old Turso database with the same name (`storeasy-t-<address>`) exists | Choose another store address, or delete the old database in Turso if it's truly unused (that can't be undone) |
| "Missing scopes" after connecting | The released app version lacks a scope | Add the scope, release a new version, then Reconnect |
| Invite not sent | Mail provider problem | Check Resend; the sender domain `storeasy.in` must stay verified; then press **Resend invite** |
| Products don't appear | Sync not run yet, or a token problem | **Settings → Sync → Run sync**; if it fails, Reconnect |

## Notes

- Storeasy never writes storefront content back to Shopify. It only reads the catalog and creates and cancels orders.
- Compliance (privacy) webhooks aren't set in the Dev Dashboard anymore, and custom-distribution apps don't need them. Privacy requests are handled from the platform console.
