// Phone photo upload suite (MED-01). Everything a plain node process can prove:
// the pure size plan, the upload path driven by a stand-in canvas, and the REAL
// /api/admin/media route (real requireAdmin, real saveMedia, real tenant db) so
// the server limits, magic-byte checks and SVG sanitizing are shown still to run.
// Real pixels through a real canvas can't run here: that is the browser drill
// listed in docs/cms-reviews/P1-MED-01.md.
//   pnpm test:media-upload
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// The route file uses Next's import spellings, which plain node can't resolve.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(root, `${spec.slice(2)}.js`)).href, ctx);
    if (/^next\/(server|headers|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-medupload-default.db";
process.env.PLATFORM_DB_URL = "file:.test-medupload-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-medupload-default.db", ".test-medupload-platform.db", ".test-medupload-tenant.db"];
for (const f of dbs) await rm(join(root, f), { force: true });

const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db } = await import("../lib/db.js");
const M = await import("../lib/media.js");
const P = await import("../lib/media-upload-plan.js");
const U = await import("../lib/media-upload.js");
const route = await import("../app/api/admin/media/route.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const includes = (s, part, label = "") => {
  if (!String(s).includes(part)) throw new Error(`${label} expected ${JSON.stringify(s)} to include ${JSON.stringify(part)}`);
};

// --- fixtures ----------------------------------------------------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await C.upsertTenant({ id: "mu", name: "Media Upload", domains: ["mu.test"], dbUrl: "file:.test-medupload-tenant.db", config: {}, secrets: {} });
const TENANT = await C.getTenant("mu");
const tdb = createClient({ url: "file:.test-medupload-tenant.db" });
await tdb.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
await runMigrations(tdb, await loadMigrations("tenant"));
const inT = (fn) => withTenant(TENANT, fn);

const ownerU = await I.createUser({ email: "owner@mu.test", password: "owner-pass-med" });
const supportU = await I.createUser({ email: "support@mu.test", password: "support-pass-med" });
await I.addMembership(ownerU.id, "mu", "owner");
await I.addMembership(supportU.id, "mu", "support");
const ownerTok = (await S.createSession({ userId: ownerU.id, kind: "merchant", ttlMs: 60_000 })).token;
const supportTok = (await S.createSession({ userId: supportU.id, kind: "merchant", ttlMs: 60_000 })).token;

const MAGIC = {
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/webp": [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  "image/gif": [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
};
// `seed` keeps stored rows from deduping against each other by content.
let seed = 0;
function bytesOf(mime, size) {
  const b = new Uint8Array(size);
  b.set(MAGIC[mime] || []);
  b[size - 1] = seed % 256;
  b[size - 2] = ++seed >> 8;
  return b;
}
const photoFile = (name, size, mime = "image/jpeg") => new File([bytesOf(mime, size)], name, { type: mime });

// Stand-in for the canvas: sizes follow real encodes of a photo-like 4032x3024
// image (0.116 bytes per pixel at quality 0.85 for a 5MB source, measured with
// sharp while building this; `detail` scales for busier pictures). Output carries
// real magic bytes, so the real server accepts or refuses it on its own terms.
// Like a real decoded image it can't be used once closed. It looks after a tick, so
// a caller that closes the image without waiting for the encode is caught too.
function fakeCodec({ width = 4032, height = 3024, detail = 1, alpha = false, writesWebp = true, undecodable = false, cannotTry = false, nullBlobs = false, throwAbove = 0, encodedSize = null } = {}) {
  const calls = { encode: [], decode: 0, hasAlpha: 0, alphaSize: [], closed: 0 };
  return {
    calls,
    decode: async () => {
      calls.decode++;
      if (undecodable) throw new Error("The source image could not be decoded.");
      if (cannotTry) return null;
      const image = {
        width,
        height,
        close: () => {
          image.closed = true;
          calls.closed++;
        },
      };
      return image;
    },
    hasAlpha: async (image, size) => {
      calls.hasAlpha++;
      calls.alphaSize.push(size);
      await null;
      if (image.closed) throw new Error("the image was closed before it was read");
      return alpha;
    },
    encode: async (image, step) => {
      calls.encode.push(step);
      await null;
      if (image.closed) throw new Error("the image was closed before it was written");
      if (throwAbove && Math.max(step.width, step.height) > throwAbove) throw new Error("canvas too large");
      if (nullBlobs) return null;
      const mime = step.mime === "image/webp" && !writesWebp ? "image/png" : step.mime;
      const perPixel = mime === "image/png" ? 2 : 0.116 * Math.pow((step.quality || 0.85) / 0.85, 3.5);
      const size = encodedSize ?? Math.max(16, Math.round(step.width * step.height * perPixel * detail));
      return new Blob([bytesOf(mime, size)], { type: mime });
    },
  };
}

// Just enough real structure for isAnimated: PNG chunks and WebP RIFF chunks.
const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
const pngChunk = (type, data = []) => [0, 0, data.length >> 8, data.length & 255, ...ascii(type), ...data, 0, 0, 0, 0];
const pngOf = (...chunks) => new Uint8Array([...MAGIC["image/png"], ...chunks.flat()]);
const webpOf = (fourcc, payload) => new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii(fourcc), payload.length, 0, 0, 0, ...payload]);
const ANIM_FLAG = 0x02;
const ALPHA_FLAG = 0x10;
const ANIMATED_WEBP = webpOf("VP8X", [ANIM_FLAG, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const ANIMATED_PNG = pngOf(pngChunk("IHDR", new Array(13).fill(0)), pngChunk("acTL", [0, 0, 0, 3, 0, 0, 0, 0]), pngChunk("IDAT", [1, 2, 3]));
const padded = (bytes, size) => {
  const out = new Uint8Array(size);
  out.set(bytes);
  out[size - 1] = seed % 256;
  out[size - 2] = ++seed >> 8;
  return out;
};

// The real route handler, with what requireAdmin + tenantHandler actually read.
const realSend = (cookie = ownerTok) => async (form, onPercent) => {
  onPercent?.(40);
  onPercent?.(100);
  const body = new Request("http://mu.test/api/admin/media", { method: "POST", body: form });
  const res = await route.POST({
    headers: { get: (k) => ({ host: "mu.test", origin: "http://mu.test" })[k.toLowerCase()] ?? null },
    cookies: { get: (name) => (name === "_admin" ? { value: cookie } : undefined) },
    formData: () => body.formData(),
  });
  return { status: res.status, json: await res.json() };
};
const postDirect = (fields, cookie) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return realSend(cookie)(form);
};
const neverSend = async () => {
  throw new Error("must not reach the network");
};
const stored = (id) => inT(() => db.selectFrom("media").select(["id", "mime", "size", "width", "height", "variant", "parent_id", "filename"]).where("id", "=", id).executeTakeFirst());
const thumbOf = (id) => inT(() => db.selectFrom("media").select(["id", "mime", "width", "height", "variant"]).where("parent_id", "=", id).executeTakeFirst());

const mediaCount = () => inT(async () => (await db.selectFrom("media").select("id").execute()).length);
const storedText = async (id) => new TextDecoder().decode((await inT(() => M.getMediaFile(id))).data);

const LIMIT = 1_500_000;

// ---- server rules stay exactly as they are ------------------------------------
console.log("— server rules");

await t("server limits are unchanged, and the browser's copy matches them", () => {
  eq(
    Object.fromEntries(Object.entries(M.MEDIA_MIME).map(([k, v]) => [k, v.max])),
    { "image/png": 1_500_000, "image/jpeg": 1_500_000, "image/webp": 1_500_000, "image/gif": 1_500_000, "image/svg+xml": 300_000 },
    "MEDIA_MIME:"
  );
  eq(P.CLIENT_MEDIA_LIMITS, Object.fromEntries(Object.entries(M.MEDIA_MIME).map(([k, v]) => [k, v.max])), "client copy:");
  eq(P.RESIZED_MAX_BYTES, M.MEDIA_MIME["image/jpeg"].max);
});

await t("server size limit holds at the exact byte for every type", () => {
  for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
    eq(M.validateUpload({ filename: "a", mime, bytes: bytesOf(mime, LIMIT) }).ok, true, `${mime} at limit:`);
    eq(M.validateUpload({ filename: "a", mime, bytes: bytesOf(mime, LIMIT + 1) }).ok, false, `${mime} over limit:`);
  }
  const svg = (n) => new TextEncoder().encode(`<svg>${" ".repeat(n - 5)}`);
  eq(M.validateUpload({ filename: "a", mime: "image/svg+xml", bytes: svg(300_000) }).ok, true, "svg at limit:");
  eq(M.validateUpload({ filename: "a", mime: "image/svg+xml", bytes: svg(300_001) }).ok, false, "svg over limit:");
});

await t("magic-byte sniffing still decides what a file really is", () => {
  for (const [mime, magic] of Object.entries(MAGIC)) eq(M.sniffMime(bytesOf(mime, Math.max(16, magic.length))), mime, "sniff:");
  eq(M.sniffMime(new TextEncoder().encode("<svg xmlns='x'></svg>")), "image/svg+xml");
  eq(M.sniffMime(new TextEncoder().encode("%PDF-1.7 not an image")), null);
  const lie = M.validateUpload({ filename: "fake.jpg", mime: "image/jpeg", bytes: bytesOf("image/png", 64) });
  eq(lie.ok, false);
  includes(lie.errors.join(), "doesn't match");
});

await t("magic-byte sniffing checks every byte of each signature, and each format's shortest length", () => {
  const signatures = [
    ["image/png", [[0, [0x89, 0x50, 0x4e, 0x47]]], 8],
    ["image/jpeg", [[0, [0xff, 0xd8, 0xff]]], 3],
    ["image/gif", [[0, [0x47, 0x49, 0x46, 0x38]]], 6],
    ["image/webp", [[0, ascii("RIFF")], [8, ascii("WEBP")]], 12],
  ];
  for (const [mime, parts, shortest] of signatures) {
    const whole = new Uint8Array(16);
    for (const [at, values] of parts) whole.set(values, at);
    eq(M.sniffMime(whole), mime, `${mime} whole:`);
    for (const [at, values] of parts) {
      for (let i = 0; i < values.length; i++) {
        const wrong = whole.slice();
        wrong[at + i] ^= 1;
        eq(M.sniffMime(wrong), null, `${mime} byte ${at + i} wrong:`);
      }
    }
    eq(M.sniffMime(whole.slice(0, shortest)), mime, `${mime} at its shortest:`);
    eq(M.sniffMime(whole.slice(0, shortest - 1)), null, `${mime} one byte short:`);
  }
});

// The brief says these stay exactly as they are, proven by test. The route cases
// below pin what they do for the inputs they list. This pins their exact source
// text, so ANY edit fails here until someone changes the pin on purpose.
const SERVER_RULE_PINS = {
  MEDIA_MIME: "3f1f38b2bf5ed3904bf92ca37015df546d384bc344f9bf969a49f47a208dd2f5",
  sniffMime: "5c92a6127c84982419155511e8d0ad809826f7e2d86acad1664b825bc7b16e75",
  sanitizeSvg: "782c3afb176bafa2b10eca150b70ca9bc5e3e61e6d72b6aa97083ab7967b3c96",
  validateUpload: "6431bb9b354d040d8a8477a7f794a88e58da0f698d30c39e0b3d052841092f36",
  "saveMedia's sanitize line": "41bf910df248491b145a6455c59832a80fcf9fc07679bd38dff6d4d140187a4c",
};

