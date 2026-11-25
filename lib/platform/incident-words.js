// Incident words both consoles share (Phase 3 line 4), pure so client code can
// import it: the merchant console's banner (components/admin/shell/ConsoleNotices.js)
// and the operator's preview of that banner (components/platform/incidents) build
// the title from one function, so the preview is what merchants see.
export const incidentBannerTitle = ({ tenant_id = null, title = "" } = {}) => `${tenant_id ? "Notice for your store" : "Platform notice"}: ${title}`;

// The audit actions of an incident's history. Rows written before Phase 3 line 4
// say tenant.status; the timeline reads them as open or resolve by their diff.
export const INCIDENT_ACTIONS = Object.freeze(["incident.open", "incident.update", "incident.resolve"]);
