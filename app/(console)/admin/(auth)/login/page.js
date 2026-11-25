import LoginForm from "@/components/admin/auth/LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in", robots: { index: false } };

export default function AdminLoginPage() {
  return <LoginForm />;
}
