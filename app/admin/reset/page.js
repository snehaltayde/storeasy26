import ResetForm from "@/components/admin/ResetForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reset password", robots: { index: false } };

export default async function ResetPage({ searchParams }) {
  const { token } = await searchParams;
  if (!token) {
    return (
      <div className="mx-auto max-w-sm px-4 py-24">
        <h1 className="text-xl font-bold">Reset link incomplete</h1>
        <p className="mt-2 text-sm text-zinc-500">
          This page needs the token from your reset email. Request a new link from the login page.
        </p>
      </div>
    );
  }
  return <ResetForm token={token} />;
}
