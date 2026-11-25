// The media screen's words and small pure helpers (Phase 2 line 5). No
// React, no fetch: test:media-library runs these as they are. The usage
// wording keeps the old screen's rules (components/admin/MediaAdmin.js
// usageLine, which Phase 2 line 10 removes): a page's name and state, never
// an id or a table name.
import { CLIENT_MEDIA_LIMITS } from "@/lib/media-upload-plan";

export const TYPE_WORDS = Object.freeze({ "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP", "image/gif": "GIF", "image/svg+xml": "SVG" });
// the type filter: the library query's value -> its word
export const TYPE_FILTERS = Object.freeze([
  ["png", "PNG"],
  ["jpeg", "JPEG"],
  ["webp", "WebP"],
  ["gif", "GIF"],
  ["svg", "SVG"],
]);
export const SORT_WORDS = Object.freeze([
  ["newest", "Newest first"],
  ["oldest", "Oldest first"],
  ["name", "Name (A to Z)"],
  ["size", "Largest first"],
]);

export const fmtSize = (n) => {
  const b = Number(n) || 0;
  if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(b / 1000))} KB`;
};
export const fmtDims = (m) => (m?.width && m?.height ? `${m.width} × ${m.height} px` : "Not known");
export const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Not known" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

// "PNG, JPEG, WebP and GIF up to 1.5 MB each; SVG up to 300 KB." from the
// server's limits ({ mime: bytes }), the browser's copy when none came.
export function limitsLine(limits = CLIENT_MEDIA_LIMITS) {
  const groups = new Map();
  for (const [mime, max] of Object.entries(limits || {})) {
    if (!TYPE_WORDS[mime]) continue;
    groups.set(max, [...(groups.get(max) || []), TYPE_WORDS[mime]]);
  }
  const list = (w) => (w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0]);
  const parts = [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([max, words]) => `${list(words)} up to ${fmtSize(max)}${words.length > 1 ? " each" : ""}`);
  return parts.length ? `${parts.join("; ")}. Large photos are made smaller for you.` : "";
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const STATE_WORDS = { live: "live", draft: "draft", "older version": "an earlier version" };
const starts = (w, p) => typeof w === "string" && w.startsWith(p);

export function usageLine(u) {
  if (!isObj(u)) return "Another part of your store";
  if (u.document) return `${u.name || "A page"} (${STATE_WORDS[u.label] || u.label || "used"})`;
  const w = typeof u.where === "string" ? u.where : "";
  if (u.config) return `Your ${w || "store settings"}`;
  if (starts(w, "live release:")) return "What your store shows now";
  if (starts(w, "scheduled release:")) return "A scheduled update of your store";
  if (u.release || starts(w, "retained release:")) return "An earlier published version of your store";
  return "Another part of your store";
}
export const usageLines = (uses) => [...new Set((Array.isArray(uses) ? uses : []).map(usageLine))];

export const MEDIA_WORDS = Object.freeze({
  title: "Media",
  description: "Images for banners, pages and rich text. Paste a file's URL anywhere content takes an image.",
  emptyTitle: "Upload your first image",
  emptyHelp: "Drop images here or choose them from your computer. They're checked and stored with your store's data.",
  emptyArchived: "Nothing is archived. Archived files are hidden from the image picker and still show where they're used.",
  noMatch: "No files match this search.",
  loadFailed: "Your files couldn't load. Check your connection and try again.",
  uploaded: (name) => `${name} uploaded.`,
  reused: (name) => `${name} was already in your library, so it was reused.`,
  backInLibrary: (name) => `${name} was archived. It's back in your library now.`,
  waiting: "Waiting",
  altEmpty: "No alt text yet. Describe the image in a few words for people who use screen readers.",
  altNone: "No alt text yet.", // what a read-only role sees: the fact, not a task
  altSaved: "Alt text saved.",
  altFailed: "The alt text wasn't saved. Try again.",
  copied: "URL copied.",
  copyFailed: "The URL couldn't be copied. Select it and copy it yourself.",
  notUsed: "Not used anywhere.",
  usageFailed: "Where this file is used couldn't load. Try again.",
  archived: (name) => `${name} is archived. It's hidden from the image picker, and pages that use it still show it.`,
  unarchived: (name) => `${name} is back in your library.`,
  archivedNote: "Archived: hidden from the image picker. Pages that use it still show it.",
  archiveHelp: "Archive hides a file from the image picker. Pages that use it keep showing it.",
  deleteTitle: (name) => `Delete ${name}?`,
  deleteHelp: "This removes the file for good. A file that's still used can't be deleted.",
  deleted: (name) => `${name} deleted.`,
  inUseTitle: "This file can't be deleted",
  inUse: "This file is still used, so it wasn't deleted. Remove it from the places below first.",
  inUseHelp: "Archive it instead to hide it from the image picker. Pages that use it keep showing it.",
  failed: "Something went wrong on our side, so nothing changed. Try again.",
  readOnly: "You have read-only access, so you can look at files but not change them.",
});

// What a refused delete says: fixed words for a used file (the places come
// from usageLines), the server's own fixed sentence only for MEDIA_CHANGED
// and MEDIA_NOT_FOUND (lib/media.js).
export function refusalWords(code, message) {
  if (code === "MEDIA_IN_USE") return MEDIA_WORDS.inUse;
  if ((code === "MEDIA_CHANGED" || code === "MEDIA_NOT_FOUND") && typeof message === "string" && message) return message;
  return MEDIA_WORDS.failed;
}

// One upload's result in words: { tone: "success" | "danger", text }.
export function uploadResultWords(file, r) {
  if (!r?.ok) return { tone: "danger", text: r?.message || MEDIA_WORDS.failed };
  if (r.media?.deduped && r.media?.unarchived) return { tone: "success", text: MEDIA_WORDS.backInLibrary(file.name) };
  if (r.media?.deduped) return { tone: "success", text: MEDIA_WORDS.reused(file.name) };
  return { tone: "success", text: r.notice || MEDIA_WORDS.uploaded(file.name) };
}

// The library GET's query string for a view's state.
export function libraryUrl({ tab = "active", q = "", type = "", sort = "newest", cursor = null } = {}) {
  const p = new URLSearchParams({ view: "library" });
  if (tab === "archived") p.set("archived", "only");
  if (q.trim()) p.set("q", q.trim());
  if (type) p.set("type", type);
  if (sort && sort !== "newest") p.set("sort", sort);
  if (cursor) p.set("cursor", cursor);
  return `/api/admin/media?${p}`;
}
