// Pixel comparison for screenshot baselines (TOK-01). No new dependency:
// `sharp` (already used by scripts/drill.js) decodes both PNGs to raw RGBA,
// and every pixel is compared channel by channel.
//
//   node scripts/pixel-diff.js <before-dir> <after-dir> [--out <dir>] [--json <file>] [--tolerance N]
//   node scripts/pixel-diff.js <before.png> <after.png> [--out <dir>]
//
// Same-named PNGs in the two folders are compared. For each pair it reports
// the number of pixels that differ (any channel off by more than
// --tolerance, default 0, so "0 differing pixels" means byte-identical
// pixels), the bounding box of the change, and whether the sizes differ.
// With --out, every pair that differs gets a small diff image: the "after"
// shot faded to 25%, changed pixels painted solid red, scaled to at most
// 720 wide (the same budget as drill screenshots).
// Exit code: 0 when every pair is identical, 1 when any differs or a file is
// missing on one side, 2 on bad usage.
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

async function raw(file) {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Compare two decoded images. Pure, so the unit test can feed it buffers.
export function comparePixels(a, b, { tolerance = 0 } = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    return { sameSize: false, sizeA: [a.width, a.height], sizeB: [b.width, b.height], differing: null, total: null, box: null, mask: null };
  }
  const total = a.width * a.height;
  const mask = new Uint8Array(total);
  let differing = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (
      Math.abs(a.data[o] - b.data[o]) > tolerance ||
      Math.abs(a.data[o + 1] - b.data[o + 1]) > tolerance ||
      Math.abs(a.data[o + 2] - b.data[o + 2]) > tolerance ||
      Math.abs(a.data[o + 3] - b.data[o + 3]) > tolerance
    ) {
      mask[i] = 1;
      differing++;
      const x = i % a.width;
      const y = (i - x) / a.width;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return { sameSize: true, sizeA: [a.width, a.height], sizeB: [b.width, b.height], differing, total, box: differing ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null, mask };
}

async function diffImage(after, mask, file) {
  const sharp = (await import("sharp")).default;
  const out = Buffer.alloc(after.width * after.height * 4);
  for (let i = 0; i < after.width * after.height; i++) {
    const o = i * 4;
    if (mask[i]) {
      out[o] = 230;
      out[o + 1] = 0;
      out[o + 2] = 0;
    } else {
      // fade the unchanged page so the red stands out
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(255 - (255 - after.data[o + c]) * 0.25);
    }
    out[o + 3] = 255;
  }
  const png = await sharp(out, { raw: { width: after.width, height: after.height, channels: 4 } })
    .resize({ width: Math.min(after.width, 720), withoutEnlargement: true, kernel: "nearest" })
    .png({ palette: true, colours: 64, compressionLevel: 9 })
    .toBuffer();
  writeFileSync(file, png);
  return png.length;
}

export async function diffFiles(beforeFile, afterFile, { tolerance = 0, outDir = null, name = basename(afterFile, ".png") } = {}) {
  const [a, b] = await Promise.all([raw(beforeFile), raw(afterFile)]);
  const r = comparePixels(a, b, { tolerance });
  const result = { name, sameSize: r.sameSize, sizeBefore: r.sizeA, sizeAfter: r.sizeB, differing: r.differing, total: r.total, share: r.total ? Number((r.differing / r.total).toFixed(6)) : null, box: r.box };
  if (outDir && r.sameSize && r.differing) {
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${name}-diff.png`);
    result.diffImage = file;
    result.diffBytes = await diffImage(b, r.mask, file);
  }
  return result;
}

export async function diffDirs(beforeDir, afterDir, opts = {}) {
  const pngs = (d) => new Set(readdirSync(d).filter((f) => f.endsWith(".png")));
  const A = pngs(beforeDir);
  const B = pngs(afterDir);
  const names = [...new Set([...A, ...B])].sort();
  const results = [];
  for (const f of names) {
    if (!A.has(f) || !B.has(f)) {
      results.push({ name: f.slice(0, -4), missing: !A.has(f) ? "before" : "after" });
      continue;
    }
    results.push(await diffFiles(join(beforeDir, f), join(afterDir, f), { ...opts, name: f.slice(0, -4) }));
  }
  return results;
}

export const isClean = (results) => results.every((r) => !r.missing && r.sameSize && r.differing === 0);

async function main(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  if (pos.length !== 2) {
    console.error("Usage: node scripts/pixel-diff.js <before-dir|png> <after-dir|png> [--out <dir>] [--json <file>] [--tolerance N]");
    return 2;
  }
  const opts = { tolerance: Number(flags.tolerance || 0), outDir: flags.out || null };
  const results = isDir(pos[0]) ? await diffDirs(pos[0], pos[1], opts) : [await diffFiles(pos[0], pos[1], opts)];
  for (const r of results) {
    if (r.missing) console.log(`MISSING  ${r.name} (no ${r.missing} shot)`);
    else if (!r.sameSize) console.log(`SIZE     ${r.name} ${r.sizeBefore.join("x")} → ${r.sizeAfter.join("x")}`);
    else if (r.differing) console.log(`DIFF     ${r.name} ${r.differing} px (${(r.share * 100).toFixed(3)}%) box ${r.box.x},${r.box.y} ${r.box.width}x${r.box.height}`);
    else console.log(`same     ${r.name}`);
  }
  const changed = results.filter((r) => r.missing || !r.sameSize || r.differing).length;
  console.log(`\n${results.length} compared, ${results.length - changed} identical, ${changed} different`);
  if (flags.json) writeFileSync(flags.json, `${JSON.stringify({ tolerance: opts.tolerance, compared: results.length, identical: results.length - changed, results }, null, 2)}\n`);
  return changed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
