import localFont from "next/font/local";
import "./fonts.css";

// Self-hosted fonts (were next/font/google, whose Turbopack build sometimes
// failed and left every page answering 500). The files are the Google Fonts
// subsets that next/font/google fetched (Geist v5, Geist Mono v6, Fraunces
// v38), copied from Next's build output; all three are OFL.
//
// Turbopack names a next/font/local family after the binding, so each binding
// IS the family name the CSS sees (Geist, GeistMono, Fraunces). Only the latin
// subset goes through next/font/local, so it keeps its preload; the other
// subsets (their own unicode-range, the same family name) and the metric
// matched fallback faces (Google's own overrides) are in ./fonts.css.
// scripts/test-fonts.js holds the two files to each other.
// next/font wants literal options, so the latin unicode-range is written out
// in each call (Google's latin subset range).

export const Geist = localFont({
  src: "./geist/latin.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  declarations: [{ prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" }],
  adjustFontFallback: false,
  fallback: ["'Geist Fallback'"],
  variable: "--font-geist-sans",
});

export const GeistMono = localFont({
  src: "./geist-mono/latin.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  declarations: [{ prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" }],
  adjustFontFallback: false,
  fallback: ["'Geist Mono Fallback'"],
  variable: "--font-geist-mono",
});

// S37: display serif for kits that ask for one (Glow); kits pick it up
// through the --display-font token. One variable file, declared at the three
// weights the Google config asked for, as Google declared it.
export const Fraunces = localFont({
  src: [
    { path: "./fraunces/latin.woff2", weight: "400" },
    { path: "./fraunces/latin.woff2", weight: "600" },
    { path: "./fraunces/latin.woff2", weight: "700" },
  ],
  style: "normal",
  display: "swap",
  declarations: [{ prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" }],
  adjustFontFallback: false,
  fallback: ["'Fraunces Fallback'"],
  variable: "--font-fraunces",
});