await t("the server's rules are exactly the text they were: limits, magic-byte check, SVG cleaning, validation", async () => {
  const text = await readFile(join(root, "lib/media.js"), "utf8");
  const block = (from, to) => {
    const start = text.indexOf(from);
    const end = text.indexOf(to, start);
    ok(start >= 0 && end > start, `lib/media.js no longer has ${from}:`);
    return text.slice(start, end + to.length);
  };
  const sanitizeLines = block("export async function saveMedia(", "\n}\n").split("\n").filter((line) => line.includes("sanitizeSvg"));
  eq(sanitizeLines.length, 1, "saveMedia cleans SVG in exactly one place:");
  const current = {
    MEDIA_MIME: block("export const MEDIA_MIME = {", "\n};\n"),
    sniffMime: block("export function sniffMime(", "\n}\n"),
    sanitizeSvg: block("export function sanitizeSvg(", "\n}\n"),
    validateUpload: block("export function validateUpload(", "\n}\n"),
    "saveMedia's sanitize line": sanitizeLines[0],
  };
  for (const [name, want] of Object.entries(SERVER_RULE_PINS)) {
    const got = createHash("sha256").update(current[name]).digest("hex");
    if (got !== want) throw new Error(`${name} in lib/media.js changed (now ${got}). These rules must stay as they are. If this change is meant, update the pin in scripts/test-media-upload.js.`);
  }
});

await t("route: a PNG signature with nothing after it is refused and nothing is stored", async () => {
  const before = await mediaCount();
  const r = await postDirect({ file: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", { type: "image/png" }) });
  eq(r.status, 422);
  includes(r.json.errors.join(), "doesn't match");
  eq(await mediaCount(), before);
});

await t("route: the stored file name is cleaned, and a useless one becomes 'upload'", async () => {
  const stem = `name-${seed}`;
  const r = await postDirect({ file: new File([bytesOf("image/jpeg", 64)], `${stem} (final)!$/../x.jpg`, { type: "image/jpeg" }) });
  eq(r.status, 200);
  eq((await stored(r.json.media.id)).filename, `${stem} final..x.jpg`);
  eq(M.validateUpload({ filename: "!!!", mime: "image/jpeg", bytes: bytesOf("image/jpeg", 64) }).filename, "upload", "nothing left:");
  eq(M.validateUpload({ filename: "a".repeat(200), mime: "image/jpeg", bytes: bytesOf("image/jpeg", 64) }).filename.length, 120, "cut short:");
});

await t("route: a bad preview never costs the photo", async () => {
  const r = await postDirect({
    file: photoFile("keeps.jpg", 2048),
    thumb: new File([bytesOf("image/png", 64)], "thumb.webp", { type: "image/webp" }),
    thumbWidth: "480",
    thumbHeight: "360",
  });
  eq(r.status, 200);
  eq(r.json.thumb, null);
  eq((await stored(r.json.media.id)).filename, "keeps.jpg");
  eq(await thumbOf(r.json.media.id), undefined, "no preview row:");
});

await t("route: a raw 5MB photo sent past the browser step is still refused", async () => {
  const r = await postDirect({ file: photoFile("raw.jpg", 5_000_000) });
  eq(r.status, 422);
  includes(r.json.errors.join(), "the limit for jpg");
});

await t("route: PNG bytes declared as JPEG are refused by the magic-byte check", async () => {
  const r = await postDirect({ file: new File([bytesOf("image/png", 2048)], "fake.jpg", { type: "image/jpeg" }) });
  eq(r.status, 422);
  includes(r.json.errors.join(), "doesn't match");
});

await t("route: HEIC and PDF sent directly are refused by type", async () => {
  for (const [name, type] of [["a.heic", "image/heic"], ["a.pdf", "application/pdf"]]) {
    const r = await postDirect({ file: new File([bytesOf("image/jpeg", 64)], name, { type }) });
    eq(r.status, 422, `${type}:`);
    includes(r.json.errors.join(), "not allowed", `${type}:`);
  }
});

await t("route: an SVG uploaded through the shared path is sanitized before it is stored", async () => {
  const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"><script>alert(1)</script><foreignObject><b>x</b></foreignObject><a href="javascript:evil()"><rect width="9" height="9" onclick="evil()"/></a></svg>`;
  const r = await U.uploadImage(new File([dirty], "logo.svg", { type: "image/svg+xml" }), { codec: fakeCodec({ undecodable: true }), send: realSend() });
  ok(r.ok, "uploaded:");
  const file = await inT(() => M.getMediaFile(r.media.id));
  const text = new TextDecoder().decode(file.data);
  for (const bad of ["<script", "onload", "onclick", "foreignObject", "javascript:"]) ok(!text.includes(bad), `stored svg has ${bad}:`);
  includes(text, "<rect");
});

// The rest of the sanitizer and sniffer, through the real route. These compare the
// exact stored bytes for the cases listed. Other edits to the rules are caught by the
// source pin above.
const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg">';
const svgThroughRoute = async (inner) => {
  const r = await postDirect({ file: new File([`${SVG_OPEN}${inner}</svg>`], "logo.svg", { type: "image/svg+xml" }) });
  eq(r.status, 200, `${inner}:`);
  return (await storedText(r.json.media.id)).slice(SVG_OPEN.length, -"</svg>".length);
};

await t("route: every SVG element that can run or load something is stored without it", async () => {
  for (const tag of ["script", "foreignObject", "iframe", "object", "embed", "animate", "set", "handler"]) {
    eq(await svgThroughRoute(`<${tag} x="1"><b>inside</b></${tag}><rect/>`), "<rect/>", `${tag} with content:`);
    eq(await svgThroughRoute(`<${tag} x="1"/><circle/>`), "<circle/>", `${tag} self-closed:`);
  }
  eq(await svgThroughRoute(`<IFRAME src="https://evil.example"></IFRAME><rect/>`), "<rect/>", "upper case:");
  eq(await svgThroughRoute(`<animateTransform attributeName="x"/><rect/>`), "<rect/>", "animate family:");
});

await t("route: every event handler is stored without it, however it is quoted", async () => {
  eq(await svgThroughRoute(`<rect onclick="a()" ONMOUSEOVER='b()' onfocus=c() width="9"/>`), `<rect width="9"/>`);
  eq(await svgThroughRoute(`<rect onclick = "x()"/>`), "<rect/>", "spaces around the equals sign:");
});

await t("route: a closing tag with a space after its name still ends the element", async () => {
  eq(await svgThroughRoute("<script>x</script ><rect/>"), "<rect/>");
});

await t("route: an SVG posted as the preview is stored clean too", async () => {
  const r = await postDirect({
    file: photoFile("with-svg-thumb.jpg", 2048),
    thumb: new File([`${SVG_OPEN}<script>evil()</script><rect onclick="evil()" r="${++seed}"/></svg>`], "thumb.svg", { type: "image/svg+xml" }),
    thumbWidth: "480",
    thumbHeight: "360",
  });
  eq(r.status, 200);
  ok(r.json.thumb, "stored as the preview:");
  eq(await storedText(r.json.thumb.id), `${SVG_OPEN}<rect r="${seed}"/></svg>`);
});

await t("route: unsafe links are stored without them, safe links are kept", async () => {
  const unsafe = ["javascript:evil()", "JaVaScRiPt:evil()", "java\tscript:evil()", "data:text/html,x", "data:image/svg+xml;base64,AAAA", "http://evil.example/x.png", "//evil.example/x.png", "https:evil.example/x.png", "vbscript:evil()", "relative.png"];
  for (const value of unsafe) {
    for (const attr of ["href", "xlink:href", "src"]) eq(await svgThroughRoute(`<image ${attr}="${value}"/>`), "<image/>", `${attr}=${value}:`);
    eq(await svgThroughRoute(`<image href='${value}'/>`), "<image/>", `single-quoted ${value}:`);
  }
  eq(await svgThroughRoute(`<a href = "javascript:x()"/>`), "<a/>", "spaces around the equals sign:");
  eq(await svgThroughRoute(`<image href="/\t/evil.example/x.png"/>`), "<image/>", "a tab hiding a protocol-relative link:");
  for (const value of ["#shape", "https://ok.example/x.png", "/api/media/med_1"]) {
    const kept = `<image href="${value}"/>`;
    eq(await svgThroughRoute(kept), kept, "kept:");
  }
});

await t("route: files that only look like an image are refused and nothing is stored", async () => {
  const encode = (text) => new TextEncoder().encode(text);
  const cases = [
    ["a RIFF file that isn't WebP", new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVEfmt "), 0, 0, 0, 0]), "image/webp"],
    ["PHP wearing an SVG", encode(`<?php system("id"); ?>${SVG_OPEN}</svg>`), "image/svg+xml"],
    ["PHP after blank lines", encode(`\n\n  <?PHP echo 1; ?>${SVG_OPEN}</svg>`), "image/svg+xml"],
    ["<svg buried past the sniff window", encode(`${"x".repeat(1000)}${SVG_OPEN}</svg>`), "image/svg+xml"],
  ];
  for (const [label, bytes, type] of cases) {
    const before = await mediaCount();
    const r = await postDirect({ file: new File([bytes], "a.bin", { type }) });
    eq(r.status, 422, `${label}:`);
    includes(r.json.errors.join(), "doesn't match", `${label}:`);
    eq(await mediaCount(), before, `${label} stored nothing:`);
  }
});

await t("route: an SVG is measured and sniffed after cleaning, not before", async () => {
  const limit = M.MEDIA_MIME["image/svg+xml"].max;
  const send = (text) => postDirect({ file: new File([text], "logo.svg", { type: "image/svg+xml" }) });
  const clean = `${SVG_OPEN}<rect width="${++seed}"/></svg>`;
  const fat = await send(`${SVG_OPEN}<script>${"x".repeat(limit)}</script><rect width="${seed}"/></svg>`);
  eq(fat.status, 200, "over the limit only before cleaning:");
  eq(await storedText(fat.json.media.id), clean);
  const big = await send(`${SVG_OPEN}<desc>${"x".repeat(limit)}</desc></svg>`);
  eq(big.status, 422, "still over the limit after cleaning:");
  includes(big.json.errors.join(), "the limit for svg");
  const late = await send(`<script>${"x".repeat(2000)}</script>${SVG_OPEN}<circle r="${++seed}"/></svg>`);
  eq(late.status, 200, "past the sniff window only before cleaning:");
  eq(await storedText(late.json.media.id), `${SVG_OPEN}<circle r="${seed}"/></svg>`);
  const before = await mediaCount();
  const hollow = await send("<script><svg></script>just some text");
  eq(hollow.status, 422, "an SVG only before cleaning:");
  includes(hollow.json.errors.join(), "doesn't match");
  eq(await mediaCount(), before, "nothing stored:");
});

await t("route: read-only support is still refused, in plain words", async () => {
  const r = await U.uploadImage(photoFile("a.jpg", 2048), { codec: fakeCodec({ width: 800, height: 600 }), send: realSend(supportTok) });
  eq(r.ok, false);
  eq(r.message, P.uploadMessage.noPermission());
});

// ---- the size plan ------------------------------------------------------------
console.log("— size plan");

await t("the pickers offer image/*, so a HEIC can be picked and get a plain answer", () => {
  eq(P.UPLOAD_ACCEPT, "image/*");
});

await t("classify: what happens to each kind of file", () => {
  const cases = [
    ["image/jpeg", "a.jpg", "resize"],
    ["image/png", "a.png", "resize"],
    ["image/webp", "a.webp", "resize"],
    ["image/gif", "a.gif", "as-is"],
    ["image/svg+xml", "a.svg", "as-is"],
    ["image/heic", "IMG_1.HEIC", "convert"],
    ["image/avif", "a.avif", "convert"],
    ["application/pdf", "a.pdf", "refuse"],
    ["text/plain", "photo.jpg", "refuse"], // the browser's word beats the name
    ["video/mp4", "a.mp4", "refuse"],
  ];
  for (const [type, name, action] of cases) eq(P.classifyUpload({ type, name }).action, action, `${type} ${name}:`);
});

await t("classify: an empty type falls back to the file name; HEIC is named as HEIC", () => {
  const byName = { jpg: "image/jpeg", JPEG: "image/jpeg", JFIF: "image/jpeg", png: "image/png", apng: "image/png", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", heic: "image/heic", heif: "image/heif", avif: "image/avif" };
  for (const [ext, mime] of Object.entries(byName)) {
    eq(P.classifyUpload({ type: "", name: `a.${ext}` }).mime, mime, `${ext}:`);
    eq(P.classifyUpload({ type: "application/octet-stream", name: `a.${ext}` }).mime, mime, `${ext} octet-stream:`);
  }
  eq(P.classifyUpload({ type: "", name: "IMG_1.JPG" }), { action: "resize", mime: "image/jpeg" });
  eq(P.classifyUpload({ type: "application/octet-stream", name: "a.png" }), { action: "resize", mime: "image/png" });
  eq(P.classifyUpload({ type: "", name: "IMG_2.heic" }), { action: "convert", mime: "image/heic", heic: true });
  eq(P.classifyUpload({ type: "image/heif", name: "x" }).heic, true);
  eq(P.classifyUpload({ type: "image/avif", name: "x" }).heic, false);
});

await t("classify: older type names count as the standard ones", () => {
  for (const type of ["image/jpg", "image/pjpeg", "IMAGE/JPG"]) eq(P.classifyUpload({ type, name: "a" }), { action: "resize", mime: "image/jpeg" }, `${type}:`);
  for (const type of ["image/x-png", "image/apng"]) eq(P.classifyUpload({ type, name: "a" }), { action: "resize", mime: "image/png" }, `${type}:`);
});

await t("classify: no type and no name we know is left for the file itself to answer", () => {
  for (const name of ["camera_upload", "notes.txt", ""]) eq(P.classifyUpload({ type: "", name }), { action: "convert", mime: "", heic: false, unnamed: true }, `"${name}":`);
});

await t("sniffImage agrees with the server's check on every case the server test uses", () => {
  const whole = (values, at = 0) => {
    const b = new Uint8Array(16);
    b.set(values, at);
    return b;
  };
  const samples = [...Object.keys(MAGIC).map((mime) => bytesOf(mime, 16)), new Uint8Array(16), new Uint8Array(0)];
  for (const b of [whole([0x89, 0x50, 0x4e, 0x47]), whole([0xff, 0xd8, 0xff]), whole([0x47, 0x49, 0x46, 0x38]), bytesOf("image/webp", 16)]) {
    for (const end of [16, 12, 11, 8, 7, 6, 5, 4, 3, 2]) samples.push(b.slice(0, end));
    for (let i = 0; i < 12; i++) {
      const wrong = b.slice();
      wrong[i] ^= 1;
      samples.push(wrong);
    }
  }
  for (const b of samples) eq(P.sniffImage(b), M.sniffMime(b), `[${[...b.slice(0, 12)]}]:`);
  eq(P.sniffImage(new TextEncoder().encode("<svg></svg>")), null, "svg isn't its job:");
});

await t("when to skip: within the limit, unless both sides are over the target and it is no wider than 16:9", () => {
  const go = (size, width, height, action = "resize") => P.shouldResize({ size, width, height, action });
  eq(go(LIMIT, 1920, 1080), false, "exactly at both limits:");
  eq(go(200_000, 800, 600), false, "small:");
  eq(go(LIMIT + 1, 800, 600), true, "over the bytes:");
  eq(go(500_000, 1921, 1921), true, "both sides over the target:");
  eq(go(500_000, 2600, 2200), true, "a photo-shaped picture:");
  eq(go(LIMIT, 1920, 5000), false, "short side at the target, however long:");
  eq(go(LIMIT, 5000, 1920), false, "the same, on its side:");
  eq(go(209_179, 1080, 5000), false, "a long size chart:");
  eq(go(62_000, 4000, 400), false, "a wide strip:");
  // the verifier's cases: re-encoding these could only cut the short side to 1080
  eq(go(1_109_354, 1921, 5000), false, "long, short side just over the target:");
  eq(go(1_109_354, 5000, 1921), false, "the same, on its side:");
  eq(go(1_321_451, 2000, 6000), false, "long, short side well over the target:");
  eq(go(LIMIT, 7000, 1921), false, "as wide as the 7000x1900 that is kept whole:");
  eq(go(LIMIT, 6000, 2000), false, "3:1:");
  // the 16:9 line, exactly where fitEdges changes from the long edge to the short one
  eq(go(LIMIT, 3840, 2160), true, "exactly 16:9:");
  eq(go(LIMIT, 2160, 3840), true, "exactly 16:9, upright:");
  eq(go(LIMIT, 3841, 2160), false, "1px wider than 16:9:");
  eq(go(LIMIT, 2160, 3841), false, "1px taller than 16:9:");
  eq(go(LIMIT, 3413, 1921), true, "just inside 16:9 with the short side just over:");
  // over the limit the shape doesn't matter: the server won't take it as it is
  eq(go(LIMIT + 1, 1921, 5000), true, "long and over the bytes:");
  eq(go(LIMIT + 1, 7000, 1921), true, "wide and over the bytes:");
  eq(go(1000, 10, 10, "convert"), true, "the server can't take it as it is:");
  eq(go(1000, 1080, 5000, "convert"), true, "nor a long one:");
});

await t("fitEdges: a normal photo goes by its long edge, never upscales and keeps the aspect", () => {
  eq(P.fitEdges(4032, 3024, 1920), { width: 1920, height: 1440 });
  eq(P.fitEdges(3024, 4032, 1920), { width: 1440, height: 1920 });
  eq(P.fitEdges(3840, 2160, 1920), { width: 1920, height: 1080 }, "exactly 16:9:");
  eq(P.fitEdges(800, 600, 1920), { width: 800, height: 600 });
  eq(P.fitEdges(4032, 3024, 1280), { width: 1280, height: 960 });
});

await t("fitEdges: a long image goes by its short edge, so it stays readable", () => {
  eq(P.fitEdges(1170, 6000, 1920), { width: 1080, height: 5538 }, "long screenshot:");
  eq(P.fitEdges(6000, 1170, 1920), { width: 5538, height: 1080 }, "on its side:");
  eq(P.fitEdges(1080, 5000, 1920), { width: 1080, height: 5000 }, "already at the floor:");
  eq(P.fitEdges(4000, 400, 1920), { width: 4000, height: 400 }, "never upscaled to reach the floor:");
  eq(P.fitEdges(1170, 6000, 1600), { width: 900, height: 4615 }, "the floor falls with the size being tried:");
  eq(P.fitEdges(1170, 6000, 800), { width: 450, height: 2308 });
});

await t("fitEdges: nothing is ever written longer than a canvas can be trusted with", () => {
  eq(P.fitEdges(1000, 30000, 1920), { width: 273, height: 8192 });
  eq(P.fitEdges(30000, 1000, 1920), { width: 8192, height: 273 });
  eq(P.fitEdges(1000, 8192, 1920), { width: 1000, height: 8192 }, "exactly at the cap:");
  eq(P.fitEdges(100000, 1, 1920), { width: 8192, height: 1 }, "never collapses to zero:");
});

await t("endedUpSmaller: told when an edge fell below what a good upload keeps, not otherwise", () => {
  const smaller = (w, h, toW, toH) => P.endedUpSmaller({ width: w, height: h }, { width: toW, height: toH });
  eq(smaller(4032, 3024, 1920, 1440), false, "a normal photo at the target:");
  eq(smaller(4032, 3024, 1919, 1439), true, "just under the long target:");
  eq(smaller(3840, 2160, 1920, 1080), false, "16:9 at the target:");
  eq(smaller(1000, 800, 1000, 800), false, "kept its own size:");
  eq(smaller(1000, 800, 800, 640), true, "fell below its own size:");
  eq(smaller(1170, 6000, 1080, 5538), false, "a long image keeping the short floor:");
  eq(smaller(1170, 6000, 1079, 5533), true, "just under the short floor:");
  eq(smaller(800, 6000, 800, 6000), false, "narrower than the floor and unchanged:");
  eq(smaller(800, 6000, 700, 5250), true, "narrower than the floor and cut:");
  eq(smaller(1170, 6000, 374, 1920), true, "the old 374x1920 would have told the founder:");
  eq(smaller(4000, 400, 1920, 192), true, "the old 1920x192 too:");
});

await t("steps: a photo starts at 1920 and holds it through every quality step before shrinking", () => {
  const steps = P.encodeSteps({ width: 4032, height: 3024, hasAlpha: false });
  ok(steps.every((s) => s.mime === "image/jpeg"), "all jpeg:");
  eq(steps[0], { mime: "image/jpeg", quality: 0.85, width: 1920, height: 1440 });
  const edges = steps.map((s) => s.width);
  eq(edges.slice(0, 5), [1920, 1920, 1920, 1920, 1920]);
  eq(steps.slice(0, 5).map((s) => s.quality), [0.85, 0.78, 0.7, 0.62, 0.55]);
  ok(edges.every((e, i) => i === 0 || e <= edges[i - 1]), "never grows again:");
  eq(Math.min(...edges), 1280, "lowest photo size:");
  eq(steps.slice(5).map((s) => [s.width, s.quality]), [[1600, 0.7], [1600, 0.6], [1280, 0.7], [1280, 0.6]], "the last resorts:");
});

await t("steps: a transparent image never gets a JPEG step", () => {
  const steps = P.encodeSteps({ width: 3000, height: 3000, hasAlpha: true });
  ok(!steps.some((s) => s.mime === "image/jpeg"), "no jpeg:");
  eq(steps[0].mime, "image/webp");
  eq(steps[steps.length - 1], { mime: "image/png", width: 800, height: 800 });
  ok(steps.filter((s) => s.mime === "image/png").every((s) => !("quality" in s)), "png has no quality:");
  eq(steps.filter((s) => s.mime === "image/png").map((s) => s.width), [1920, 1600, 1280, 1024, 800], "every PNG size:");
});

await t("steps: a small source is never upscaled and repeats nothing", () => {
  const steps = P.encodeSteps({ width: 1000, height: 500, hasAlpha: false });
  ok(steps.every((s) => s.width <= 1000 && s.height <= 500), "no upscale:");
  eq(new Set(steps.map((s) => `${s.mime}|${s.quality}|${s.width}`)).size, steps.length, "no repeats:");
});

await t("hasTransparency reads the alpha channel", () => {
  eq(P.hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255])), false);
  eq(P.hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254])), true);
  eq(P.hasTransparency(new Uint8ClampedArray([255, 255, 255, 0])), true);
});

