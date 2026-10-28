import AcceptInviteForm from "@/components/admin/AcceptInviteForm";
import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/tenant-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accept invitation", robots: { index: false } };

export default async function AcceptInvitePage({ searchParams }) {
  const { token } = await searchParams;
  const storeName = await tfetch(() => siteName());
  if (!token) {
    return (
      <div className="mx-auto max-w-sm px-4 py-24">
        <h1 className="text-xl font-bold">Invitation link incomplete</h1>
        <p className="mt-2 text-sm text-zinc-500">
          This page needs the invitation token from your email link. Ask for a new invitation if the link
          was cut off.
        </p>
      </div>
    );
  }
  return <AcceptInviteForm token={token} storeName={storeName} />;
}
