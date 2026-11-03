import { activeSupportGrant } from "@/lib/platform/support";
import { openIncidentsFor } from "@/lib/platform/incidents";
import { currentTenant } from "@/lib/tenant-context";
import { tfetch } from "@/lib/console-request";
import { Banner } from "@/components/console/Banner";

// Admin section layout (S34 / OP10, restyled S50): ONE place for the
// merchant-visible support-access banner — whenever an operator grant is
// active on this tenant, everyone in the console sees who/why/until-when.
// S43 (OP12): open platform incidents with a PUBLIC message show here too
// (internal notes never do).
export default async function AdminLayout({ children }) {
  const [grant, incidents] = await tfetch(async () =>
    Promise.all([
      currentTenant() ? activeSupportGrant(currentTenant().id) : null,
      openIncidentsFor(currentTenant()?.id || null),
    ]),
  ).catch(() => [null, []]);
  const banners = incidents.length > 0 || grant;
  return (
    <>
      {banners && (
        <div className="space-y-2 px-4 pt-4 sm:px-6">
          {incidents.map((i) => (
            <Banner key={i.id} tone="info" title={`${i.tenant_id ? "Notice for your store" : "Platform notice"}: ${i.title}`}>
              {i.public_message || null}
            </Banner>
          ))}
          {grant && (
            <Banner tone="warning" title="Platform support access is active">
              Operator <span className="font-mono">{grant.operator}</span>, reason: “{grant.reason}”, until{" "}
              {new Date(grant.expires_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. Support
              access is read-only and never sees customer contact details.
            </Banner>
          )}
        </div>
      )}
      {children}
    </>
  );
}
