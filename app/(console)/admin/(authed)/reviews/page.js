import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminActor, ADMIN_COOKIE, PLATFORM_COOKIE, SUPPORT_COOKIE } from "@/lib/admin-auth";
import { roleAllows } from "@/lib/platform/authz";
import { NoAccess } from "@/components/admin/settings/NoAccess";
import { PageHeader } from "@/components/kit/page-header";
import { ReviewQueue } from "@/components/admin/reviews/ReviewQueue";
import { listQueue, redactReviewForRole, STATUSES } from "@/lib/reviews/moderate";
import { merchantTz } from "@/lib/reporting";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reviews · Admin", robots: { index: false } };

// Phase 9 line 1: the review queue (docs/plans/phase-9.md "Line 1" §5). The
// address holds the state (?status=, ?rating=, ?product=); the first page is
// redacted exactly as GET /api/admin/reviews is (support: no email, no order).
export default async function AdminReviewsPage({ searchParams }) {
  const jar = await cookies();
  const actor = await tfetch(() => adminActor(jar.get(ADMIN_COOKIE)?.value, jar.get(PLATFORM_COOKIE)?.value, jar.get(SUPPORT_COOKIE)?.value));
  if (!actor) redirect("/admin/login");
  if (!roleAllows(actor.role, "reviews.read")) return <NoAccess role={actor.role} page />;
  const sp = (await searchParams) ?? {};
  const status = STATUSES.includes(sp.status) ? sp.status : "pending";
  const n = Number(sp.rating);
  const rating = Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  const product = typeof sp.product === "string" && sp.product ? sp.product.slice(0, 200) : null;
  const [q, timeZone] = await tfetch(async () => [await listQueue({ status, rating, productId: product }), await merchantTz()]);
  return (
    <>
      <PageHeader title="Reviews" description="Reviews from people who bought from you. Nothing shows on your store until you approve it." />
      <ReviewQueue reviews={q.reviews.map((r) => redactReviewForRole(r, actor.role))} counts={q.counts} products={q.products} filters={{ status, rating, product }} role={actor.role} timeZone={timeZone} />
    </>
  );
}