await t("isAnimated reads the file's structure, not just its letters", () => {
  eq(P.isAnimated(ANIMATED_WEBP), true, "animated webp:");
  eq(P.isAnimated(ANIMATED_PNG), true, "apng:");
  eq(P.isAnimated(webpOf("VP8X", [ALPHA_FLAG, 0, 0, 0, 0, 0, 0, 0, 0, 0])), false, "still webp with transparency:");
  // byte 20 is the flags byte only in VP8X; here it is picture data with the same bit set
  eq(P.isAnimated(webpOf("VP8 ", [ANIM_FLAG, ...ascii("ANMF")])), false, "still webp with the flag bit and the letters in its picture data:");
  eq(P.isAnimated(pngOf(pngChunk("IHDR", new Array(13).fill(0)), pngChunk("IDAT", ascii("acTL")), pngChunk("IEND"))), false, "still png with the letters in its picture data:");
  eq(P.isAnimated(pngOf(pngChunk("IHDR"), pngChunk("IDAT"), pngChunk("acTL"))), false, "a late animation chunk doesn't count:");
  eq(P.isAnimated(pngOf(pngChunk("tEXt", ascii("acTL")), pngChunk("IDAT"))), false, "the letters in a text note don't count:");
  eq(P.isAnimated(pngOf(pngChunk("tEXt", ascii("acTL")), pngChunk("acTL"))), true, "found past other chunks:");
  eq(P.isAnimated(ANIMATED_PNG.subarray(0, 12)), false, "cut off mid-chunk:");
  eq(P.isAnimated(new Uint8Array(MAGIC["image/png"])), false, "signature only:");
  eq(P.isAnimated(new Uint8Array(ascii("RIFF"))), false, "cut off RIFF:");
  eq(P.isAnimated(new Uint8Array(0)), false, "empty:");
  eq(P.isAnimated(new Uint8Array(MAGIC["image/jpeg"])), false, "jpeg:");
});

