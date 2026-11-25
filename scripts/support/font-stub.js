// One stand-in for the fonts when a test loads app code under plain Node
// (no Next build): next/font/local (and next/font/google, which test:fonts
// keeps out of the app) and app/fonts/fonts.js itself. Every name it is asked
// for is a font: callable like a next/font loader (→ the same font) and
// carrying the className / variable / style a loaded font has, all empty.
const font = Object.assign(() => font, { className: "", variable: "", style: {} });
export const fontModule = new Proxy({}, { get: (_, k) => (k === "__esModule" ? true : k === "then" ? undefined : font) });
// the import ids that resolve to it
export const FONT_MODULE_IDS = ["next/font/local", "next/font/google", "@/app/fonts/fonts"];
