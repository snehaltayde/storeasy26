import WishlistPage from "@/components/WishlistPage";

// Wishlist (S49 / SF22): local-first — the anonymous list lives in THIS
// browser, per store; signing in offers an explicit merge, never an
// automatic one. noindex: it's personal, even when anonymous.
export const dynamic = "force-dynamic";
export const metadata = { title: "Wishlist", robots: { index: false } };

export default function Wishlist() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-extrabold tracking-tight">Wishlist</h1>
      <div className="mt-6">
        <WishlistPage />
      </div>
    </div>
  );
}
