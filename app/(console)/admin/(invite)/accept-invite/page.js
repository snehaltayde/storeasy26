import AcceptInviteForm from "@/components/admin/auth/AcceptInviteForm";
import { AuthFrame } from "@/components/admin/auth/AuthFrame";
import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accept invitation", robots: { index: false } };

export default async function AcceptInvitePage({ searchParams }) {
  const { token } = await searchParams;
  const storeName = await tfetch(() => siteName()).catch(() => null);
  if (!token) {
    return (
      <AuthFrame
        data-invite="incomplete"
        title="This invitation link is incomplete"
        intro="The link from your email was cut off. Open it again from the email, or ask whoever invited you to send a new one."
      />
    );
  }
  return <AcceptInviteForm token={token} storeName={storeName} />;
}
