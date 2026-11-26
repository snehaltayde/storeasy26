// Phase 9 line 4: Shiprocket. Delivery dates from Shiprocket's courier
// estimate (only when the founder chooses it; the store's own shipping
// settings stay the default), and live parcel tracking on the order page.
// Fees and cash on delivery stay the store's own rules. Its one block,
// Tracking, starts switched off. Pure: the block's data is read on demand
// (./block.js), and nothing here calls Shiprocket.
import { defineManifest } from "../../manifest.js";

export const ESTIMATE_SOURCES = Object.freeze(["store", "shiprocket"]);

export default defineManifest({
  id: "shiprocket",
  name: "Shiprocket",
  version: "1.0.0",
  summary: "Show Shiprocket's delivery dates and live parcel tracking on your store.",
  description:
    "Connect your Shiprocket account with an API user. Shoppers can then see when couriers deliver to their PIN code, and follow their parcel on the order page. Your shipping fees and cash on delivery rules stay as you set them. Storeasy never changes anything in your Shiprocket account.",
  icon: "Truck",
  author: { name: "Storeasy" },
  scopes: ["orders.read"],
  egress: ["apiv2.shiprocket.in"],
  settings: [
    { key: "api_email", kind: "text", label: "API user's email", max: 120, help: "In Shiprocket: Settings → API → Configure → Create an API user. Use that user's email, not your own login." },
    { key: "api_password", kind: "secret", label: "API user's password", max: 200 },
    { key: "pickup_pin", kind: "text", label: "Pickup PIN code", max: 6, placeholder: "411001", help: "The PIN code your parcels are picked up from." },
    { key: "default_weight_g", kind: "number", label: "Usual parcel weight (grams)", min: 100, max: 30000, default: 500, help: "From 100 g to 30 kg. Couriers use it for their delivery estimate." },
    {
      key: "estimate_source",
      kind: "choice",
      label: "Delivery dates come from",
      options: [...ESTIMATE_SOURCES],
      default: "store",
      help: "Store: your shipping settings. Shiprocket: the couriers' own estimate for each PIN code. If Shiprocket doesn't answer in time, your settings are used.",
    },
  ],
  blocks: [
    {
      id: "tracking",
      label: "Tracking",
      primitive: "tracking_timeline",
      slots: ["storefront.order.status"],
      // the order the page already checked (its link or the shopper's session)
      data: async (ctx) => (await import("./block.js")).trackingProps(ctx),
    },
  ],
});
