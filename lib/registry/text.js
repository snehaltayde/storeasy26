// P2-REG (DOC-05): text helpers for the document registry. Pure and edge-safe.
//
// Copied from lib/cms/store.js (which is unchanged and keeps its own copies for
// the legacy page editor), so the registry never imports the database layer.
//
//   sanitize(raw)                 the allowlist sanitizer, on any value
//   lostBySanitizing(raw, html)   what sanitizing would lose that the founder
//                                 would miss (words, a link or image address, a
//                                 video, a picture) as { code, message }, or null
//   wordsLostMessage(words)       the WORDS_LOST refusal's words
//   isBlank(text)                 true when the text shows nothing
//   isBlankHtml(html)             true when sanitized HTML shows nothing
import { sanitizeHtml, wordsLostBySanitizing, addressesLostBySanitizing } from "../sanitize.js";

export const sanitize = (raw) => sanitizeHtml(String(raw ?? ""));

// Characters pasted from another app that show nothing (zero-width, direction
// and joining marks, lone combining marks, blank Braille and Hangul fillers)
// don't count as content. Only the check ignores them: stored text keeps them,
// because some scripts and emoji need them to display correctly.
export const isBlank = (value) => !String(value ?? "").replace(/[\p{Cc}\p{Cf}\p{Mn}⠀ㅤᅟᅠﾠ]/gu, "").trim();

// Sanitized HTML shows nothing with only empty tags in it: "<p>&nbsp;</p>". A
// browser reads the nbsp forms with or without the semicolon, the others only with.
const BLANK_ENTITY = /&(?:(?:nbsp|#160|#xa0);?|(?:ensp|emsp|thinsp|zwj|zwnj|#8203|#x200b);)/gi;
export const isBlankHtml = (html) => {
  const h = String(html ?? "");
  return !/<(img|hr)\b/i.test(h) && isBlank(h.replace(/<[^>]*>/g, "").replace(BLANK_ENTITY, " "));
};

const quoted = (text) => `"${text.length > 60 ? `${text.slice(0, 60)}…` : text}"`;
const LOST_ADDRESS = {
  link: (address) => `saving would lose this link or image address: ${address}. It needs to start with https or a slash (/). Change it or remove it, then save again.`,
  media: (address) => `this page can't show embedded videos or sound yet, so saving would lose ${address}. Remove it or link to it instead.`,
  picture: (address) => `this page can't show this type of picture yet, so saving would lose ${address}. Add it as an image section, or remove it.`,
};

// The first tag in some lost words ("<founder>", "</sale>"), lowercased, or null.
const TAG_IN = /<\/?([a-zA-Z][a-zA-Z0-9-]*(?::[a-zA-Z][a-zA-Z0-9-]*)?)(?=[\s/>])/; // "<priya@store.com>" is no tag
export const tagIn = (words) => TAG_IN.exec(String(words ?? ""))?.[1].toLowerCase() ?? null;

// The refusal's words (P3-FIX4). Stray < or > signs are the cause only when the
// lost words hold no tag. A tag usually came with a paste, where the founder
// can't see it: name it, and say Edit as HTML shows it and can remove it.
export const wordsLostMessage = (lost) => {
  const found = tagIn(lost);
  if (!found) return `saving would lose these words: ${quoted(lost)}. This usually comes from < or > signs. Reword them or remove them, then save again.`;
  const tag = found.length > 24 ? `${found.slice(0, 24)}…` : found; // a long one is quoted short, as the words are
  return `saving would lose these words: ${quoted(lost)}. They come from a <${tag}> tag this page can't show, often hidden in pasted text. Open Edit as HTML to see it and remove that tag, or reword it if you typed it, then save again.`;
};

// Sanitizing may remove unsafe tags, but never their words, a real link's
// address, or a video or picture: the caller refuses, so they stay in the form
// to fix. A web page's own elements (<product-info …>) and a <noscript> are
// cleaned, not refused (P3-FIX4, webPaste). Returns the problem's
// { code, message }, or null.
export const lostBySanitizing = (raw, html) => {
  const lost = wordsLostBySanitizing(String(raw ?? ""), String(html ?? ""), { webPaste: true });
  if (lost) return { code: "WORDS_LOST", message: wordsLostMessage(lost) };
  const [gone] = addressesLostBySanitizing(String(raw ?? ""));
  if (gone) return { code: gone.kind === "link" ? "ADDRESS_LOST" : gone.kind === "media" ? "MEDIA_LOST" : "PICTURE_LOST", message: LOST_ADDRESS[gone.kind](quoted(gone.address)) };
  return null;
};
