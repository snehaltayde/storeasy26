import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { platformOperator, PLATFORM_COOKIE } from "@/lib/platform/admin-auth";
import { storeDetail } from "@/lib/platform/stores-list";
import StoreDetail from "@/components/platform/stores/StoreDetail";

// Phase 3 line 1: one store's page, read-only (lib/platform/stores-list.js
// storeDetail: secrets by name only, no database details). The store id comes
// from the path: operators span stores. Operators only; anyone else goes to
// /platform (the sign-in) before any store is read. An unknown id is a
// not-found page.
export const dynamic = "force-dynamic";
export const metadata = { title: "Store · Storeasy platform", robots: { index: false } };

export default async function StorePage({ params }) {
  const operator = await platformOperator((await cookies()).get(PLATFORM_COOKIE)?.value);
  if (!operator) redirect("/platform");
  const { id } = await params;
  const detail = await storeDetail(typeof id === "string" ? id : null);
  if (!detail) notFound();
  return <StoreDetail detail={detail} />;
}
