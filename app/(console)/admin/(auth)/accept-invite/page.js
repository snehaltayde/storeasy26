import AcceptInviteForm from "@/components/admin/AcceptInviteForm";
import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accept invitation", robots: { index: false } };

export default async function AcceptInvitePage({ searchParams }) {
  const { token } = await searchParams;
  const storeName = await tfetch(() => siteName());
  if (!token) {
    return (
      <div>
        <h1 className="text-base font-semibold text-fg">Invitation link incomplete</h1>
        <p className="mt-2 text-sm text-fg-muted">
          This page needs the invitation token from your email link. Ask for a new invitation if the link
          was cut off.
        </p>
      </div>
    );
  }
  return <AcceptInviteForm token={token} storeName={storeName} />;
}
