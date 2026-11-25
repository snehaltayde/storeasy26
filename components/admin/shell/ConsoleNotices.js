import { Info, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// The support-access and incident notices (moved from the old admin root
// layout in Phase 0 line 8; on the new UI's Alert since Phase 2 line 11): at
// the top of the console's content area and above the sign-in pages. Data
// from consoleNotices() (lib/admin/notices.js).
// Whether consoleNotices() has anything to show: the (authed) layout passes no
// notices element at all otherwise, so a page gets no empty box (AdminShell).
export const hasConsoleNotices = (n) => Boolean(n?.grant || n?.incidents?.length);

export function ConsoleNotices({ grant = null, incidents = [], className = "space-y-2" }) {
  if (!hasConsoleNotices({ grant, incidents })) return null;
  return (
    <div className={className} data-console-notices>
      {incidents.map((i) => (
        <Alert key={i.id} variant="info" role="status">
          <Info aria-hidden />
          <AlertTitle>{`${i.tenant_id ? "Notice for your store" : "Platform notice"}: ${i.title}`}</AlertTitle>
          {i.public_message && <AlertDescription>{i.public_message}</AlertDescription>}
        </Alert>
      ))}
      {grant && (
        <Alert variant="warning" role="status">
          <ShieldAlert aria-hidden />
          <AlertTitle>Platform support access is active</AlertTitle>
          <AlertDescription className="text-warning-text/90">
            <p>
              Operator <span className="font-mono">{grant.operator}</span>, reason: “{grant.reason}”, until{" "}
              {new Date(grant.expires_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. Support access is
              read-only and never sees customer contact details.
            </p>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
