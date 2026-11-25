import Link from "next/link";
import ResetForm from "@/components/admin/auth/ResetForm";
import { AuthFrame, StoreName } from "@/components/admin/auth/AuthFrame";
import { Button } from "@/components/ui/button";
import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reset password", robots: { index: false } };

export default async function ResetPage({ searchParams }) {
  const { token } = await searchParams;
  const storeName = await tfetch(() => siteName()).catch(() => null);
  if (!token) {
    return (
      <AuthFrame data-auth="reset-incomplete" title="This reset link is incomplete" intro={<StoreName name={storeName} />}>
        <div className="space-y-4 py-2">
          <p className="text-muted-foreground">This page needs the token from your reset email. Ask for a new link from the sign-in page.</p>
          <Button asChild variant="outline" className="h-10 w-full">
            <Link href="/admin/login">Go to the sign-in page</Link>
          </Button>
        </div>
      </AuthFrame>
    );
  }
  return <ResetForm token={token} storeName={storeName} />;
}
