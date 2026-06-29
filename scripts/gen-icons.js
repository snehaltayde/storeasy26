// Rasterise public/icon.svg into the PNG sizes the PWA manifest needs.
//   node scripts/gen-icons.js
import sharp from "sharp";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = await readFile(join(root, "public/icon.svg"));
const outDir = join(root, "public/icons");
await mkdir(outDir, { recursive: true });

const targets = [
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  { name: "icon-maskable-512.png", size: 512 },
  { name: "apple-touch-icon.png", size: 180 },
];

for (const { name, size } of targets) {
  await sharp(svg).resize(size, size).png().toFile(join(outDir, name));
  console.log(`  ✓ ${name} (${size}px)`);
}
console.log("✓ icons generated");
