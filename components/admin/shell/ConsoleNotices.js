import { Banner } from "@/components/console/Banner";

// The support-access and incident notices (moved from the old admin root
// layout in Phase 0 line 8): at the top of the
// console's content area and above the sign-in pages. Data from
// consoleNotices() (lib/admin/notices.js). Old Banner look, so it renders
// inside a [data-legacy] region.
// Whether consoleNotices() has anything to show: the (authed) layout passes no
// notices element at all otherwise, so a new-UI page gets no empty
// [data-legacy] box (AdminShell).
export const hasConsoleNotices = (n) => Boolean(n?.grant || n?.incidents?.length);

export function ConsoleNotices({ grant = null, incidents = [], className = "space-y-2" }) {
  if (!hasConsoleNotices({ grant, incidents })) return null;
  return (
    <div className={className} data-console-notices>
      {incidents.map((i) => (
        <Banner key={i.id} tone="info" title={`${i.tenant_id ? "Notice for your store" : "Platform notice"}: ${i.title}`}>
          {i.public_message || null}
        </Banner>
      ))}
      {grant && (
        <Banner tone="warning" title="Platform support access is active">
          Operator <span className="font-mono">{grant.operator}</span>, reason: “{grant.reason}”, until{" "}
          {new Date(grant.expires_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. Support access is
          read-only and never sees customer contact details.
        </Banner>
      )}
    </div>
  );
}
