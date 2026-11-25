// The quizzes screens' words (Phase 2 line 10), shared by the list, the
// editor and the delete dialog. Plain data and pure functions.
export const QUIZ_WORDS = Object.freeze({
  noWrite: "Your role can look at quizzes but not change them.",
  needsPublish: "Only an owner or admin can turn a quiz on, or change or delete one that is on.",
  staffOff: "It is saved turned off. An owner or admin can turn it on.",
  inUse: "This quiz is linked from your pages, so it can't be deleted. Take the links out first, or turn it off instead.",
  slugLocked: "The address is set when the quiz is made and can't be changed, so links to it keep working.",
});

// "12 Nov 2026" (UTC, like the media screen), or "Not known"
export function dateWords(iso) {
  const d = new Date(iso || "");
  return Number.isNaN(d.getTime()) ? "Not known" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export const usedOnWords = (n) => (n > 0 ? `Used on ${n === 1 ? "1 page" : `${n} pages`}` : "Not used on a page");

// one page that links to a quiz: "Home page (live and draft)"
export function pageLine(p) {
  const where = p.live && p.draft ? "live and draft" : p.live ? "live" : "draft";
  return `${p.name || "A page"} (${where})`;
}
