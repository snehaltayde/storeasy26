// Which stores are BeastLife itself: the legacy env store and its control-plane
// tenants. Pure (no database, no request context), so the module behind the
// console's Settings form can import it.
const BRAND_TENANT_IDS = ["_default", "beastlife", "beastlife-staging"];

export const isBrandTenant = (id) => BRAND_TENANT_IDS.includes(id);

// GEN-03: the one answer to "did this store choose its shipping rates?", for the
// cart and the console alike. No shipping_config means the code default is doing
// the charging. BeastLife publishes those same figures in its own shipping policy
// (lib/content/pages.js), so they are its rates. Display only: what a shopper is
// charged never depends on this.
export const shippingRatesChosen = (tenant) => tenant?.config?.shipping_config != null || isBrandTenant(tenant?.id || "_default");
