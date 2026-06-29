// Mint a long-lived Storefront API token. Resolves an Admin token from either
// SHOPIFY_ADMIN_TOKEN (OAuth) or the client-credentials grant, then calls
// storefrontAccessTokenCreate.
//   pnpm shopify:token            # print the token
//   pnpm shopify:token --write    # also save it into .env.local
import { getAdminAccessToken, mintStorefrontToken } from "../lib/shopify-admin.js";
import { upsertEnv } from "../lib/env-file.js";

const WRITE = process.argv.includes("--write");

async function main() {
  console.log("→ resolving Admin token → minting Storefront token…");
  const adminToken = await getAdminAccessToken();
  const token = await mintStorefrontToken(adminToken);
  console.log(`✓ minted Storefront token:\n  ${token}`);

  if (WRITE) {
    await upsertEnv({ SHOPIFY_STOREFRONT_TOKEN: token });
    console.log("✓ wrote SHOPIFY_STOREFRONT_TOKEN to .env.local — now run `pnpm sync`");
  } else {
    console.log("  (re-run with --write to save it into .env.local)");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ mint failed:", err.message);
  console.error(
    "  Fix: run `pnpm shopify:oauth` to get an Admin token (works for any store), " +
      "or ensure client-credentials eligibility (same-org dev store) + unauthenticated_read_product_listings scope.",
  );
  process.exit(1);
});
