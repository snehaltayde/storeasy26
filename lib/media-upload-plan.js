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
// A file within the byte limit is only re-encoded when BOTH sides are over this.
// Long images (size charts, long screenshots) fail that on purpose: fitting their
// long edge would wreck their short edge, and nothing is gained for a file the
// server already takes.
const UNTOUCHED_SHORT_EDGE = 1920;
// When an image has to be written smaller, its short edge keeps at least this share
// of the size being tried (1080 at 1920), so a long image stays readable. A normal
// photo is no wider than 16:9, so it never reaches this and its long edge decides.
const SHORT_EDGE_SHARE = 9 / 16;
// Keeping the short edge lets the long edge run past the target. Past this a canvas
// can fail outright on some phones, so this holds whatever the short edge wants.
const LONGEST_WRITTEN_EDGE = 8192;
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
// Older names some browsers and systems still send. The server knows only the standard ones.
const TYPE_ALIASES = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "image/apng": "image/png",
};
const BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  png: "image/png",
  apng: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
};
const EXTENSION_FOR = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const extensionOf = (name) => (/\.([a-z0-9]+)$/i.exec(String(name || ""))?.[1] || "").toLowerCase();

// What should happen to this file? Some phones and file managers send an empty
// type, so the extension fills in only when the browser names no type at all.
//   resize  JPEG/PNG/WebP: may be resized (see shouldResize)
//   as-is   GIF/SVG: never touched, the server decides
//   convert other images (HEIC, AVIF...): the server won't take them, so decode
//           and re-encode if this browser can; `heic` picks the right message.
//           `unnamed` means no type and no name we know: it may still be a photo,
//           so the file itself gets to answer before it's called "not an image"
//   refuse  the browser says it's something else
export function classifyUpload({ type, name }) {
  const declared = String(type || "").toLowerCase();
  const mime = declared && declared !== "application/octet-stream" ? TYPE_ALIASES[declared] || declared : BY_EXTENSION[extensionOf(name)] || "";
  if (!mime) return { action: "convert", mime, heic: false, unnamed: true };
  if (RESIZABLE.has(mime)) return { action: "resize", mime };
  if (AS_IS.has(mime)) return { action: "as-is", mime };
  if (HEIC.has(mime)) return { action: "convert", mime, heic: true };
  if (mime.startsWith("image/")) return { action: "convert", mime, heic: false };
  return { action: "refuse", mime };
}

// An image within the server limit whose short edge is no larger than the target
// is left exactly as it is: no upscale, no pointless second compression, and a long
// image doesn't lose most of its width just because of its length.
export function shouldResize({ size, width, height, action }) {
  if (action === "convert") return true;
  return size > RESIZED_MAX_BYTES || Math.min(width, height) > UNTOUCHED_SHORT_EDGE;
}

// The size to write at for a target `edge`: the long edge comes down to `edge`,
// unless that would take the short edge below its share, in which case the short
// edge decides. Never upscales, and never passes LONGEST_WRITTEN_EDGE.
export function fitEdges(width, height, edge) {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const scale = Math.min(1, LONGEST_WRITTEN_EDGE / long, Math.max(edge / long, (edge * SHORT_EDGE_SHARE) / short));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Should the founder be told the final size? Yes when either edge ended up below what
// a good upload keeps, or below its own size if it started smaller than that. A 4032x3024
// photo written at 1920x1440 loses pixels but looks fine, so that stays quiet.
export function endedUpSmaller(original, written) {
  const longOf = ({ width, height }) => Math.max(width, height);
  const shortOf = ({ width, height }) => Math.min(width, height);
  return (
    longOf(written) < Math.min(TARGET_LONG_EDGE, longOf(original)) ||
    shortOf(written) < Math.min(TARGET_LONG_EDGE * SHORT_EDGE_SHARE, shortOf(original))
  );
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
    const size = fitEdges(width, height, edge);
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

// What the first bytes say this file is, by the same rules as sniffMime in
// lib/media.js (server-only; test-media-upload fails if the two disagree). SVG is
// left out because it never gets re-encoded. null means none of these.
export function sniffImage(bytes) {
  const has = (pos, ...values) => values.every((value, i) => bytes[pos + i] === value);
  if (bytes.length >= 8 && has(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (bytes.length >= 3 && has(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (bytes.length >= 6 && has(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (bytes.length >= 12 && has(0, 0x52, 0x49, 0x46, 0x46) && has(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

// Is this PNG or WebP animated? A canvas keeps only the first frame, so an animated
// file must not be re-encoded. Reads each format's own structure rather than
// searching for the marker, which can turn up by chance in a big file's picture data.
export function isAnimated(bytes) {
  const at = (pos, text) => {
    for (let i = 0; i < text.length; i++) if (bytes[pos + i] !== text.charCodeAt(i)) return false;
    return true;
  };
  // WebP: an animated file opens with an extended header that has its animation flag set.
  if (at(0, "RIFF") && at(8, "WEBP")) return at(12, "VP8X") && (bytes[20] & 0x02) !== 0;
  if (bytes[0] !== 0x89 || !at(1, "PNG")) return false;
  // PNG: the animation chunk has to come before the first image data.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = 8; pos + 8 <= bytes.length; pos += 12 + view.getUint32(pos)) {
    if (at(pos + 4, "acTL")) return true;
    if (at(pos + 4, "IDAT")) return false;
  }
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
  heic: (name) => `This browser can't open ${quote(name)} because it's a HEIC photo, a format many phones use. Save it as a JPEG first, or upload it from a phone browser that can open it.`,
  unreadable: (name) => `We couldn't open ${quote(name)}. The file may be damaged. Try saving it again as a JPEG or PNG.`,
  tooDetailed: (name) => `${quote(name)} is still too big, even after making it smaller. Try cropping it or saving it as a JPEG, then upload it again.`,
  tooBig: (name) => `${quote(name)} is too big. GIFs can be up to 1.5MB and SVGs up to 300KB, and these can't be made smaller here. Please choose a smaller file.`,
  animatedTooBig: (name) => `${quote(name)} is an animated image and it's too big. Animated images can be up to 1.5MB, and making them smaller here would stop the animation. Please choose a smaller file.`,
  notWhatItSays: (name) => `${quote(name)} isn't really the kind of image its name says. Try saving it again as a JPEG or PNG.`,
  notPlaced: (name) => `${quote(name)} is now in your library. It wasn't added here because you closed the window before it finished. You can choose it from the library when you're ready.`,
  madeSmaller: (name, { width, height }) => `${quote(name)} uploaded. It had to be made smaller to fit, so it's now ${width}×${height} pixels and could look soft on a big banner.`,
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
