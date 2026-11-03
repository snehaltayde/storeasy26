// Upload planning for the console's image uploader (MED-01). PURE: no DOM, no
// db, no imports, so plain node can test every decision here. The canvas work
// that carries the plan out lives in lib/media-upload.js.
//
// The goal is that a founder's phone photo just uploads. Server rules stay the
// safety check and are NOT relaxed: lib/media.js keeps its limits, its
// magic-byte sniffing and its SVG sanitizer, and test-media-upload pins them.

// What the file pickers offer. image/* (not a list of types) so that iOS keeps
// handing over its HEIC photos as JPEG, and a HEIC on another device can be
// picked and get a plain answer instead of being greyed out with no reason.
export const UPLOAD_ACCEPT = "image/*";

// lib/media.js MEDIA_MIME is server-only (it imports db), so the numbers the
// browser plans against are a copy. test-media-upload fails if they drift.
export const CLIENT_MEDIA_LIMITS = {
  "image/png": 1_500_000,
  "image/jpeg": 1_500_000,
  "image/webp": 1_500_000,
  "image/gif": 1_500_000,
  "image/svg+xml": 300_000,
};
export const RESIZED_MAX_BYTES = CLIENT_MEDIA_LIMITS["image/jpeg"];

export const TARGET_LONG_EDGE = 1920;
const QUALITY_STEPS = [0.85, 0.78, 0.7, 0.62, 0.55];
// Last resort, for files too detailed to fit at the target size: a smaller
// image beats a refusal, and the founder is told.
const LAST_RESORT = [
  { edge: 1600, qualities: [0.7, 0.6] },
  { edge: 1280, qualities: [0.7, 0.6] },
];
// PNG has no quality setting, so size is its only dial.
const PNG_EDGES = [TARGET_LONG_EDGE, 1600, 1280, 1024, 800];
const THUMB_WIDTH = 480;

const RESIZABLE = new Set(["image/jpeg", "image/png", "image/webp"]);
const AS_IS = new Set(["image/gif", "image/svg+xml"]);
const HEIC = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
const BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
};
const EXTENSION_FOR = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const extensionOf = (name) => (/\.([a-z0-9]+)$/i.exec(String(name || ""))?.[1] || "").toLowerCase();

// What should happen to this file? Some phones and file managers send an empty
// type, so the extension fills in only when the browser names no type at all.
//   resize  JPEG/PNG/WebP: may be resized (see shouldResize)
//   as-is   GIF/SVG: never touched, the server decides
//   convert other images (HEIC, AVIF...): the server won't take them, so decode
//           and re-encode if this browser can; `heic` picks the right message
//   refuse  not an image
export function classifyUpload({ type, name }) {
  const declared = String(type || "").toLowerCase();
  const mime = declared && declared !== "application/octet-stream" ? declared : BY_EXTENSION[extensionOf(name)] || "";
  if (RESIZABLE.has(mime)) return { action: "resize", mime };
  if (AS_IS.has(mime)) return { action: "as-is", mime };
  if (HEIC.has(mime)) return { action: "convert", mime, heic: true };
  if (mime.startsWith("image/")) return { action: "convert", mime, heic: false };
  return { action: "refuse", mime };
}

// An image already within the server limit and no larger than the target is
// left exactly as it is: no upscale, no pointless second compression.
export function shouldResize({ size, width, height, action }) {
  if (action === "convert") return true;
  return size > RESIZED_MAX_BYTES || Math.max(width, height) > TARGET_LONG_EDGE;
}

