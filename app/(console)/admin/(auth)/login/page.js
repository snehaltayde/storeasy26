import { siteName } from "@/lib/site";
import LoginForm from "@/components/admin/LoginForm";
import { tfetch } from "@/lib/tenant-request";

// Session 22: title resolves per tenant (was hardcoded "BeastLife admin").
export const dynamic = "force-dynamic";
export const metadata = { title: "Admin login", robots: { index: false } };

export default async function AdminLoginPage() {
  const name = await tfetch(async () => siteName());
  return <LoginForm storeName={name} />;
}
