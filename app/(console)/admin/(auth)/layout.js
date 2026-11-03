import { siteName } from "@/lib/site";
import { tfetch } from "@/lib/console-request";

// Auth shell (S50): login / reset / accept-invite render as a centered
// card — store context above, no sidebar, no storefront chrome.
export default async function AdminAuthLayout({ children }) {
  const name = await tfetch(() => siteName()).catch(() => "Store");
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="mb-6 text-center">
        <p className="text-lg font-semibold tracking-tight text-fg">{name}</p>
        <p className="text-xs text-fg-subtle">
          Store console · powered by Store<span className="font-semibold text-caccent">asy</span>
        </p>
      </div>
      <div className="w-full max-w-sm rounded-card border border-edge bg-surface p-6 shadow-card">{children}</div>
    </div>
  );
}