await t("keepOriginal: only when re-encoding gained nothing and the server takes the original", () => {
  eq(P.keepOriginal({ size: 500, encodedSize: 600, action: "resize" }), true, "grew:");
  eq(P.keepOriginal({ size: 500, encodedSize: 500, action: "resize" }), true, "same:");
  eq(P.keepOriginal({ size: 500, encodedSize: 400, action: "resize" }), false, "smaller:");
  eq(P.keepOriginal({ size: 500, encodedSize: null, action: "resize" }), true, "nothing fit:");
  eq(P.keepOriginal({ size: LIMIT + 1, encodedSize: LIMIT + 2, action: "resize" }), false, "over the limit:");
  eq(P.keepOriginal({ size: 500, encodedSize: 600, action: "convert" }), false, "HEIC stays refused:");
});

await t("renameFor follows the new format; thumbSize matches the old thumbnail rule", () => {
  eq(P.renameFor("IMG_1.HEIC", "image/jpeg"), "IMG_1.jpg");
  eq(P.renameFor("logo.final.png", "image/webp"), "logo.final.webp");
  eq(P.renameFor("noext", "image/jpeg"), "noext.jpg");
  eq(P.thumbSize({ mime: "image/jpeg", width: 1920, height: 1440 }), { width: 480, height: 360 });
  eq(P.thumbSize({ mime: "image/png", width: 480, height: 480 }), null, "already small:");
  eq(P.thumbSize({ mime: "image/gif", width: 2000, height: 2000 }), null, "gif:");
  eq(P.thumbSize({ mime: "image/svg+xml", width: 2000, height: 2000 }), null, "svg:");
});

// ---- the upload path ----------------------------------------------------------
console.log("— upload path");

await t("ACCEPTANCE: a 5MB phone photo uploads with no error, long edge >= 1920, within the limit", async () => {
  const progress = [];
  const r = await U.uploadImage(photoFile("IMG_0042.jpg", 5_000_000), { codec: fakeCodec(), send: realSend(), onProgress: (p) => progress.push(p) });
  ok(r.ok, `uploaded (${r.message}):`);
  const row = await stored(r.media.id);
  eq(row.mime, "image/jpeg");
  ok(row.size <= LIMIT, `size ${row.size}:`);
  eq([row.width, row.height], [1920, 1440], "real dimensions recorded:");
  eq(r.notice, null, "nothing to warn about:");
  const thumb = await thumbOf(r.media.id);
  eq([thumb.variant, thumb.width, thumb.height], ["thumb", 480, 360], "thumbnail attached:");
});

await t("a portrait photo keeps its long edge at 1920", async () => {
  const r = await U.prepareImage(photoFile("p.jpg", 5_000_000), fakeCodec({ width: 3024, height: 4032 }));
  eq([r.width, r.height], [1440, 1920]);
  eq([r.thumb.width, r.thumb.height], [480, 640]);
});

await t("progress: the founder sees stages and a percentage, in order, then no size error", async () => {
  const seen = [];
  await U.uploadImage(photoFile("a.jpg", 5_000_000), { codec: fakeCodec(), send: realSend(), onProgress: (p) => seen.push(P.progressLabel(p)) });
  eq(seen, ["Getting a.jpg ready…", "Uploading a.jpg… 0%", "Uploading a.jpg… 40%", "Saving a.jpg…"]);
});

await t("LONG: a 1080x5000 size chart within the limit goes up untouched", async () => {
  const file = photoFile("sizechart.jpg", 209_179);
  const codec = fakeCodec({ width: 1080, height: 5000 });
  const prepared = await U.prepareImage(file, codec);
  ok(prepared.file === file, "the same file:");
  eq([prepared.width, prepared.height, !!prepared.reduced], [1080, 5000, false]);
  eq(codec.calls.encode.map((s) => s.quality), [0.82], "only the library preview was made:");
  eq([prepared.thumb.width, prepared.thumb.height], [480, 2222]);
  const r = await U.uploadImage(file, { codec: fakeCodec({ width: 1080, height: 5000 }), send: realSend() });
  ok(r.ok, `uploaded (${r.message}):`);
  const row = await stored(r.media.id);
  eq([row.mime, row.size, row.width, row.height, row.filename], ["image/jpeg", 209_179, 1080, 5000, "sizechart.jpg"]);
  eq(r.notice, null);
});

await t("LONG: a 4000x400 strip within the limit goes up untouched", async () => {
  const file = photoFile("strip.jpg", 62_000);
  const codec = fakeCodec({ width: 4000, height: 400 });
  const r = await U.prepareImage(file, codec);
  ok(r.file === file, "the same file:");
  eq([r.width, r.height, !!r.reduced], [4000, 400, false]);
  eq(codec.calls.encode.map((s) => s.quality), [0.82], "only the library preview was made:");
});

await t("LONG: a 4000x400 strip over the limit is written at its own size, and nothing needs saying", async () => {
  const r = await U.uploadImage(photoFile("strip-big.jpg", 2_000_000), { codec: fakeCodec({ width: 4000, height: 400 }), send: realSend() });
  ok(r.ok, `uploaded (${r.message}):`);
  const row = await stored(r.media.id);
  eq([row.width, row.height], [4000, 400]);
  ok(row.size <= LIMIT, "fits:");
  eq(r.notice, null);
});

await t("LONG: a 1170x6000 screenshot over the limit keeps its width through the real route, and nothing needs saying", async () => {
  const codec = fakeCodec({ width: 1170, height: 6000 });
  const r = await U.uploadImage(photoFile("longshot.png", 18_000_000, "image/png"), { codec, send: realSend() });
  ok(r.ok, `uploaded (${r.message}):`);
  const row = await stored(r.media.id);
  eq([row.mime, row.width, row.height, row.filename], ["image/jpeg", 1080, 5538, "longshot.jpg"]);
  ok(row.size <= LIMIT, "fits:");
  eq(r.notice, null);
  eq(codec.calls.alphaSize, [{ width: 1080, height: 5538 }], "transparency looked at, at the size it will be written:");
  const thumb = await thumbOf(r.media.id);
  eq([thumb.width, thumb.height], [480, 2461], "preview attached:");
});

await t("LONG: a 1170x6000 screenshot too detailed to keep its width is told the final size", async () => {
  const r = await U.uploadImage(photoFile("busylong.png", 18_000_000, "image/png"), { codec: fakeCodec({ width: 1170, height: 6000, detail: 10 }), send: realSend() });
  ok(r.ok, `uploaded (${r.message}):`);
  const row = await stored(r.media.id);
  eq([row.width, row.height], [900, 4615], "shrunk, and still far wider than the old 374:");
  eq(r.notice, P.uploadMessage.madeSmaller("busylong.png", row));
});

await t("LONG: a transparent 1170x6000 stays transparent, and PNG sizes fall with their own floor (Safari)", async () => {
  const codec = fakeCodec({ alpha: true, width: 1170, height: 6000, writesWebp: false, detail: 0.3 });
  const r = await U.prepareImage(photoFile("cutout-long.png", 18_000_000, "image/png"), codec);
  eq([r.file.type, r.width, r.height, r.reduced], ["image/png", 576, 2954, true]);
  ok(r.file.size <= LIMIT, "fits:");
  ok(!codec.calls.encode.some((s) => s.mime === "image/jpeg"), "no jpeg encode:");
});

await t("LONG: a very long file over the limit stops at the longest size a canvas can be trusted with, and says so", async () => {
  const r = await U.prepareImage(photoFile("huge-long.jpg", 3_000_000), fakeCodec({ width: 1000, height: 30000 }));
  eq([r.width, r.height, r.reduced], [273, 8192, true]);
});

await t("over 1920 and within the limit, with a short side at or under 1920: untouched, whatever the shape", async () => {
  for (const [width, height] of [[2400, 1200], [1200, 2400], [2560, 1920]]) {
    const file = photoFile("ordinary.jpg", 500_000);
    const r = await U.prepareImage(file, fakeCodec({ width, height }));
    ok(r.file === file, `${width}x${height} the same file:`);
    eq([r.width, r.height], [width, height]);
  }
});

await t("both sides over 1920, within the limit and no wider than 16:9: still made smaller", async () => {
  const photo = await U.prepareImage(photoFile("big.jpg", 900_000), fakeCodec({ width: 2600, height: 2200, detail: 0.1 }));
  eq([photo.file.type, photo.width, photo.height, photo.reduced], ["image/jpeg", 1920, 1625, false]);
  const wide = await U.prepareImage(photoFile("wide169.jpg", 900_000), fakeCodec({ width: 3840, height: 2160, detail: 0.1 }));
  eq([wide.file.type, wide.width, wide.height, wide.reduced], ["image/jpeg", 1920, 1080, false], "exactly 16:9:");
});

// The verifier's probe: these were re-encoded, cut to a 1080 short side and reported
// as a plain success. Sizes are the real JPEG fixtures it made in Chrome.
const LONG_WITHIN = [
  { name: "long-1921x5000.jpg", size: 1_109_354, width: 1921, height: 5000 },
  { name: "long-2000x6000.jpg", size: 1_321_451, width: 2000, height: 6000 },
  { name: "wide-7000x1921.jpg", size: 1_400_000, width: 7000, height: 1921 },
  { name: "wide-6000x2000.jpg", size: 900_000, width: 6000, height: 2000 },
];

await t("LONG: within the limit with a short side over 1920, a long image still goes up untouched", async () => {
  for (const { name, size, width, height } of LONG_WITHIN) {
    const file = photoFile(name, size);
    const codec = fakeCodec({ width, height });
    const prepared = await U.prepareImage(file, codec);
    ok(prepared.file === file, `${name} the same file:`);
    eq([prepared.width, prepared.height, !!prepared.reduced], [width, height, false], `${name}:`);
    eq(codec.calls.encode.map((s) => s.quality), [0.82], `${name} only the library preview was made:`);
    eq(codec.calls.hasAlpha, 0, `${name} never got as far as re-encoding:`);
  }
});

await t("LONG: the same files through the real route are stored byte for byte at their full size, with no notice", async () => {
  for (const { name, size, width, height } of LONG_WITHIN) {
    const file = photoFile(name, size);
    const body = new Uint8Array(await file.arrayBuffer());
    const r = await U.uploadImage(file, { codec: fakeCodec({ width, height }), send: realSend() });
    ok(r.ok, `${name} uploaded (${r.message}):`);
    const row = await stored(r.media.id);
    eq([row.mime, row.size, row.width, row.height, row.filename], ["image/jpeg", size, width, height, name], `${name}:`);
    eq((await inT(() => M.getMediaFile(r.media.id))).data.toString(), body.toString(), `${name} same bytes:`);
    eq(r.notice, null, `${name}:`);
    ok(await thumbOf(r.media.id), `${name} preview attached:`);
  }
});

await t("LONG: over the limit, a long image with a short side over 1920 has to be written smaller and keeps 1080", async () => {
  // the server won't take it as it is, so this is the one place its short side is cut
  const tall = await U.prepareImage(photoFile("long-big.jpg", 3_000_000), fakeCodec({ width: 1921, height: 5000 }));
  eq([tall.file.type, tall.width, tall.height, tall.reduced], ["image/jpeg", 1080, 2811, false]);
  const wide = await U.prepareImage(photoFile("wide-big.jpg", 3_000_000), fakeCodec({ width: 7000, height: 1921 }));
  eq([wide.width, wide.height, wide.reduced], [3935, 1080, false]);
});

