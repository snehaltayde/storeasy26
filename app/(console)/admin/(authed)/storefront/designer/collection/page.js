import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function LegacyDesignerCollectionRedirect() {
  redirect("/admin/editor?doc=doc_collection_layout");
}
