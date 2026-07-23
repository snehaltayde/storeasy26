// Ops CLI for the Shopify order push (Session 12).
//   pnpm push:shopify              # sweep the queue (respects backoff/dead-letter)
//   pnpm push:shopify BL-XXXXXXXX  # push one order now
import { pushOrderToShopify, runSyncSweep } from "../lib/shopify-push.js";

const orderId = process.argv[2];
const result = orderId ? await pushOrderToShopify(orderId) : await runSyncSweep({ limit: 20 });
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok === false && !result.pushed ? 1 : 0);
