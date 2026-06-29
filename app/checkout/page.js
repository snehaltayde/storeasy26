import Link from "next/link";
import { cookies } from "next/headers";
import { getCart, emptyCart, CART_COOKIE } from "@/lib/cart";
import CheckoutFlow from "@/components/checkout/CheckoutFlow";

export const metadata = { title: "Checkout" };
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const id = (await cookies()).get(CART_COOKIE)?.value;
  const cart = id ? await getCart(id) : emptyCart();

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

  // Key id is public; presence tells the UI whether to offer Razorpay.
  const razorpayEnabled = Boolean(process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID);

  return <CheckoutFlow cart={cart} razorpayEnabled={razorpayEnabled} />;
}
