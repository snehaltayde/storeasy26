import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LegacyPageSlugRedirect({ params }) {
  const { slug } = await params;
  const path = slug === "about" || slug === "contact" ? `/${slug}` : `/policies/${slug}`;
  redirect(`/admin/editor?path=${encodeURIComponent(path)}`);
}
