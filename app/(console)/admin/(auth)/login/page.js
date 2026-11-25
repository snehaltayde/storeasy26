import LoginForm from "@/components/admin/auth/LoginForm";
import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/console-request";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in", robots: { index: false } };

export default async function AdminLoginPage() {
  const storeName = await tfetch(() => siteName()).catch(() => null);
  return <LoginForm storeName={storeName} />;
}