// Scale so the long edge is at most `edge`. Never upscales.
export function fitLongEdge(width, height, edge) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// The encodes to try, best first; the first that fits wins. JPEG flattens
// transparency onto black, so a transparent image NEVER gets a JPEG step: it
// tries WebP (keeps transparency, but not every browser can write it), then
// PNG at falling sizes.
export function encodeSteps({ width, height, hasAlpha }) {
  const lossy = (mime) => [
    ...QUALITY_STEPS.map((quality) => ({ mime, quality, edge: TARGET_LONG_EDGE })),
    ...LAST_RESORT.flatMap(({ edge, qualities }) => qualities.map((quality) => ({ mime, quality, edge }))),
  ];
  const planned = hasAlpha
    ? [...lossy("image/webp"), ...PNG_EDGES.map((edge) => ({ mime: "image/png", edge }))]
    : lossy("image/jpeg");
  const seen = new Set();
  const steps = [];
  for (const { mime, quality, edge } of planned) {
    const size = fitLongEdge(width, height, edge);
    const key = `${mime}|${quality}|${size.width}x${size.height}`;
    if (seen.has(key)) continue; // a small source makes several sizes the same
    seen.add(key);
    steps.push({ mime, ...(quality ? { quality } : {}), ...size });
  }
  return steps;
}

// Was anything in this RGBA pixel data see-through?
export function hasTransparency(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true;
  return false;
}

// Keep the file the founder picked when re-encoding gave nothing better (it
// grew, or nothing fit) and the server would take the original anyway. Files
// the server can't take in their own format always need the encoded result.
export function keepOriginal({ size, encodedSize, action }) {
  if (action === "convert" || size > RESIZED_MAX_BYTES) return false;
  return encodedSize == null || encodedSize >= size;
}

export function renameFor(name, mime) {
  const ext = EXTENSION_FOR[mime];
  const base = String(name || "photo").replace(/\.[a-z0-9]+$/i, "") || "photo";
  return ext ? `${base}.${ext}` : String(name || "photo");
}

// The library preview: at most 480px wide, keeping aspect. null when the
// original already serves (small images, GIF and SVG).
export function thumbSize({ mime, width, height }) {
  if (!RESIZABLE.has(mime) || !width || width <= THUMB_WIDTH) return null;
  return { width: THUMB_WIDTH, height: Math.round(height * (THUMB_WIDTH / width)) };
}

// ---- plain words for the founder ---------------------------------------------

const quote = (name) => `"${name || "This file"}"`;

export const uploadMessage = {
  notImage: (name) => `${quote(name)} isn't an image. Please choose a photo or picture file.`,
  heic: (name) => `This browser can't open ${quote(name)} because it's a HEIC photo, the format iPhones use. Upload it from your iPhone using Safari, or save it as a JPEG first.`,
  unreadable: (name) => `We couldn't open ${quote(name)}. The file may be damaged. Try saving it again as a JPEG or PNG.`,
  tooDetailed: (name) => `${quote(name)} is still too big, even after making it smaller. Try cropping it or saving it as a JPEG, then upload it again.`,
  tooBig: (name) => `${quote(name)} is too big. GIFs can be up to 1.5MB and SVGs up to 300KB, and these can't be made smaller here. Please choose a smaller file.`,
  notWhatItSays: (name) => `${quote(name)} isn't really the kind of image its name says. Try saving it again as a JPEG or PNG.`,
  empty: (name) => `${quote(name)} is empty. Please choose another file.`,
  noPermission: () => "You don't have permission to upload right now. Try signing in again.",
  connection: () => "The upload didn't go through. Check your connection and try again.",
  failed: (name) => `Something went wrong uploading ${quote(name)}. Please try again.`,
};

// Turn what the upload route answered into plain words. The server's own
// checks still decide; only the wording changes. status 0 means no answer.
export function plainServerMessage({ status, json, name }) {
  if (status === 0) return uploadMessage.connection();
  if (status === 401 || status === 403) return uploadMessage.noPermission();
  if (status === 413) return uploadMessage.tooBig(name);
  const text = [...(json?.errors || []), json?.error || ""].join(" ");
  if (text.includes("not allowed")) return uploadMessage.notImage(name);
  if (text.includes("is empty")) return uploadMessage.empty(name);
  if (text.includes("doesn't match")) return uploadMessage.notWhatItSays(name);
  if (text.includes("the limit for")) return uploadMessage.tooBig(name);
  return uploadMessage.failed(name);
}

export function progressLabel({ name, stage, percent }) {
  if (stage === "preparing") return `Getting ${name} ready…`;
  if (stage === "saving") return `Saving ${name}…`;
  return `Uploading ${name}… ${percent || 0}%`;
}
