import { activeSupportGrant } from "@/lib/platform/support";
import { openIncidentsFor } from "@/lib/platform/incidents";
import { currentTenant } from "@/lib/tenant-context";
import { tfetch } from "@/lib/tenant-request";

// Admin section layout (S34 / OP10): ONE place for the merchant-visible
// support-access banner — whenever an operator grant is active on this tenant,
// everyone in the console sees who/why/until-when. S43 (OP12): open platform
// incidents with a PUBLIC message show here too (internal notes never do).
export default async function AdminLayout({ children }) {
  const [grant, incidents] = await tfetch(async () =>
    Promise.all([
      currentTenant() ? activeSupportGrant(currentTenant().id) : null,
      openIncidentsFor(currentTenant()?.id || null),
    ]),
  ).catch(() => [null, []]);
  return (
    <>
      {incidents.map((i) => (
        <div key={i.id} className="border-b border-sky-200 bg-sky-50 px-4 py-2 text-center text-xs text-sky-800">
          <span className="font-semibold">{i.tenant_id ? "Notice for your store" : "Platform notice"}: {i.title}</span>
          {i.public_message ? <> — {i.public_message}</> : null}
        </div>
      ))}
      {grant && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-800">
          <span className="font-semibold">Platform support access is active</span> — operator{" "}
          <span className="font-mono">{grant.operator}</span>, reason: “{grant.reason}”, until{" "}
          {new Date(grant.expires_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
          . Support access is read-only and never sees customer contact details.
        </div>
      )}
      {children}
    </>
  );
}
