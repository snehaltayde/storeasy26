// Words and the API call for a store's lifecycle actions on the store page
// (Phase 3 line 2). Plain module: the suite reads it without a browser.

export const REASON_MIN = 5; // lib/platform/store-lifecycle.js REASON_MIN

// What the owner heard after a suspend or resume (the route's `mail`).
export const MAIL_WORDS = {
  sent: "The owner was emailed.",
  failed: "The email to the owner didn't send. Tell them another way.",
  not_configured: "Email isn't set up on this server, so the owner wasn't told. Tell them another way.",
  no_owner: "The store has no owner to email.",
};
export const mailWords = (code) => MAIL_WORDS[code] || MAIL_WORDS.failed;

// What suspending does; the dialog lists it (resume undoes each).
export const SUSPEND_EFFECTS = [
  "Shoppers see the store as unavailable. Nothing is deleted.",
  "The store's console closes for its team.",
  "Background jobs for the store wait until it is resumed.",
  "Other servers can take up to 30 seconds to apply it.",
];

// Who notices each rotation, said before the confirm. The order-link key signs
// more than order links (lib/orders.js, lib/customers.js, lib/releases.js,
// lib/maintenance.js); scripts/test-store-lifecycle.js keeps these words true.
export const ROTATE_EFFECTS = {
  order_link_secret: [
    "Shoppers are signed out of their accounts, and sign-in codes already sent stop working.",
    "Order links in earlier emails stop working.",
    "The team's preview links and maintenance passes stop working.",
    "Other servers may still accept old links for up to 30 seconds.",
  ],
  admin_password: ["Team: the old console password stops working; give them the new one."],
};

// lib/platform/export.js offboardTenant, in order.
export const OFFBOARD_STAGES = [
  "Suspend the store (storefront and console close).",
  "Rotate the order-link key and the console password: shoppers are signed out, and order, sign-in and preview links stop working.",
  "Cancel the store's subscription record here (the payment provider is not touched).",
  "Delete its queued jobs, webhook receipts and usage events on the platform.",
];
export const OFFBOARD_KEPT = "The store's database, its control-plane row, the billing ledger and the audit history are kept, so an export stays possible.";

// The shoppers' default maintenance text (app/(storefront)/layout.js).
export const DEFAULT_MAINTENANCE_MESSAGE = "We're doing some quick work behind the scenes. Nothing is lost — your cart will be waiting.";

// One call to the store's operator API. A 401 goes back to sign-in.
export async function storeApi(storeId, { path = "", method = "PATCH", body } = {}) {
  const res = await fetch(`/api/platform/tenants/${encodeURIComponent(storeId)}${path}`, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.assign("/platform");
    return new Promise(() => {});
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ok === false) {
    const e = new Error(json?.error || "That didn't work. Try again.");
    e.field = json?.field || null;
    throw e;
  }
  return json || {};
}