await t("a busy photo walks down the quality steps but stays at 1920", async () => {
  const codec = fakeCodec({ detail: 8 });
  const r = await U.prepareImage(photoFile("busy.jpg", 9_000_000), codec);
  ok(r.ok);
  ok(codec.calls.encode.filter((s) => s.mime === "image/jpeg" && s.width === 1920).length > 1, "tried more than one quality:");
  eq(r.width, 1920);
  ok(r.file.size <= LIMIT, "fits:");
  eq(r.reduced, false);
});

await t("an extremely detailed photo shrinks below 1920 rather than fail, and says so", async () => {
  const r = await U.prepareImage(photoFile("noise.jpg", 20_000_000), fakeCodec({ detail: 30 }));
  ok(r.ok);
  ok(r.width < 1920, "shrunk:");
  ok(r.file.size <= LIMIT, "fits:");
  eq(r.reduced, true);
});

await t("an image that ends up smaller tells the founder the final size", async () => {
  const r = await U.uploadImage(photoFile("noise.jpg", 20_000_000), { codec: fakeCodec({ detail: 30 }), send: realSend() });
  ok(r.ok, `uploaded (${r.message}):`);
  const row = await stored(r.media.id);
  ok(row.width < 1920, "shrunk:");
  eq(r.notice, P.uploadMessage.madeSmaller("noise.jpg", row));
  includes(r.notice, `${row.width}×${row.height}`);
});

await t("over the limit but already small: not called smaller unless it really shrank", async () => {
  const same = await U.prepareImage(photoFile("small-dims.jpg", 2_000_000), fakeCodec({ width: 1000, height: 800 }));
  eq([same.width, same.height, same.reduced], [1000, 800, false], "kept its size:");
  const shrunk = await U.prepareImage(photoFile("logo.png", 2_000_000, "image/png"), fakeCodec({ width: 1000, height: 1000, alpha: true, writesWebp: false }));
  eq([shrunk.width, shrunk.reduced], [800, true], "fell below its own size:");
});

await t("an encode landing exactly on the limit is used, not retried", async () => {
  const codec = fakeCodec({ encodedSize: LIMIT });
  const r = await U.uploadImage(photoFile("edge.jpg", 5_000_000), { codec, send: realSend() });
  ok(r.ok, `uploaded (${r.message}):`);
  eq((await stored(r.media.id)).size, LIMIT);
  eq(codec.calls.encode.filter((s) => s.quality !== 0.82).length, 1, "first step accepted:");
});

await t("what goes up the wire: the file, its size, and a named preview with its size", async () => {
  let form;
  const r = await U.uploadImage(photoFile("a.jpg", 5_000_000), {
    codec: fakeCodec(),
    send: async (f) => {
      form = f;
      return { status: 200, json: { ok: true, media: {} } };
    },
  });
  ok(r.ok);
  eq([form.get("file").name, form.get("width"), form.get("height")], ["a.jpg", "1920", "1440"]);
  eq([form.get("thumb").name, form.get("thumbWidth"), form.get("thumbHeight")], ["thumb.webp", "480", "360"]);
});

await t("an image that can't fit gets a plain message and never reaches the server", async () => {
  const r = await U.uploadImage(photoFile("huge.png", 30_000_000, "image/png"), { codec: fakeCodec({ encodedSize: LIMIT + 1 }), send: neverSend });
  eq(r.ok, false);
  eq(r.message, P.uploadMessage.tooDetailed("huge.png"));
});

await t("transparent PNG, browser writes WebP: stays transparent, never touches JPEG", async () => {
  const codec = fakeCodec({ alpha: true, width: 3000, height: 3000 });
  const r = await U.uploadImage(photoFile("cutout.png", 4_000_000, "image/png"), { codec, send: realSend() });
  ok(r.ok, `uploaded (${r.message}):`);
  eq((await stored(r.media.id)).mime, "image/webp");
  eq(r.media.filename, "cutout.webp");
  ok(!codec.calls.encode.some((s) => s.mime === "image/jpeg"), "no jpeg encode:");
  eq(codec.calls.hasAlpha, 1);
  eq(codec.calls.alphaSize, [{ width: 1920, height: 1920 }], "checked at the size it will be written, to save phone memory:");
});

await t("transparent PNG, browser can't write WebP (Safari): falls to PNG, never JPEG", async () => {
  const codec = fakeCodec({ alpha: true, writesWebp: false, width: 1000, height: 600 });
  const r = await U.uploadImage(photoFile("logo.png", 2_000_000, "image/png"), { codec, send: realSend() });
  ok(r.ok, `uploaded (${r.message}):`);
  const row = await stored(r.media.id);
  eq(row.mime, "image/png");
  ok(row.size <= LIMIT, "fits:");
  ok(!codec.calls.encode.some((s) => s.mime === "image/jpeg"), "no jpeg encode:");
  eq(codec.calls.encode.filter((s) => s.mime === "image/webp" && s.quality !== 0.82).length, 1, "gave up on webp after one answer:");
});

await t("transparent PNG too detailed for PNG in Safari gets the plain message, not a black background", async () => {
  const codec = fakeCodec({ alpha: true, writesWebp: false, width: 4000, height: 4000, encodedSize: LIMIT + 1 });
  const r = await U.prepareImage(photoFile("big.png", 40_000_000, "image/png"), codec);
  eq(r.ok, false);
  eq(r.message, P.uploadMessage.tooDetailed("big.png"));
  ok(!codec.calls.encode.some((s) => s.mime === "image/jpeg"), "no jpeg encode:");
});

await t("opaque big PNG (a screenshot) becomes a JPEG; a JPEG is never checked for transparency", async () => {
  const codec = fakeCodec({ width: 2400, height: 1600 });
  const r = await U.prepareImage(photoFile("shot.png", 6_000_000, "image/png"), codec);
  eq([r.file.type, r.file.name], ["image/jpeg", "shot.jpg"]);
  eq(codec.calls.hasAlpha, 1);
  const jpegCodec = fakeCodec();
  await U.prepareImage(photoFile("a.jpg", 5_000_000), jpegCodec);
  eq(jpegCodec.calls.hasAlpha, 0);
});

await t("an already small image goes up byte for byte, never upscaled or re-encoded", async () => {
  const file = photoFile("small.jpg", 200_000);
  const codec = fakeCodec({ width: 1200, height: 800 });
  const r = await U.prepareImage(file, codec);
  ok(r.file === file, "the same file:");
  eq([r.width, r.height], [1200, 800]);
  eq(codec.calls.encode.map((s) => s.mime), ["image/webp"], "only the library preview was made:");
  eq([r.thumb.width, r.thumb.height], [480, 320]);
});

await t("a preview the browser could only write as PNG (Safari) is stored as what it is", async () => {
  const r = await U.uploadImage(photoFile("safari.jpg", 200_000), { codec: fakeCodec({ width: 1200, height: 800, writesWebp: false }), send: realSend() });
  ok(r.ok, `uploaded (${r.message}):`);
  const thumb = await thumbOf(r.media.id);
  eq([thumb.variant, thumb.mime, thumb.width], ["thumb", "image/png", 480]);
});

await t("a tiny image gets no preview, as before", async () => {
  const codec = fakeCodec({ width: 300, height: 300 });
  const r = await U.prepareImage(photoFile("tiny.png", 5_000, "image/png"), codec);
  eq(r.thumb, null);
  eq(codec.calls.encode, []);
});

await t("re-encoding that would grow the file keeps the original", async () => {
  const file = photoFile("flat.jpg", 300_000);
  const r = await U.prepareImage(file, fakeCodec({ width: 4000, height: 3000, encodedSize: 400_000 }));
  ok(r.file === file, "the same file:");
  eq([r.width, r.height], [4000, 3000], "its real dimensions:");
  ok(r.thumb, "and its preview, which needs the image still open:");
});

await t("an animated WebP or PNG within the limit goes up untouched, even when over 1920", async () => {
  for (const [name, type, bytes] of [["anim.webp", "image/webp", ANIMATED_WEBP], ["anim.png", "image/png", ANIMATED_PNG]]) {
    // 2400x2200 reaches the animation check; 2400x1200 and 2000x6000 are untouched before it gets there
    for (const [width, height] of [[2400, 2200], [2400, 1200], [2000, 6000]]) {
      const file = new File([padded(bytes, 16_300)], name, { type });
      const codec = fakeCodec({ width, height });
      const r = await U.uploadImage(file, { codec, send: realSend() });
      ok(r.ok, `uploaded (${r.message}):`);
      const row = await stored(r.media.id);
      eq([row.mime, row.filename, row.size, row.width, row.height], [type, name, 16_300, width, height], `${name} ${width}x${height}:`);
      eq(r.notice, null);
      eq(codec.calls.encode.map((s) => s.quality), [0.82], "only the library preview was made:");
      eq(codec.calls.hasAlpha, 0);
      ok(r.thumb, `${name} ${width}x${height} preview made while the image was still open:`);
    }
  }
});

await t("an animated WebP or PNG over the limit gets a plain message: no silent still image", async () => {
  for (const [name, type, bytes] of [["anim.webp", "image/webp", ANIMATED_WEBP], ["anim.png", "image/png", ANIMATED_PNG]]) {
    const codec = fakeCodec({ width: 1000, height: 1000 });
    const r = await U.uploadImage(new File([padded(bytes, LIMIT + 1)], name, { type }), { codec, send: neverSend });
    eq(r.message, P.uploadMessage.animatedTooBig(name));
    eq(codec.calls.encode, [], "nothing encoded:");
    eq(codec.calls.closed, 1, "decoded image released:");
  }
});

await t("a still WebP or PNG over 1920 is still made smaller", async () => {
  const webp = await U.prepareImage(photoFile("still.webp", 500_000, "image/webp"), fakeCodec({ width: 2400, height: 2200, detail: 0.1 }));
  eq([webp.file.type, webp.width], ["image/jpeg", 1920]);
  const png = new File([padded(pngOf(pngChunk("IHDR", new Array(13).fill(0)), pngChunk("IDAT", ascii("acTL"))), 500_000)], "still.png", { type: "image/png" });
  eq((await U.prepareImage(png, fakeCodec({ width: 2400, height: 2200, detail: 0.1 }))).width, 1920);
  // a still lossy WebP whose picture data has the animation bit set where a VP8X flag would be
  const lossy = new File([padded(webpOf("VP8 ", [ANIM_FLAG, 0, 0, 0]), 500_000)], "lossy.webp", { type: "image/webp" });
  eq((await U.prepareImage(lossy, fakeCodec({ width: 2400, height: 2200, detail: 0.1 }))).width, 1920, "not mistaken for animated:");
});

await t("SVG and GIF are left exactly as they are, with nothing encoded", async () => {
  const gif = photoFile("a.gif", 400_000, "image/gif");
  const gifCodec = fakeCodec({ width: 2500, height: 2500 });
  const r1 = await U.prepareImage(gif, gifCodec);
  ok(r1.file === gif, "same gif:");
  eq(gifCodec.calls.encode, []);
  eq(r1.thumb, null);
  eq(r1.width, 2500, "dimensions still recorded:");
  const svg = new File(["<svg></svg>"], "a.svg", { type: "image/svg+xml" });
  const svgCodec = fakeCodec({ undecodable: true });
  const r2 = await U.prepareImage(svg, svgCodec);
  ok(r2.file === svg, "same svg:");
  eq(svgCodec.calls.encode, []);
  eq([r2.width, r2.height], [null, null]);
});

await t("a GIF over the limit: the server rule decides, the founder reads plain words", async () => {
  const r = await U.uploadImage(photoFile("party.gif", LIMIT + 1, "image/gif"), { codec: fakeCodec({ width: 800, height: 600 }), send: realSend() });
  eq(r.ok, false);
  eq(r.message, P.uploadMessage.tooBig("party.gif"));
});

