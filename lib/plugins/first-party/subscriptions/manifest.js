// Phase 9 line 2: Subscriptions. Shoppers subscribe to a product on its page
// and pay for each delivery when it is due, at a checkout priced that day
// (decision 8: scheduled re-orders through the jobs tick; nothing is charged
// automatically). It reads nothing outside the store and sends nothing out
// (no scopes, no egress); its sweep (./sweep.js, lib/plugins/sweeps.js) marks
// deliveries due, emails reminders and handles missed ones. Pure and
// Edge-safe: the pricing (lib/subscriptions/pricing.js) reads these settings.
import { defineManifest } from "../../manifest.js";

const every = (days, on) => ({ key: `every_${days}`, kind: "boolean", label: `Offer every ${days} days`, default: on });

export default defineManifest({
  id: "subscriptions",
  name: "Subscriptions",
  version: "1.0.0",
  summary: "Let shoppers subscribe to a product and pay for each delivery when it's due, with an optional discount.",
  description:
    "Subscriptions adds a \"Subscribe and save\" choice to eligible product pages. A subscriber gets an email a few days before each delivery is due and pays for it from their account, at that day's price, by online payment or cash on delivery. Nothing is charged automatically. Subscribers can skip, pause, swap or cancel from their account.",
  icon: "Puzzle",
  author: { name: "Storeasy" },
  scopes: [],
  settings: [
    { key: "discount_percent", kind: "number", label: "Subscriber discount (%)", min: 0, max: 30, default: 0 },
    every(14, false),
    every(30, true),
    every(45, false),
    every(60, true),
    every(90, false),
    { key: "eligible", kind: "choice", label: "Products shoppers can subscribe to", options: ["all", "tag"], default: "all" },
    { key: "eligible_tag", kind: "text", label: "Product tag (when only tagged products)", max: 60 },
    { key: "reminder_days", kind: "number", label: "Reminder, days before a delivery is due", min: 1, max: 7, default: 3 },
    { key: "grace_days", kind: "number", label: "Days to pay after a delivery is due", min: 1, max: 14, default: 7 },
  ],
});
