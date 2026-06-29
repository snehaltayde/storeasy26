// One-time OAuth (authorization-code grant) for the Dev Dashboard app, for a
// store that ISN'T in the app's org (client-credentials returns shop_not_permitted).
// Captures the callback locally, saves a PERMANENT Admin token, then mints the
// Storefront token — both written to .env.local.
//   pnpm shopify:oauth
import http from "node:http";
import crypto from "node:crypto";
import { exchangeCodeForToken, mintStorefrontToken } from "../lib/shopify-admin.js";
import { upsertEnv } from "../lib/env-file.js";

const domain = process.env.SHOPIFY_STORE_DOMAIN;
const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
const PORT = Number(process.env.SHOPIFY_OAUTH_PORT || 3456);
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPES = [
  "read_products",
  "read_orders",
  "write_draft_orders",
  "unauthenticated_read_product_listings",
  "unauthenticated_read_product_inventory",
  "unauthenticated_read_product_tags",
].join(",");

if (!domain || !clientId || !clientSecret) {
  console.error("Need SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET in .env.local");
  process.exit(1);
}

const state = crypto.randomBytes(16).toString("hex");
const authorizeUrl =
  `https://${domain}/admin/oauth/authorize` +
  `?client_id=${encodeURIComponent(clientId)}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  `&state=${state}`;

function verifyHmac(search) {
  const p = new URLSearchParams(search);
  const hmac = p.get("hmac") || "";
  p.delete("hmac");
  p.delete("signature");
  const message = [...p.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = crypto.createHmac("sha256", clientSecret).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
  } catch {
    return false;
  }
}

console.log("\n=== Shopify OAuth (authorization-code grant) ===");
console.log("STEP 1 — In the Dev Dashboard, add this Allowed redirection URL to the app:");
console.log(`         ${REDIRECT}`);
console.log("STEP 2 — Open this URL in your browser and click Install/Approve:");
console.log(`\nAUTHORIZE_URL: ${authorizeUrl}\n`);
console.log(`Listening for the callback on ${REDIRECT} (5 min timeout)…\n`);

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/callback")) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.searchParams.get("state") !== state) throw new Error("state mismatch");
    if (!verifyHmac(url.search.slice(1))) throw new Error("HMAC verification failed");
    const code = url.searchParams.get("code");
    if (!code) throw new Error("no authorization code in callback");

    console.log("→ exchanging code for a permanent Admin token…");
    const tok = await exchangeCodeForToken(code);
    await upsertEnv({ SHOPIFY_ADMIN_TOKEN: tok.access_token });
    console.log(`✓ saved SHOPIFY_ADMIN_TOKEN (permanent). Scopes: ${tok.scope}`);

    console.log("→ minting Storefront token…");
    const sfToken = await mintStorefrontToken(tok.access_token);
    await upsertEnv({ SHOPIFY_STOREFRONT_TOKEN: sfToken });
    console.log("✓ saved SHOPIFY_STOREFRONT_TOKEN — ready to `pnpm sync`");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<html><body style='font-family:system-ui;background:#0a0a0b;color:#fff;text-align:center;padding-top:18vh'>" +
        "<h2 style='color:#a3e635'>✓ Authorized</h2><p>Tokens saved. Close this tab and return to the terminal.</p></body></html>",
    );
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 400);
  } catch (e) {
    console.error("✗ callback error:", e.message);
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<html><body><h2>Authorization failed</h2><p>${e.message}</p></body></html>`);
    setTimeout(() => {
      server.close();
      process.exit(1);
    }, 400);
  }
});

server.listen(PORT);
setTimeout(
  () => {
    console.error("✗ timed out waiting for the callback (5 min).");
    server.close();
    process.exit(1);
  },
  5 * 60 * 1000,
);