await t("HEIC this browser can't open: plain message, nothing sent", async () => {
  for (const type of ["image/heic", ""]) {
    const r = await U.uploadImage(new File([new Uint8Array(4_000_000)], "IMG_7.HEIC", { type }), { codec: fakeCodec({ undecodable: true }), send: neverSend });
    eq(r.ok, false);
    eq(r.message, P.uploadMessage.heic("IMG_7.HEIC"), `type "${type}":`);
  }
});

await t("HEIC this browser can open (Safari): becomes a JPEG, even when small", async () => {
  const r = await U.uploadImage(new File([new Uint8Array(900_000)], "IMG_8.heic", { type: "image/heic" }), { codec: fakeCodec(), send: realSend() });
  ok(r.ok, `uploaded (${r.message}):`);
  const row = await stored(r.media.id);
  eq([row.mime, row.filename, row.width], ["image/jpeg", "IMG_8.jpg", 1920]);
  const thumb = await thumbOf(r.media.id);
  eq([thumb.variant, thumb.width, thumb.height], ["thumb", 480, 360], "gets a preview like any photo:");
});

await t("NEGATIVE: a file that isn't an image is refused in plain words before anything runs", async () => {
  const codec = fakeCodec();
  const r = await U.uploadImage(new File(["%PDF-1.7"], "invoice.pdf", { type: "application/pdf" }), { codec, send: neverSend });
  eq(r.ok, false);
  eq(r.message, P.uploadMessage.notImage("invoice.pdf"));
  eq(codec.calls.decode, 0);
});

await t("a damaged photo too big to send: plain message", async () => {
  const r = await U.uploadImage(photoFile("broken.jpg", 3_000_000), { codec: fakeCodec({ undecodable: true }), send: neverSend });
  eq(r.message, P.uploadMessage.unreadable("broken.jpg"));
});

await t("a damaged photo small enough to send: plain message, nothing stored", async () => {
  for (const [name, type] of [["broken.jpg", "image/jpeg"], ["broken.png", "image/png"], ["broken.webp", "image/webp"]]) {
    const r = await U.uploadImage(photoFile(name, 40_000, type), { codec: fakeCodec({ undecodable: true }), send: neverSend });
    eq(r.ok, false);
    eq(r.message, P.uploadMessage.unreadable(name));
  }
});

await t("a browser with no way to try opening images: the server still decides, in plain words", async () => {
  const fake = await U.uploadImage(new File(["%PDF-1.7 pretending"], "photo.jpg", { type: "image/jpeg" }), { codec: fakeCodec({ cannotTry: true }), send: realSend() });
  eq(fake.message, P.uploadMessage.notWhatItSays("photo.jpg"));
  const real = await U.uploadImage(photoFile("old-browser.jpg", 40_000), { codec: fakeCodec({ cannotTry: true }), send: realSend() });
  ok(real.ok, `uploaded (${real.message}):`);
  const row = await stored(real.media.id);
  eq([row.mime, row.width, row.height], ["image/jpeg", 0, 0], "no dimensions known:");
  const big = await U.uploadImage(photoFile("big.jpg", LIMIT + 1), { codec: fakeCodec({ cannotTry: true }), send: neverSend });
  eq(big.message, P.uploadMessage.unreadable("big.jpg"), "can't be made smaller, so not sent:");
});

await t("a real image with the wrong name, small in bytes and size: the server's magic-byte check refuses it, in plain words", async () => {
  const before = await mediaCount();
  const r = await U.uploadImage(new File([bytesOf("image/png", 2048)], "photo.jpg", { type: "image/jpeg" }), { codec: fakeCodec({ width: 800, height: 600 }), send: realSend() });
  eq(r.message, P.uploadMessage.notWhatItSays("photo.jpg"));
  eq(await mediaCount(), before);
  // a long one within the limit is never re-encoded either, so it gets the same answer
  const codec = fakeCodec({ width: 2000, height: 6000 });
  const long = await U.uploadImage(new File([bytesOf("image/png", 900_000)], "long.jpg", { type: "image/jpeg" }), { codec, send: realSend() });
  eq(long.message, P.uploadMessage.notWhatItSays("long.jpg"), "long, within the limit:");
  eq(codec.calls.hasAlpha, 0, "never re-encoded:");
  eq(await mediaCount(), before);
});

// The two ways a wrongly named file ends up re-encoded: over the bytes, and over 1920.
const OVERSIZED = [
  { label: "over the limit", size: 4_000_000, width: 2600, height: 2600 },
  { label: "over the limit, small in pixels", size: 4_000_000, width: 1000, height: 800 },
  { label: "within the limit, over 1920", size: 900_000, width: 2600, height: 2600 },
];

await t("wrong name, see-through picture: the bytes decide, so it stays see-through and never touches JPEG", async () => {
  for (const { label, size, width, height } of OVERSIZED) {
    for (const [from, type, name] of [["image/png", "image/jpeg", "cutout.jpg"], ["image/webp", "image/jpeg", "cutout.jpeg"], ["image/png", "", "cutout.jpg"]]) {
      const codec = fakeCodec({ alpha: true, width, height, detail: 0.2 });
      const r = await U.uploadImage(new File([bytesOf(from, size)], name, { type }), { codec, send: realSend() });
      ok(r.ok, `${label} ${from} (${r.message}):`);
      eq(codec.calls.hasAlpha, 1, `${label} ${from} looked at:`);
      eq((await stored(r.media.id)).mime, "image/webp", `${label} ${from}:`);
      ok(!codec.calls.encode.some((s) => s.mime === "image/jpeg"), `${label} ${from} no jpeg encode:`);
    }
    const safari = fakeCodec({ alpha: true, width, height, detail: 0.05, writesWebp: false });
    const r = await U.uploadImage(new File([bytesOf("image/png", size)], "cutout.jpg", { type: "image/jpeg" }), { codec: safari, send: realSend() });
    ok(r.ok, `${label} Safari (${r.message}):`);
    eq((await stored(r.media.id)).mime, "image/png", `${label} Safari:`);
    ok(!safari.calls.encode.some((s) => s.mime === "image/jpeg"), `${label} Safari no jpeg encode:`);
  }
});

await t("wrong name, solid picture: still uploads as a JPEG, as it did before", async () => {
  for (const { label, size, width, height } of OVERSIZED) {
    const codec = fakeCodec({ width, height, detail: 0.2 });
    const r = await U.uploadImage(new File([bytesOf("image/png", size)], "shot.jpg", { type: "image/jpeg" }), { codec, send: realSend() });
    ok(r.ok, `${label} (${r.message}):`);
    eq(codec.calls.hasAlpha, 1, `${label} looked at:`);
    eq((await stored(r.media.id)).mime, "image/jpeg", `${label}:`);
  }
});

await t("wrong name, moving picture or GIF: refused in plain words whatever its size, never made still", async () => {
  const movers = [
    ["animated PNG called .jpg", (size) => padded(ANIMATED_PNG, size), "anim.jpg", "image/jpeg"],
    ["animated WebP called .jpg", (size) => padded(ANIMATED_WEBP, size), "anim.jpg", "image/jpeg"],
    ["animated WebP called .png", (size) => padded(ANIMATED_WEBP, size), "anim.png", "image/png"],
    ["animated PNG called .webp", (size) => padded(ANIMATED_PNG, size), "anim.webp", "image/webp"],
    ["GIF called .jpg", (size) => bytesOf("image/gif", size), "party.jpg", "image/jpeg"],
    ["GIF called .png", (size) => bytesOf("image/gif", size), "party.png", "image/png"],
    ["GIF with no type but a .jpg name", (size) => bytesOf("image/gif", size), "party.jpg", ""],
    ["animated PNG called .avif", (size) => padded(ANIMATED_PNG, size), "anim.avif", "image/avif"],
    ["GIF called .heic", (size) => bytesOf("image/gif", size), "party.heic", "image/heic"],
  ];
  for (const { label, size, width, height } of OVERSIZED) {
    for (const [what, bytes, name, type] of movers) {
      const codec = fakeCodec({ width, height });
      const r = await U.uploadImage(new File([bytes(size)], name, { type }), { codec, send: neverSend });
      eq(r.message, P.uploadMessage.notWhatItSays(name), `${what}, ${label}:`);
      eq(codec.calls.encode, [], `${what}, ${label} nothing encoded:`);
      eq(codec.calls.closed, 1, `${what}, ${label} decoded image released:`);
    }
  }
});

await t("wrong name, JPEG bytes: no transparency check, because JPEG can't be transparent", async () => {
  const codec = fakeCodec({ alpha: true, width: 2600, height: 2600 });
  const r = await U.prepareImage(new File([bytesOf("image/jpeg", 4_000_000)], "photo.png", { type: "image/png" }), codec);
  eq(codec.calls.hasAlpha, 0);
  eq(r.file.type, "image/jpeg");
});

await t("bytes we don't recognise under a photo's name get the transparency check too", async () => {
  const codec = fakeCodec({ alpha: true, width: 2600, height: 2600, detail: 0.2 });
  const r = await U.prepareImage(new File([new Uint8Array(4_000_000)], "really-avif.jpg", { type: "image/jpeg" }), codec);
  eq(codec.calls.hasAlpha, 1);
  eq(r.file.type, "image/webp");
});

await t("older type names: a small real JPEG or PNG goes up with its bytes unchanged", async () => {
  for (const [type, from, name] of [["image/jpg", "image/jpeg", "a1.jpg"], ["image/pjpeg", "image/jpeg", "a2.jpg"], ["image/x-png", "image/png", "a3.png"]]) {
    const body = bytesOf(from, 300_000);
    const codec = fakeCodec({ width: 800, height: 600 });
    const r = await U.uploadImage(new File([body], name, { type }), { codec, send: realSend() });
    ok(r.ok, `${type} (${r.message}):`);
    const row = await stored(r.media.id);
    eq([row.mime, row.size, row.filename], [from, 300_000, name], `${type}:`);
    eq((await inT(() => M.getMediaFile(r.media.id))).data.toString(), body.toString(), `${type} same bytes:`);
    eq(codec.calls.hasAlpha, 0, `${type} never re-encoded:`);
    eq(codec.calls.encode.map((s) => s.quality), [0.82], `${type} only the preview:`);
  }
});

await t("an animated PNG the browser calls image/apng, or with no type and a .apng name, keeps moving", async () => {
  for (const type of ["image/apng", ""]) {
    const codec = fakeCodec({ width: 2400, height: 1200 });
    const r = await U.uploadImage(new File([padded(ANIMATED_PNG, 16_300)], "anim.apng", { type }), { codec, send: realSend() });
    ok(r.ok, `type "${type}" (${r.message}):`);
    const row = await stored(r.media.id);
    eq([row.mime, row.filename, row.size, row.width], ["image/png", "anim.apng", 16_300, 2400], `type "${type}":`);
    eq(codec.calls.encode.map((s) => s.quality), [0.82], `type "${type}" only the preview:`);
    const big = await U.uploadImage(new File([padded(ANIMATED_PNG, LIMIT + 1)], "anim.apng", { type }), { codec: fakeCodec(), send: neverSend });
    eq(big.message, P.uploadMessage.animatedTooBig("anim.apng"), `type "${type}" too big:`);
  }
});

await t("an empty browser type: the inferred type travels with the file so the server accepts it", async () => {
  for (const name of ["IMG_3.JPG", "IMG_4.jpeg", "IMG_5.JFIF"]) {
    const r = await U.uploadImage(new File([bytesOf("image/jpeg", 2048)], name, { type: "" }), { codec: fakeCodec({ width: 800, height: 600 }), send: realSend() });
    ok(r.ok, `${name} (${r.message}):`);
    eq((await stored(r.media.id)).mime, "image/jpeg", `${name}:`);
  }
});

