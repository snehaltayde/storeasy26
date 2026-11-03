// Test files for the MED-01 drills on desktop Chrome, made locally with sharp
// (synthetic pictures: not real phone photos, so no Display P3 or real EXIF
// from a camera). Writes into the folder given.
//   node scripts/drills/p1/med01-fixtures.mjs <outDir>
import sharp from "sharp";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const w = (name, buf) => {
  writeFileSync(join(out, name), buf);
  return `${name} ${buf.length} bytes`;
};

// A "photo": smooth gradient plus noise, so JPEG can't squeeze it to nothing.
async function photo(width, height, { quality = 92, alpha = false, holes = "corners", amp = 0.35 } = {}) {
  const ch = alpha ? 4 : 3;
  const raw = Buffer.alloc(width * height * ch);
  const noise = randomBytes(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * ch;
      const n = noise[y * width + x] - 128;
      raw[i] = Math.max(0, Math.min(255, (x / width) * 220 + n * amp));
      raw[i + 1] = Math.max(0, Math.min(255, (y / height) * 200 + 30 + n * amp));
      raw[i + 2] = Math.max(0, Math.min(255, 120 + Math.sin(x / 37) * 60 + n * amp));
      if (alpha) {
        const corner = holes === "corners" ? (x < width * 0.2 || x > width * 0.8) && (y < height * 0.2 || y > height * 0.8) : Math.hypot(x - width / 2, y - height / 2) < Math.min(width, height) / 6;
        raw[i + 3] = corner ? 0 : 255;
      }
    }
  return sharp(raw, { raw: { width, height, channels: ch } });
}

const made = [];
made.push(w("photo-4000x3000.jpg", await (await photo(4000, 3000, { amp: 0.1 })).jpeg({ quality: 95 }).toBuffer()));
made.push(w("photo-4000x3000-again.jpg", await (await photo(4000, 3000, { amp: 0.1 })).jpeg({ quality: 95 }).toBuffer()));
made.push(w("transparent-1800.png", await (await photo(1800, 1800, { alpha: true })).png({ compressionLevel: 6 }).toBuffer()));
made.push(w("transparent-1800-renamed.jpg", await (await photo(1800, 1800, { alpha: true })).png({ compressionLevel: 6 }).toBuffer()));
made.push(w("transparent-one-hole-1800.png", await (await photo(1800, 1800, { alpha: true, holes: "middle" })).png({ compressionLevel: 6 }).toBuffer()));
// Sideways: stored landscape 4032x3024 with EXIF orientation 6 (shows as portrait 3024x4032)
made.push(w("sideways-exif6.jpg", await (await photo(4032, 3024, { amp: 0.1 })).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer()));
// HEIC-labelled file: an AVIF (sharp's heif writer) with its brand set to heic. Chrome can't open it.
{
  const avif = await (await photo(800, 600)).heif({ compression: "av1", quality: 60 }).toBuffer();
  const b = Buffer.from(avif);
  const i = b.indexOf("ftyp");
  if (i > 0) b.write("heic", i + 4, "latin1");
  made.push(w("phone-photo.heic", b));
}
// A HEIC-branded file with no picture any browser here can decode (a real HEVC HEIC can't be made with sharp).
{
  const box = Buffer.alloc(24);
  box.writeUInt32BE(24, 0);
  box.write("ftypheic", 4, "latin1");
  box.writeUInt32BE(0, 12);
  box.write("mif1heic", 16, "latin1");
  made.push(w("phone-photo-undecodable.heic", Buffer.concat([box, randomBytes(200_000)])));
}
made.push(w("small-800x600.jpg", await (await photo(800, 600)).jpeg({ quality: 85 }).toBuffer()));
made.push(w("small-300.png", await (await photo(300, 300)).png().toBuffer()));
made.push(w("small-png-renamed.jpg", await (await photo(400, 300)).png().toBuffer()));
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
made.push(w("price-list.pdf", pdf));
made.push(w("price-list-renamed.jpg", pdf));
{
  const good = await (await photo(600, 400)).jpeg({ quality: 85 }).toBuffer();
  const bad = Buffer.concat([good.subarray(0, 600), randomBytes(good.length - 600)]);
  made.push(w("damaged.jpg", bad));
}
made.push(w("empty.jpg", Buffer.alloc(0)));
made.push(w("photo-no-extension", await (await photo(900, 600)).jpeg({ quality: 85 }).toBuffer()));
made.push(w("photo.jfif", await (await photo(900, 600)).jpeg({ quality: 85 }).toBuffer()));
// A GIF over 1.5MB (noise defeats compression) and an SVG over 300KB
made.push(w("big.gif", await (await photo(1600, 1400)).gif({ effort: 1, dither: 1 }).toBuffer()));
made.push(w("big.svg", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${"<!-- padding padding padding padding padding padding padding padding -->".repeat(5000)}<rect width="100" height="100" fill="#0a7"/></svg>`)));
made.push(w("script.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><script>alert(1)</script><rect width="120" height="60" fill="#e60" onload="alert(2)"/><text x="10" y="35">hi</text></svg>')));
// Animated: frames joined
async function frames(n, width, height) {
  const out = [];
  for (let k = 0; k < n; k++) out.push(await (await photo(width, height)).png({ compressionLevel: 1 }).toBuffer());
  return out;
}
{
  const f = await frames(3, 200, 150);
  made.push(w("anim-small.gif", await sharp(f, { join: { animated: true } }).gif({ loop: 0, delay: 300 }).toBuffer()));
  made.push(w("anim-small-renamed.jpg", await sharp(f, { join: { animated: true } }).gif({ loop: 0, delay: 300 }).toBuffer()));
}
{
  const f = await frames(2, 2400, 1000);
  made.push(w("anim-2400x1000.webp", await sharp(f, { join: { animated: true } }).webp({ loop: 0, delay: 400, quality: 40 }).toBuffer()));
  made.push(w("anim-webp-big.webp", await sharp(await frames(6, 2400, 1800), { join: { animated: true } }).webp({ loop: 0, delay: 400, quality: 95 }).toBuffer()));
  made.push(w("anim-webp-big-renamed.jpg", await sharp(await frames(6, 2400, 1800), { join: { animated: true } }).webp({ loop: 0, delay: 400, quality: 95 }).toBuffer()));
}
// Long images
made.push(w("size-chart-1080x5000.png", await sharp({ create: { width: 1080, height: 5000, channels: 3, background: "#ffffff" } }).composite([{ input: await (await photo(1080, 400)).png().toBuffer(), top: 100, left: 0 }]).png().toBuffer()));
made.push(w("long-2000x6000.jpg", await sharp({ create: { width: 2000, height: 6000, channels: 3, background: "#f4efe6" } }).composite([{ input: await (await photo(2000, 300)).jpeg().toBuffer(), top: 2800, left: 0 }]).jpeg({ quality: 80 }).toBuffer()));
made.push(w("strip-4000x400.jpg", await (await photo(4000, 400)).jpeg({ quality: 70 }).toBuffer()));
made.push(w("long-screenshot-1290x7000.png", await (await photo(1290, 7000)).png({ compressionLevel: 9 }).toBuffer()));
made.push(w("very-long-1200x12000.jpg", await (await photo(1200, 12000)).jpeg({ quality: 95 }).toBuffer()));
console.log(made.join("\n"));
for (const f of ["photo-4000x3000.jpg", "transparent-1800.png", "big.gif", "anim-2400x1000.webp", "anim-webp-big.webp", "long-2000x6000.jpg"]) console.log(f, statSync(join(out, f)).size);
