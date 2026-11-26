// Phase 9 line 3: WhatsApp, a first-party plugin. Order updates (placed,
// shipped, delivered) to shoppers who asked for them, and one cart reminder to
// shoppers who agreed to marketing messages. Nobody else gets anything.
// orders.read for its three order events; order.delivery_updated is internal
// and reaches this plugin only through topics.js FIRST_PARTY_INTERNAL.
// Pure and Edge-safe (the catalog loads it).
import { defineManifest } from "../../manifest.js";

export default defineManifest({
  id: "whatsapp",
  name: "WhatsApp messages",
  version: "1.0.0",
  summary: "Send order updates and a cart reminder on WhatsApp, only to shoppers who said yes.",
  description:
    "WhatsApp messages sends a short message when an order is placed, shipped and delivered, and one reminder for a cart left behind. A shopper gets order updates only after ticking \"Send my order updates on WhatsApp\" at checkout or in their account, and a cart reminder only after also ticking \"Also send me offers and cart reminders on WhatsApp\". Both start unticked. Every message carries a link to stop messages, and replying STOP works too. Messages use your own WhatsApp Business number and the templates you approve here; nothing sends until you approve a template.",
  icon: "MessageCircle",
  author: { name: "Storeasy" },
  scopes: ["orders.read"],
  settings: [
    { key: "phone_number_id", kind: "text", label: "WhatsApp phone number ID", max: 20, placeholder: "From Meta's WhatsApp Manager" },
    { key: "access_token", kind: "secret", label: "Access token" },
    { key: "app_secret", kind: "secret", label: "App secret (checks Meta's webhook signatures)" },
    { key: "verify_token", kind: "secret", label: "Webhook verify token" },
    { key: "reminder_delay_hours", kind: "number", label: "Cart reminder after (hours idle)", min: 1, max: 24, default: 2 },
    { key: "daily_cap", kind: "number", label: "Most marketing messages a day (whole store)", min: 1, max: 1000, default: 200 },
  ],
  events: ["order.created", "order.fulfilled", "order.delivery_updated"],
  egress: ["graph.facebook.com"],
});
