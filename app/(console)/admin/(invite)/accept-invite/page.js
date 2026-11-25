import AcceptInviteForm from "@/components/admin/auth/AcceptInviteForm";
import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accept invitation", robots: { index: false } };

export default async function AcceptInvitePage({ searchParams }) {
  const { token } = await searchParams;
  const storeName = await tfetch(() => siteName()).catch(() => null);
  if (!token) {
    return (
      <section data-invite="incomplete" className="space-y-3">
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.01em]">This invitation link is incomplete</h1>
        <p className="text-muted-foreground">The link from your email was cut off. Open it again from the email, or ask whoever invited you to send a new one.</p>
      </section>
    );
  }
  return <AcceptInviteForm token={token} storeName={storeName} />;
}
