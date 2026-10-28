import ResetForm from "@/components/admin/ResetForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reset password", robots: { index: false } };

export default async function ResetPage({ searchParams }) {
  const { token } = await searchParams;
  if (!token) {
    return (
      <div>
        <h1 className="text-base font-semibold text-fg">Reset link incomplete</h1>
        <p className="mt-2 text-sm text-fg-muted">
          This page needs the token from your reset email. Request a new link from the login page.
        </p>
      </div>
    );
  }
  return <ResetForm token={token} />;
}
