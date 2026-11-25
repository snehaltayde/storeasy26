import { Info, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { incidentBannerTitle } from "@/lib/platform/incident-words";
import { supportTime } from "@/components/admin/team/team-words";

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
          <AlertTitle>{incidentBannerTitle(i)}</AlertTitle>
          {i.public_message && <AlertDescription>{i.public_message}</AlertDescription>}
        </Alert>
      ))}
      {grant && (
        <Alert variant="warning" role="status">
          <ShieldAlert aria-hidden />
          <AlertTitle>Platform support access is active</AlertTitle>
          <AlertDescription className="text-warning-text/90 [&_p:not(:last-child)]:mb-1">
            <p>
              {grant.operatorName} from Storeasy can see this console until <span className="tabular-nums">{supportTime(grant.expires_at)}</span>, for: “{grant.reason}”.
            </p>
            <p>It's read-only and never sees customer contact details. An owner or admin can end it now from Settings, Team.</p>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
