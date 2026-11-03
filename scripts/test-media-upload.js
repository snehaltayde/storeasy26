// Phone photo upload suite (MED-01). Everything a plain node process can prove:
// the pure size plan, the upload path driven by a stand-in canvas, and the REAL
// /api/admin/media route (real requireAdmin, real saveMedia, real tenant db) so
// the server limits, magic-byte checks and SVG sanitizing are shown still to run.
// Real pixels through a real canvas can't run here: that is the browser drill
// listed in docs/cms-reviews/P1-MED-01.md.
//   pnpm test:media-upload
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
function fakeCodec({ width = 4032, height = 3024, detail = 1, alpha = false, writesWebp = true, undecodable = false, nullBlobs = false, throwAbove = 0, encodedSize = null } = {}) {
  const calls = { encode: [], decode: 0, hasAlpha: 0, closed: 0 };
  return {
    calls,
    decode: async () => {
      calls.decode++;
      if (undecodable) throw new Error("The source image could not be decoded.");
      return { width, height, close: () => calls.closed++ };
    },
    hasAlpha: async () => {
      calls.hasAlpha++;
      return alpha;
    },
    encode: async (_image, step) => {
      calls.encode.push(step);
      if (throwAbove && Math.max(step.width, step.height) > throwAbove) throw new Error("canvas too large");
      if (nullBlobs) return null;
      const mime = step.mime === "image/webp" && !writesWebp ? "image/png" : step.mime;
      const perPixel = mime === "image/png" ? 2 : 0.116 * Math.pow((step.quality || 0.85) / 0.85, 3.5);
      const size = encodedSize ?? Math.max(16, Math.round(step.width * step.height * perPixel * detail));
      return new Blob([bytesOf(mime, size)], { type: mime });
    },
  };
}

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

await t("route: read-only support is still refused, in plain words", async () => {
  const r = await U.uploadImage(photoFile("a.jpg", 2048), { codec: fakeCodec({ width: 800, height: 600 }), send: realSend(supportTok) });
  eq(r.ok, false);
  eq(r.message, P.uploadMessage.noPermission());
});

// ---- the size plan ------------------------------------------------------------
console.log("— size plan");

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
    ["", "notes.txt", "refuse"],
    ["", "noextension", "refuse"],
  ];
  for (const [type, name, action] of cases) eq(P.classifyUpload({ type, name }).action, action, `${type} ${name}:`);
});

await t("classify: an empty type falls back to the file name; HEIC is named as HEIC", () => {
  eq(P.classifyUpload({ type: "", name: "IMG_1.JPG" }), { action: "resize", mime: "image/jpeg" });
  eq(P.classifyUpload({ type: "application/octet-stream", name: "a.png" }), { action: "resize", mime: "image/png" });
  eq(P.classifyUpload({ type: "", name: "IMG_2.heic" }), { action: "convert", mime: "image/heic", heic: true });
  eq(P.classifyUpload({ type: "image/heif", name: "x" }).heic, true);
  eq(P.classifyUpload({ type: "image/avif", name: "x" }).heic, false);
});

await t("when to skip: only small in bytes AND in size", () => {
  const go = (size, width, height, action = "resize") => P.shouldResize({ size, width, height, action });
  eq(go(LIMIT, 1920, 1080), false, "exactly at both limits:");
  eq(go(200_000, 800, 600), false, "small:");
  eq(go(LIMIT + 1, 800, 600), true, "over the bytes:");
  eq(go(500_000, 1921, 1000), true, "over the edge:");
  eq(go(500_000, 1000, 1921), true, "portrait over the edge:");
  eq(go(1000, 10, 10, "convert"), true, "the server can't take it as it is:");
});

await t("fitLongEdge never upscales and keeps the aspect", () => {
  eq(P.fitLongEdge(4032, 3024, 1920), { width: 1920, height: 1440 });
  eq(P.fitLongEdge(3024, 4032, 1920), { width: 1440, height: 1920 });
  eq(P.fitLongEdge(800, 600, 1920), { width: 800, height: 600 });
  eq(P.fitLongEdge(10000, 1, 1920), { width: 1920, height: 1 }, "never collapses to zero:");
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
});

await t("steps: a transparent image never gets a JPEG step", () => {
  const steps = P.encodeSteps({ width: 3000, height: 3000, hasAlpha: true });
  ok(!steps.some((s) => s.mime === "image/jpeg"), "no jpeg:");
  eq(steps[0].mime, "image/webp");
  eq(steps[steps.length - 1], { mime: "image/png", width: 800, height: 800 });
  ok(steps.filter((s) => s.mime === "image/png").every((s) => !("quality" in s)), "png has no quality:");
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
  eq(r.reduced, false);
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

await t("a fake .jpg small enough to send: the server's magic-byte check refuses it, in plain words", async () => {
  const r = await U.uploadImage(new File(["%PDF-1.7 pretending"], "photo.jpg", { type: "image/jpeg" }), { codec: fakeCodec({ undecodable: true }), send: realSend() });
  eq(r.ok, false);
  eq(r.message, P.uploadMessage.notWhatItSays("photo.jpg"));
});

await t("an empty browser type: the inferred type travels with the file so the server accepts it", async () => {
  const r = await U.uploadImage(new File([bytesOf("image/jpeg", 2048)], "IMG_3.JPG", { type: "" }), { codec: fakeCodec({ width: 800, height: 600 }), send: realSend() });
  ok(r.ok, `uploaded (${r.message}):`);
  eq((await stored(r.media.id)).mime, "image/jpeg");
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
    const m = fn("x.jpg");
    for (const bad of ["mime", "MIME", "canvas", "decode", "422", "magic", "sanitiz", "undefined", "Error"]) ok(!m.includes(bad), `"${m}" has ${bad}:`);
  }
});

await t("the stated GIF and SVG limits match the server", () => {
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
    made.upload.onprogress({ lengthComputable: false });
    Object.assign(made, { status: 200, responseText: '{"ok":true}' });
    made.onload();
    eq(await p, { status: 200, json: { ok: true } });
    eq(percents, [25]);
    p = U.xhrSend(new FormData(), () => {});
    Object.assign(made, { status: 413, responseText: "<html>Request Entity Too Large</html>" });
    made.onload();
    eq(await p, { status: 413, json: {} }, "a platform error page:");
    p = U.xhrSend(new FormData(), () => {});
    made.onerror();
    eq(await p, { status: 0, json: {} }, "no answer:");
  } finally {
    delete globalThis.XMLHttpRequest;
  }
});

// ---- one upload path ----------------------------------------------------------
console.log("— one upload path");

const source = (rel) => readFile(join(root, rel), "utf8");

await t("MediaAdmin and MediaPicker both upload through uploadImage and hold no copy of their own", async () => {
  for (const rel of ["components/admin/MediaAdmin.js", "components/admin/cms/MediaPicker.js"]) {
    const s = await source(rel);
    includes(s, 'import { uploadImage } from "@/lib/media-upload"', `${rel}:`);
    includes(s, "uploadImage(file, { onProgress: setUploading })", `${rel}:`);
    includes(s, "accept={UPLOAD_ACCEPT}", `${rel}:`);
    includes(s, "<MediaUploadStatus progress={uploading} />", `${rel}:`);
    for (const bad of ["createImageBitmap", "FormData", 'method: "POST"', "toBlob", "image/png,image/jpeg"]) ok(!s.includes(bad), `${rel} still has ${bad}:`);
  }
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
