import LoginForm from "@/components/admin/LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin login", robots: { index: false } };

export default function AdminLoginPage() {
  return <LoginForm />;
}
