import Link from "next/link";
import { cookies } from "next/headers";
import { getCart, emptyCart, CART_COOKIE } from "@/lib/cart";
import { tenantOwnCfg } from "@/lib/tenant-context";
import { siteName } from "@/lib/site";
import CheckoutFlow from "@/components/checkout/CheckoutFlow";
import { tfetch } from "@/lib/tenant-request";

export const metadata = { title: "Checkout" };
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const id = (await cookies()).get(CART_COOKIE)?.value;
  const { cart, storeName, razorpayEnabled } = await tfetch(async () => ({
    cart: id ? await getCart(id) : emptyCart(),
    storeName: siteName(),
    // Key id is public; TENANT-aware presence gates the Razorpay option (a
    // tenant without keys checks out COD-only). Config accessor, not
    // lib/razorpay.js — that module is node-only and this page renders on edge.
    razorpayEnabled: Boolean(tenantOwnCfg("razorpay_key_id", "NEXT_PUBLIC_RAZORPAY_KEY_ID")),
  }));

  if (!cart.items.length) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-24 text-center">
        <h1 className="text-2xl font-bold">Your cart is empty</h1>
        <p className="mt-2 text-zinc-500">Add something before checking out.</p>
        <Link
          href="/collections"
          className="mt-6 inline-block rounded-full bg-zinc-900 px-6 py-3 text-sm font-semibold text-white hover:bg-zinc-800"
        >
          Continue shopping
        </Link>
      </div>
    );
  }

  return <CheckoutFlow cart={cart} razorpayEnabled={razorpayEnabled} storeName={storeName} />;
}