await t("no type and no useful name: a real image is told by its bytes and uploads", async () => {
  for (const [mime, name] of [["image/jpeg", "camera_upload"], ["image/png", "export"], ["image/webp", "picture.dat"], ["image/gif", "party"]]) {
    const r = await U.uploadImage(new File([bytesOf(mime, 2048)], name, { type: "" }), { codec: fakeCodec({ width: 800, height: 600 }), send: realSend() });
    ok(r.ok, `${name} (${r.message}):`);
    eq((await stored(r.media.id)).mime, mime, `${name}:`);
  }
});

await t("no type and no useful name: a damaged photo isn't called 'not an image' just for its name", async () => {
  const r = await U.uploadImage(new File([bytesOf("image/jpeg", 2048)], "camera_upload", { type: "" }), { codec: fakeCodec({ undecodable: true }), send: neverSend });
  eq(r.message, P.uploadMessage.unreadable("camera_upload"));
});

await t("no type and bytes we don't know: if it opens it becomes a JPEG (WebP if see-through); if not, it isn't an image", async () => {
  const opens = await U.uploadImage(new File([new Uint8Array(4096)], "camera_upload", { type: "" }), { codec: fakeCodec({ width: 800, height: 600 }), send: realSend() });
  ok(opens.ok, `uploaded (${opens.message}):`);
  eq([opens.media.filename, opens.media.mime], ["camera_upload.jpg", "image/jpeg"]);
  const seeThrough = await U.prepareImage(new File([new Uint8Array(4096)], "camera_upload", { type: "" }), fakeCodec({ width: 800, height: 600, alpha: true }));
  eq(seeThrough.file.type, "image/webp", "a see-through one is never a JPEG:");
  for (const name of ["notes.txt", "noextension", "invoice.pdf"]) {
    const r = await U.uploadImage(new File(["some words"], name, { type: "" }), { codec: fakeCodec({ undecodable: true }), send: neverSend });
    eq(r.message, P.uploadMessage.notImage(name), `${name}:`);
  }
  const noDecoder = await U.uploadImage(new File(["some words"], "noextension", { type: "" }), { codec: fakeCodec({ cannotTry: true }), send: neverSend });
  eq(noDecoder.message, P.uploadMessage.notImage("noextension"), "no way to try:");
});

await t("an AVIF with no browser type follows the same path as one with a type", async () => {
  const can = await U.prepareImage(new File([new Uint8Array(4096)], "a.avif", { type: "" }), fakeCodec({ width: 800, height: 600 }));
  eq([can.file.type, can.file.name], ["image/jpeg", "a.jpg"]);
  const cannot = await U.prepareImage(new File([new Uint8Array(4096)], "a.avif", { type: "" }), fakeCodec({ undecodable: true }));
  eq(cannot.message, P.uploadMessage.unreadable("a.avif"));
});

await t("an empty file says it's empty, not damaged, and nothing runs", async () => {
  for (const [name, type] of [["empty.jpg", "image/jpeg"], ["empty.png", "image/png"], ["empty.webp", "image/webp"], ["empty.gif", "image/gif"], ["empty.svg", "image/svg+xml"], ["empty.heic", "image/heic"], ["empty.jpg", ""], ["empty", ""]]) {
    const codec = fakeCodec({ undecodable: true });
    const r = await U.uploadImage(new File([], name, { type }), { codec, send: neverSend });
    eq(r.message, P.uploadMessage.empty(name), `${name} "${type}":`);
    eq(codec.calls.decode, 0, `${name} "${type}" not opened:`);
  }
  const pdf = await U.uploadImage(new File([], "empty.pdf", { type: "application/pdf" }), { codec: fakeCodec(), send: neverSend });
  eq(pdf.message, P.uploadMessage.notImage("empty.pdf"), "still not an image:");
});

await t("a canvas that fails or runs out of memory: smaller sizes are tried, then plain words", async () => {
  const r1 = await U.prepareImage(photoFile("a.jpg", 5_000_000), fakeCodec({ throwAbove: 1600 }));
  ok(r1.ok, "a smaller step worked:");
  eq(r1.width, 1600);
  eq(r1.reduced, true);
  const r2 = await U.prepareImage(photoFile("b.jpg", 5_000_000), fakeCodec({ nullBlobs: true }));
  eq(r2.message, P.uploadMessage.unreadable("b.jpg"));
});

await t("a preview that fails never costs the founder the photo", async () => {
  const codec = fakeCodec({ width: 1200, height: 800 });
  codec.encode = async () => {
    throw new Error("no memory");
  };
  const r = await U.prepareImage(photoFile("small.jpg", 100_000), codec);
  ok(r.ok);
  eq(r.thumb, null);
});

await t("the decoded image is always released", async () => {
  for (const opts of [{}, { width: 300, height: 300 }, { encodedSize: LIMIT + 1 }]) {
    const codec = fakeCodec(opts);
    await U.prepareImage(photoFile("a.jpg", 5_000_000), codec);
    eq(codec.calls.closed, 1, JSON.stringify(opts));
  }
});

await t("no connection, or a thrown send: plain words, never a raw error", async () => {
  const offline = await U.uploadImage(photoFile("a.jpg", 2048), { codec: fakeCodec({ width: 800, height: 600 }), send: async () => ({ status: 0, json: {} }) });
  eq(offline.message, P.uploadMessage.connection());
  const thrown = await U.uploadImage(photoFile("a.jpg", 2048), { codec: fakeCodec({ width: 800, height: 600 }), send: neverSend });
  eq(thrown.message, P.uploadMessage.failed("a.jpg"));
});

await t("a 200 that isn't an ok from our route counts as a failure", async () => {
  const r = await U.uploadImage(photoFile("a.jpg", 2048), { codec: fakeCodec({ width: 800, height: 600 }), send: async () => ({ status: 200, json: { ok: false } }) });
  eq(r.ok, false);
  eq(r.message, P.uploadMessage.failed("a.jpg"));
  const page = await U.uploadImage(photoFile("a.jpg", 2048), { codec: fakeCodec({ width: 800, height: 600 }), send: async () => ({ status: 200, json: {} }) });
  eq(page.message, P.uploadMessage.failed("a.jpg"), "a login page answering 200:");
});

// ---- plain words --------------------------------------------------------------
console.log("— plain words");

await t("every real server refusal maps to plain words", () => {
  const says = (mime, bytes) => P.plainServerMessage({ status: 422, json: { errors: M.validateUpload({ filename: "a", mime, bytes }).errors }, name: "a" });
  eq(says("application/pdf", bytesOf("image/png", 64)), P.uploadMessage.notImage("a"));
  eq(says("image/png", new Uint8Array(0)), P.uploadMessage.empty("a"));
  eq(says("image/jpeg", bytesOf("image/png", 64)), P.uploadMessage.notWhatItSays("a"));
  eq(says("image/gif", bytesOf("image/gif", LIMIT + 1)), P.uploadMessage.tooBig("a"));
});

await t("status codes map to plain words, and unknown errors don't leak", () => {
  eq(P.plainServerMessage({ status: 0, json: {}, name: "a" }), P.uploadMessage.connection());
  eq(P.plainServerMessage({ status: 401, json: { error: "x" }, name: "a" }), P.uploadMessage.noPermission());
  eq(P.plainServerMessage({ status: 403, json: { error: "Cross-origin request rejected" }, name: "a" }), P.uploadMessage.noPermission());
  eq(P.plainServerMessage({ status: 413, json: {}, name: "a" }), P.uploadMessage.tooBig("a"));
  eq(P.plainServerMessage({ status: 422, json: { error: "SQLITE_BUSY: database is locked" }, name: "a" }), P.uploadMessage.failed("a"));
  eq(P.plainServerMessage({ status: 500, json: undefined, name: "a" }), P.uploadMessage.failed("a"));
});

await t("no message uses technical words", () => {
  for (const fn of Object.values(P.uploadMessage)) {
    const m = fn("x.jpg", { width: 800, height: 533 });
    for (const bad of ["mime", "MIME", "canvas", "decode", "422", "magic", "sanitiz", "undefined", "Error"]) ok(!m.includes(bad), `"${m}" has ${bad}:`);
  }
});

await t("the HEIC advice works on any device", () => {
  const m = P.uploadMessage.heic("IMG_1.HEIC");
  includes(m, "JPEG");
  for (const bad of ["iPhone", "Safari"]) ok(!m.includes(bad), `"${m}" has ${bad}:`);
});

await t("the stated GIF and SVG limits match the server", () => {
  includes(P.uploadMessage.animatedTooBig("x"), `${M.MEDIA_MIME["image/webp"].max / 1e6}MB`);
  includes(P.uploadMessage.tooBig("x"), `${M.MEDIA_MIME["image/gif"].max / 1e6}MB`);
  includes(P.uploadMessage.tooBig("x"), `${M.MEDIA_MIME["image/svg+xml"].max / 1e3}KB`);
});

// ---- browser parts, as far as node can reach ----------------------------------
console.log("— browser parts (wiring only; real pixels are the browser drill)");

await t("browserCodec asks for upright photos, and asks the canvas for what the plan said", async () => {
  const seen = {};
  const fakeCanvas = (getContext) => ({
    getContext,
    toBlob: (cb, mime, quality) => {
      Object.assign(seen, { mime, quality });
      cb(new Blob(["x"], { type: mime }));
    },
  });
  const ctx = { drawImage: (_b, x, y, w, h) => Object.assign(seen, { draw: [x, y, w, h] }), getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }) };
  globalThis.document = { createElement: () => fakeCanvas(() => ctx) };
  globalThis.createImageBitmap = async (_file, options) => {
    seen.options = options;
    return { width: 1, height: 1 };
  };
  try {
    await U.browserCodec.decode(new Blob(["x"]));
    eq(seen.options.imageOrientation, "from-image");
    await U.browserCodec.encode({}, { mime: "image/jpeg", quality: 0.85, width: 1920, height: 1440 });
    eq([seen.mime, seen.quality, seen.draw], ["image/jpeg", 0.85, [0, 0, 1920, 1440]]);
    eq(ctx.imageSmoothingQuality, "high");
    eq(U.browserCodec.hasAlpha({}, { width: 1, height: 1 }), false, "opaque pixels:");
    const calls = [];
    globalThis.createImageBitmap = async (_file, options) => {
      calls.push(options);
      if (options) throw new TypeError("'from-image' is not a valid enum value");
      return { width: 2, height: 2 };
    };
    eq((await U.browserCodec.decode(new Blob(["x"]))).width, 2, "a browser that rejects the option still decodes:");
    eq(calls.length, 2);
    eq(calls[1], undefined, "second try has no option:");
    calls.length = 0;
    globalThis.createImageBitmap = async (_file, options) => {
      calls.push(options);
      throw Object.assign(new Error("The source image could not be decoded."), { name: "InvalidStateError" });
    };
    let threw = null;
    await U.browserCodec.decode(new Blob(["x"])).catch((e) => (threw = e.name));
    eq([threw, calls.length], ["InvalidStateError", 1], "damage is not retried:");
    delete globalThis.createImageBitmap;
    eq(await U.browserCodec.decode(new Blob(["x"])), null, "no way to try:");
    ctx.getImageData = () => {
      throw new Error("SecurityError");
    };
    eq(U.browserCodec.hasAlpha({}, { width: 1, height: 1 }), true, "a check that can't run counts as transparent:");
  } finally {
    delete globalThis.document;
    delete globalThis.createImageBitmap;
  }
});

