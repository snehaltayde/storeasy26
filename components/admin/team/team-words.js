// The team screen's words and rules (Phase 2 line 8), pure so test:team can
// check them. The server decides every write (app/api/admin/team/route.js);
// these only keep the page from offering what it would refuse.
import { ROLES, roleAllows } from "@/lib/platform/authz";

export const ROLE_WORDS = Object.freeze({ owner: "Owner", admin: "Admin", staff: "Staff", support: "Support" });
export const ROLE_HELP = Object.freeze({
  owner: "Everything, including ownership and the team",
  admin: "Orders, settings and the team, but not owners",
  staff: "Products, content and offers; can't publish",
  support: "Read-only",
});
export const roleWords = (role) => ROLE_WORDS[role] ?? "No access";
const rank = (role) => (ROLES.includes(role) ? ROLES.indexOf(role) : ROLES.length);

// The roles the caller may give: Owner only for an owner (team.owner).
export const assignableRoles = (actorRole) => ROLES.filter((r) => r !== "owner" || roleAllows(actorRole, "team.owner"));

// The authz action a write on this member or invite needs.
export const actionFor = (role) => (role === "owner" ? "team.owner" : "team.manage");

// The warning when the address already holds this role or higher here: an
// invite only ever adds a member or raises a role (lib/platform/identity.js).
export function inviteWarning(members, email, role) {
  const e = String(email || "").trim().toLowerCase();
  const m = e && (members || []).find((x) => String(x.email).toLowerCase() === e);
  if (!m || rank(m.role) > rank(role)) return null;
  return `${m.name || m.email} is already on the team as ${roleWords(m.role)}. An invite can only raise a role, so this one would change nothing. Use Change role instead.`;
}

// What happened to the invite email (the link is shown either way).
export function mailWords(mail, email) {
  switch (mail?.status) {
    case "sent":
      return { tone: "success", text: `We also emailed the link to ${email}.` };
    case "mock":
      return { tone: "warning", text: `Email is in test mode here, so nothing was sent. Copy the link and send it to ${email} yourself.` };
    case "failed":
      return { tone: "danger", text: `We couldn't email the link. Copy it and send it to ${email} yourself.` };
    default:
      return { tone: "muted", text: `Email isn't set up for this store, so nothing was sent. Copy the link and send it to ${email} yourself.` };
  }
}

// "3 Nov 2026" in UTC, the same on the server and in the browser.
export function dateWords(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// When an invite stops working, in words: "Expires today", "Expires tomorrow",
// "Expires in 5 days", "Expired 2 days ago". Counted in whole UTC days so the
// server and the browser agree. soon: a day or less left (or gone).
export function expiryWords(iso, now = Date.now()) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return { text: "", soon: false };
  const day = (t) => Math.floor(t / 86_400_000);
  const left = day(d.getTime()) - day(typeof now === "number" ? now : new Date(now).getTime());
  if (d.getTime() <= (typeof now === "number" ? now : new Date(now).getTime())) {
    const ago = -left;
    return { text: ago <= 0 ? "Expired today" : ago === 1 ? "Expired yesterday" : `Expired ${ago} days ago`, soon: true, expired: true };
  }
  if (left <= 0) return { text: "Expires today", soon: true };
  if (left === 1) return { text: "Expires tomorrow", soon: true };
  return { text: `Expires in ${left} days`, soon: false };
}

// Initials for a member's avatar: "Asha Rao" -> "AR", "a@x.test" -> "A".
export function initials(name, email) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length) return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
  return String(email || "?").trim().charAt(0).toUpperCase() || "?";
}

export const TEAM_WORDS = Object.freeze({
  failed: "Something went wrong and nothing changed. Try again.",
  loadFailed: "We couldn't load your team. Nothing has changed.",
  unsupported: "Team accounts need the platform control plane. This store runs on a single password, so there is no team to manage here.",
  noAccess: "Only the store's owners and admins can see and manage the team. Ask one of them if you need a change.",
});

// A refusal from the route in words: its own plain sentence, or the fallback.
export const refusalWords = (json) => (typeof json?.error === "string" && json.error ? json.error : TEAM_WORDS.failed);
