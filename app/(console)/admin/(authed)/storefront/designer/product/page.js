import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function LegacyDesignerProductRedirect() {
  redirect("/admin/editor?doc=doc_product_layout");
}
