import Link from "next/link";
import { cookies } from "next/headers";
import { getCart, emptyCart, shopperCart, CART_COOKIE } from "@/lib/cart";
import { tenantCfg, tenantOwnCfg, tenantShippingConfig, currentTenant } from "@/lib/tenant-context";
import { DEFAULT_TIME_ZONE } from "@/lib/delivery-estimate";
import { checkoutCapability } from "@/lib/commerce/adapter";
import { siteName, siteLogo } from "@/lib/site";
import { resolvedContentPageList } from "@/lib/content/resolve";
import CheckoutFlow from "@/components/checkout/CheckoutFlow";
import { tfetch } from "@/lib/storefront-request";
import { storefrontMarket } from "@/lib/market-request";
import { marketShipping, marketPaymentConfig, countryOptions } from "@/lib/markets";
import { RAZORPAY_CURRENCIES } from "@/lib/money";

// S38 (SF14): the store's own legal pages, linked next to the pay button.
// Only ENABLED pages link (never another tenant's text — the list is already
// tenant/release-scoped), matched by slug family.
async function policyLinks() {
  const pages = await resolvedContentPageList();
  const pick = (re) => pages.find((p) => p.enabled && re.test(p.slug));
  return [
    { page: pick(/privacy/), label: "Privacy policy" },
    { page: pick(/terms/), label: "Terms" },
    { page: pick(/refund|return/), label: "Refund policy" },
    { page: pick(/shipping|delivery/), label: "Shipping policy" },
  ]
    .filter((x) => x.page)
    .map((x) => ({ label: x.label, href: `/policies/${x.page.slug}` }));
}

export const metadata = { title: "Checkout" };
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const id = (await cookies()).get(CART_COOKIE)?.value;
  // Phase 8 line 4: the page is priced in the shopper's market (its cart,
  // shipping and prepaid rule), with the countries the store ships to.
  const { cart, storeName, logo, razorpayEnabled, capability, policies, shippingConfig, paymentConfig, timeZone, countries, initialCountry } = await tfetch(async () => {
    const { country, market } = await storefrontMarket();
    const chargeable = !market || (RAZORPAY_CURRENCIES.includes(market.currency) && market.international === true);
    return {
    countries: countryOptions(currentTenant()?.config ?? null),
    initialCountry: country,
    // P4-EFFECTIVE (OVL-06): CheckoutFlow is a client component, so it gets the
    // shopper's projection (no Shopify title or SKU). The order itself is made
    // by the checkout API from the full server-side cart.
    cart: id || market ? shopperCart(await getCart(id || null, { market })) : emptyCart(),
    storeName: siteName(),
    logo: siteLogo(), // S55 fix: the checkout wordmark hardcoded BEASTLIFE on every tenant
    // Key id is public; TENANT-aware presence gates the Razorpay option (a
    // tenant without keys checks out COD-only). Config accessor, not
    // lib/razorpay.js — that module is node-only and this page renders on edge.
    razorpayEnabled: Boolean(tenantOwnCfg("razorpay_key_id", "NEXT_PUBLIC_RAZORPAY_KEY_ID")) && chargeable,
    capability: checkoutCapability(), // S32 (BE06): the per-tenant mode gate
    policies: await policyLinks(), // S38 (SF14): links near the pay button
    shippingConfig: market ? marketShipping(market, tenantShippingConfig()) : tenantShippingConfig(), // GEN-03: the live preview must use THIS store's rates
    timeZone: tenantCfg("timezone", null, DEFAULT_TIME_ZONE), // Phase 8 line 1: the summary's delivery dates
    // Phase 8 line 2: the prepaid discount and COD rules, for the first render
    // before the server's quote lands (no secrets live in payment_config)
    paymentConfig: marketPaymentConfig(currentTenant()?.config?.payment_config ?? null, market),
    };
  });

  if (!capability.available) {
    return (
      <div data-protected="checkout" className="mx-auto max-w-2xl px-4 py-24 text-center">
        <h1 className="text-2xl font-bold">Checkout is temporarily unavailable</h1>
        <p className="mt-2 text-sf-text-subtle">
          Your cart is saved — nothing was charged. Please try again a little later.
        </p>
        <Link
          href="/collections"
          className="mt-6 inline-block rounded-full bg-sf-inverse px-6 py-3 text-sm font-semibold text-sf-on-inverse hover:bg-sf-inverse-hover"
        >
          Keep browsing
        </Link>
      </div>
    );
  }

  if (!cart.items.length) {
    return (
      <div data-protected="checkout" className="mx-auto max-w-2xl px-4 py-24 text-center">
        <h1 className="text-2xl font-bold">Your cart is empty</h1>
        <p className="mt-2 text-sf-text-subtle">Add something before checking out.</p>
        <Link
          href="/collections"
          className="mt-6 inline-block rounded-full bg-sf-inverse px-6 py-3 text-sm font-semibold text-sf-on-inverse hover:bg-sf-inverse-hover"
        >
          Continue shopping
        </Link>
      </div>
    );
  }

  return <CheckoutFlow cart={cart} razorpayEnabled={razorpayEnabled} storeName={storeName} logo={logo} policies={policies} shippingConfig={shippingConfig} paymentConfig={paymentConfig} timeZone={timeZone} countries={countries} initialCountry={initialCountry} />;
}
