import Link from "next/link";
import ResetForm from "@/components/admin/auth/ResetForm";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reset password", robots: { index: false } };

export default async function ResetPage({ searchParams }) {
  const { token } = await searchParams;
  if (!token) {
    return (
      <section data-auth="reset-incomplete" className="space-y-6">
        <div className="space-y-3">
          <h1 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.01em]">This reset link is incomplete</h1>
          <p className="text-muted-foreground">This page needs the token from your reset email. Ask for a new link from the sign-in page.</p>
        </div>
        <Button asChild variant="outline" size="lg" className="h-10 px-4">
          <Link href="/admin/login">Go to the sign-in page</Link>
        </Button>
      </section>
    );
  }
  return <ResetForm token={token} />;
}