await t("xhrSend posts to the route, reports percent, and survives bad answers", async () => {
  let made;
  globalThis.XMLHttpRequest = class {
    upload = {};
    open(method, url) {
      Object.assign(this, { method, url });
      made = this;
    }
    send() {}
  };
  try {
    const percents = [];
    let p = U.xhrSend(new FormData(), (n) => percents.push(n));
    eq([made.method, made.url], ["POST", "/api/admin/media"]);
    made.upload.onprogress({ lengthComputable: true, loaded: 1, total: 4 });
    made.upload.onprogress({ lengthComputable: true, loaded: 1, total: 3 });
    made.upload.onprogress({ lengthComputable: false });
    Object.assign(made, { status: 200, responseText: '{"ok":true}' });
    made.onload();
    eq(await p, { status: 200, json: { ok: true } });
    eq(percents, [25, 33], "whole numbers:");
    p = U.xhrSend(new FormData(), () => {});
    Object.assign(made, { status: 413, responseText: "<html>Request Entity Too Large</html>" });
    made.onload();
    eq(await p, { status: 413, json: {} }, "a platform error page:");
    p = U.xhrSend(new FormData(), () => {});
    made.onerror();
    eq(await p, { status: 0, json: {} }, "no answer:");
    for (const event of ["onabort", "ontimeout"]) {
      p = U.xhrSend(new FormData(), () => {});
      made[event]();
      eq(await p, { status: 0, json: {} }, `${event}:`);
    }
  } finally {
    delete globalThis.XMLHttpRequest;
  }
});

// ---- one upload path ----------------------------------------------------------
console.log("— one upload path");

const source = (rel) => readFile(join(root, rel), "utf8");
// Source with its comments gone, so a commented-out line can't pass a scan.
const code = async (rel) =>
  (await source(rel))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

await t("MediaAdmin and MediaPicker both upload through uploadImage and hold no copy of their own", async () => {
  for (const rel of ["components/admin/MediaAdmin.js", "components/admin/shared/MediaPicker.js"]) {
    const s = await code(rel);
    includes(s, 'import { uploadImage } from "@/lib/media-upload"', `${rel}:`);
    includes(s, "uploadImage(file, { onProgress: setUploading })", `${rel}:`);
    includes(s, "accept={UPLOAD_ACCEPT}", `${rel}:`);
    ok(/^\s*<MediaUploadStatus progress=\{uploading\} \/>$/m.test(s), `${rel} shows the progress banner on a line of its own, with no condition around it:`);
    for (const bad of ["createImageBitmap", "FormData", 'method: "POST"', "toBlob", "image/png,image/jpeg"]) ok(!s.includes(bad), `${rel} still has ${bad}:`);
  }
});

// Components are JSX, which plain node can't import, but these handlers are plain
// JS. So take their real source text and run it with stand-ins for the React parts.
async function sliceOf(rel, from, to) {
  const s = await code(rel);
  const start = s.indexOf(from);
  const end = s.indexOf(to, start);
  ok(start >= 0 && end > start, `${rel} no longer has ${from}:`);
  return s.slice(start, end);
}
const offlineFetch = async () => {
  throw new TypeError("Failed to fetch");
};
const FAILED_UPLOAD = { ok: false, message: "The upload didn't go through. Check your connection and try again." };

async function libraryUpload({ result, fetch = async () => ({ json: async () => ({ ok: true, media: ["fresh"] }) }) }) {
  const state = { uploading: "in flight", error: null, media: null, toasts: [], input: { value: "C:\\fakepath\\IMG_0042.jpg" } };
  const body = await sliceOf("components/admin/MediaAdmin.js", "async function refresh()", "async function saveAlt");
  const make = new Function("fetch", "uploadImage", "setUploading", "setError", "setMedia", "toast", "fileRef", `${body}\nreturn upload;`);
  const upload = make(
    (...args) => {
      state.inputAtRefresh = state.input.value;
      return fetch(...args);
    },
    async () => result,
    (v) => (state.uploading = v),
    (v) => (state.error = v),
    (v) => (state.media = v),
    { success: (m) => state.toasts.push(m) },
    { current: state.input }
  );
  await upload([{ name: "IMG_0042.jpg" }]);
  return state;
}

async function pickerUpload({ result, closeDuringUpload = false, closeDuringLoad = false }) {
  const state = { uploading: "in flight", error: "old error", selected: [], loads: 0, toasts: [], errorToasts: [], input: { value: "C:\\fakepath\\IMG_0042.jpg" } };
  const body = await sliceOf("components/admin/shared/MediaPicker.js", "async function upload(file)", "const filtered = useMemo");
  const make = new Function("uploadImage", "uploadMessage", "session", "setUploading", "setUploadErr", "load", "onSelect", "toast", "fileRef", `${body}\nreturn upload;`);
  const session = { current: 1 };
  const upload = make(
    async () => {
      if (closeDuringUpload) session.current++;
      return result;
    },
    P.uploadMessage,
    session,
    (v) => (state.uploading = v),
    (v) => (state.error = v),
    async () => {
      state.loads++;
      if (closeDuringLoad) session.current++;
    },
    (v) => state.selected.push(v),
    { info: (m) => state.toasts.push(m), error: (m) => state.errorToasts.push(m) },
    { current: state.input }
  );
  await upload({ name: "IMG_0042.jpg" });
  return state;
}

await t("library, connection down: the message shows, the same photo can be picked again, nothing rejects", async () => {
  const s = await libraryUpload({ result: FAILED_UPLOAD, fetch: offlineFetch });
  eq(s.error, FAILED_UPLOAD.message);
  eq(s.input.value, "", "input reset so the retry fires:");
  eq(s.inputAtRefresh, "", "reset before the refresh, which may never answer:");
  eq(s.uploading, null);
});

await t("library, uploaded: list refreshed, input reset, the right words shown", async () => {
  const plain = await libraryUpload({ result: { ok: true, media: {}, notice: null } });
  eq([plain.toasts, plain.media, plain.input.value, plain.uploading], [["IMG_0042.jpg uploaded"], ["fresh"], "", null]);
  const smaller = await libraryUpload({ result: { ok: true, media: {}, notice: "made smaller" } });
  eq(smaller.toasts, ["made smaller"]);
  const reused = await libraryUpload({ result: { ok: true, media: { deduped: true }, notice: null } });
  includes(reused.toasts[0], "already in the library");
});

await t("picker, failed: the message shows, the same photo can be picked again, nothing is picked", async () => {
  const s = await pickerUpload({ result: FAILED_UPLOAD });
  eq([s.error, s.input.value, s.uploading, s.selected, s.toasts], [FAILED_UPLOAD.message, "", null, [], []]);
});

await t("picker, uploaded: the new image is picked, and a shrunk one says so", async () => {
  const media = { url: "/api/media/med_1", alt: "Hero", id: "med_1" };
  const plain = await pickerUpload({ result: { ok: true, media, notice: null } });
  eq([plain.selected, plain.loads, plain.input.value, plain.uploading, plain.error, plain.toasts], [[media], 1, "", null, null, []]);
  const smaller = await pickerUpload({ result: { ok: true, media, notice: "made smaller" } });
  eq(smaller.toasts, ["made smaller"]);
  eq(smaller.selected, [media]);
});

await t("picker closed during an upload: nothing is placed, the library is updated, and the founder is told", async () => {
  const media = { url: "/api/media/med_1", alt: "Hero", id: "med_1" };
  const placedWords = [P.uploadMessage.notPlaced("IMG_0042.jpg")];
  for (const when of ["closeDuringUpload", "closeDuringLoad"]) {
    const s = await pickerUpload({ result: { ok: true, media, notice: null }, [when]: true });
    eq([s.selected, s.loads, s.toasts, s.uploading], [[], 1, placedWords, null], `${when}:`);
  }
  const smaller = await pickerUpload({ result: { ok: true, media, notice: "made smaller" }, closeDuringUpload: true });
  eq(smaller.toasts, ["made smaller", ...placedWords], "still told it shrank:");
});

await t("picker closed during an upload that fails: a toast says so, not a banner in a closed dialog", async () => {
  const s = await pickerUpload({ result: FAILED_UPLOAD, closeDuringUpload: true });
  eq([s.errorToasts, s.error, s.selected, s.uploading], [[FAILED_UPLOAD.message], null, [], null]);
});

await t("picker: every open and every close counts, so reopening for another spot doesn't catch an old upload", async () => {
  const body = await sliceOf("components/admin/shared/MediaPicker.js", "useEffect(() => {\n    session.current++", "async function upload(file)");
  includes(body, "}, [open]);");
  const session = { current: 0 };
  const opened = [];
  const run = new Function("useEffect", "session", "open", "setQ", "setItems", "load", body);
  const effect = (open) => run((fn) => fn(), session, open, () => opened.push("q"), () => opened.push("items"), () => opened.push("load"));
  effect(true);
  const started = session.current;
  effect(false);
  ok(session.current !== started, "closing moved it:");
  const closed = session.current;
  effect(true);
  ok(session.current !== closed && session.current !== started, "reopening moved it again:");
  eq(opened.length, 6, "each open still resets and loads:");
});

await t("the progress banner draws nothing while idle, and something while uploading", async () => {
  const body = await sliceOf("components/admin/MediaUploadStatus.js", "if (!progress)", "return (\n");
  const status = new Function("progress", `${body}\nreturn "banner";`);
  eq(status(null), null, "idle:");
  eq(status({ name: "a.jpg", stage: "preparing" }), "banner", "uploading:");
});

await t("picker grid shows the preview when there is one", async () => {
  const body = await sliceOf("components/admin/shared/MediaPicker.js", "const thumbOf =", "return (\n    <Dialog");
  const thumbOf = new Function(`${body}\nreturn thumbOf;`)();
  eq(thumbOf({ url: "/api/media/med_1", variants: [{ variant: "thumb", id: "med_2" }] }), "/api/media/med_2");
  eq(thumbOf({ url: "/api/media/med_1", variants: [] }), "/api/media/med_1");
});

await t("the JSX shows what the handlers set", async () => {
  const admin = await code("components/admin/MediaAdmin.js");
  includes(admin, '{error && <Banner tone="danger">{error}</Banner>}');
  includes(admin, "onChange={(e) => e.target.files?.length && upload([...e.target.files])}");
  includes(admin, "disabled={!!uploading}", "library input waits for the upload:");
  const picker = await code("components/admin/shared/MediaPicker.js");
  includes(picker, '{uploadErr && <Banner tone="danger">{uploadErr}</Banner>}');
  includes(picker, "onChange={(e) => upload(e.target.files?.[0])}");
  includes(picker, "busy={!!uploading}", "picker button waits for the upload:");
  const input = await sliceOf("components/admin/shared/MediaPicker.js", "<input\n", "/>");
  ok(!input.includes("disabled"), "the picker's hidden input stays usable, the button opens it:");
  const banner = await code("components/admin/MediaUploadStatus.js");
  includes(banner, "{progressLabel(progress)}");
  includes(banner, 'role="status"', "screen readers hear the progress:");
  includes(banner, 'aria-live="polite"', "screen readers hear the progress:");
});

await t("the library's hint leads with what happens to a photo, in plain words, not with limits", async () => {
  const admin = await code("components/admin/MediaAdmin.js");
  includes(admin, "Photos are made smaller for you before they upload. GIFs and animated images can be up to 1.5MB and SVGs up to 300KB. Duplicates are detected and reused.");
  for (const bad of ["up to 1.5MB ·", "sanitized", "PNG, JPEG, WebP, GIF"]) ok(!admin.includes(bad), `the library still says ${bad}:`);
});

await t("nothing else in the console posts files to the media route", async () => {
  const { readdir } = await import("node:fs/promises");
  const hits = [];
  for (const dir of ["components", "app"]) {
    for (const entry of await readdir(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const s = await readFile(join(entry.parentPath, entry.name), "utf8");
      if (/\/api\/admin\/media["'`]\s*,\s*\{\s*method:\s*["']POST/.test(s) || /\.append\(\s*["']file["']|\.set\(\s*["']file["']/.test(s)) hits.push(entry.name);
    }
  }
  eq(hits, []);
});

await t("lib/media-upload.js stays browser-safe: no server imports", async () => {
  for (const rel of ["lib/media-upload.js", "lib/media-upload-plan.js"]) {
    const imports = [...(await source(rel)).matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    ok(imports.every((i) => i === "./media-upload-plan.js"), `${rel} imports ${imports}:`);
  }
});

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(root, f), { force: true });
process.exit(fail ? 1 : 0);
