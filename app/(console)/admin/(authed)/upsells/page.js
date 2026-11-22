import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function LegacyUpsellsRedirect() {
  redirect("/admin/editor?doc=doc_cart");
}
