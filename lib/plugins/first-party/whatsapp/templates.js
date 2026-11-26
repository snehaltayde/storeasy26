// Phase 9 line 3: Storeasy's default WhatsApp words, seeded as drafts (the
// founder edits and approves them in the WhatsApp card). Shopper-facing: no
// vendor names and no claims (test:whatsapp scans them with the shopper rules).
// Pure. The fields are lib/messaging/whatsapp.js VARS; {link} and {stop} are required.
const STOP_LINE = "To stop these messages: {stop}";

export const DEFAULT_TEMPLATES = Object.freeze({
  order_confirmed: `Hi {first_name}, thanks for your order {order} from {store}. Total: {total}. See your order: {link}\n${STOP_LINE}`,
  order_shipped: `Hi {first_name}, your order {order} from {store} is on its way. Track it: {link}\n${STOP_LINE}`,
  order_delivered: `Hi {first_name}, your order {order} from {store} has been delivered. Order details: {link}\n${STOP_LINE}`,
  cart_reminder: `Hi {first_name}, you left something in your cart at {store}. Pick up where you left off: {link}\n${STOP_LINE}`,
});
export const KIND_WORDS = Object.freeze({ order_confirmed: "Order placed", order_shipped: "Order shipped", order_delivered: "Order delivered", cart_reminder: "Cart reminder" });

