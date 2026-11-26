# Motion notes: what the reference does, and what the landing page took from it

Reference studied on 2026-11-26: https://www.weflash.studio/ (a web studio's home page), in the
built-in browser at 1440 and phone width, by scrolling it and reading its loaded scripts and
stylesheets. Only techniques were taken. Its layout, words, pictures, colours and type are not
used anywhere on the Storeasy page.

## What it is built with

- A Webflow site with one federated "engine" bundle on top: **GSAP 3.15** with ScrollTrigger,
  SplitText, DrawSVG and a physics plugin, **Lenis** for scrolling, and **three.js** for a WebGL
  logo that travels down the page between poses.
- **Lenis:** `lerp: 0.2`, `smoothWheel: true`, `syncTouch: false` (touch scrolls natively),
  `autoRaf: false` with `lenis.on("scroll", ScrollTrigger.update)`, so GSAP's clock drives both.
  Anchors scroll with an offset for the header.
- **Pinning is CSS, not `pin: true`:** six `position: sticky` frames one screen tall inside
  sections three to five screens tall, and no `.pin-spacer` in the page. ScrollTrigger only reads
  progress (`start: "top top"`, `end: "bottom bottom"`) and scrubs a timeline.
- **Scrub values:** `scrub: true` for parallax and progress, `0.6` to `0.8` where the motion
  should trail the wheel a little.
- **Horizontal section:** a sticky frame whose row is translated on x by the vertical scroll; the
  section's height is what gives it its length.
- **Type:** an oversized display line (about 14vw, leading 0.92, tight tracking), split into
  lines, words or characters, each inside a mask (`overflow: hidden` wrapper with a little block
  padding so descenders are not cut), rising with staggers of 0.02 to 0.09s.
- **Easing:** `cubic-bezier(.16,1,.3,1)` (an expo-out) for almost every entrance, `.76,0,.24,1`
  for covers and wipes, `elastic.out(1, 0.4)` for the magnetic buttons' return.
- **Pointer:** a labelled cursor element (hidden on coarse pointers), and magnetic buttons built on
  `gsap.quickTo` with a pull of about 0.2.
- **Masks:** `clip-path` polygons and insets animated to reveal pictures and panels.
- **Marquee:** a row moved by `xPercent: -50` on repeat, paused while off screen.
- **Page transitions:** a full-screen cover with a drawn SVG, plus the View Transitions API.
- **Reduced motion:** one check up front skips Lenis and the scroll effects; the cursor and the
  loops are also turned off in CSS.

## What the Storeasy page uses

| Technique | Where | Our own values |
|---|---|---|
| Lenis on GSAP's ticker | whole page | `lerp: 0.11`, touch left native, anchors offset by the header |
| Sticky pin + scrubbed timeline | the receipt (from 1024px), the rail (from 768px) | `scrub: 0.6` and `0.5`; no pin-spacer, so React's tree is never rewrapped |
| Horizontal row on vertical scroll | "Sell more in each order" | section height = one screen + the row's overflow, so it moves 1:1 |
| Split lines in masks | every section heading | SplitText `lines` + `mask`, `expo.out`, 1.15s, 0.09s stagger |
| Clip-path wipe | the closing line, the "beyond India" note | inset from the lower edge, `expo.out` |
| Scrubbed line drawing | the request path in the speed section | fill, travelling point and three nodes on one timeline |
| Magnetic buttons, pointer disc | the four calls to action; fine pointers only | pull 0.3 / 0.4, spring back `elastic.out(1, 0.45)`; the system cursor stays |

## What was left out, and why

- **WebGL / three.js:** about 600 KB for decoration, on a page that sells speed.
- **Intro loader and page-transition covers:** they delay the first paint and the other marketing
  pages have no motion to hand over to.
- **A looping marquee:** needs its own pause control and repeats what the receipt already says.
- **Hiding the system cursor, a labelled cursor:** the disc follows the real cursor instead.
- **`pin: true`:** it wraps the pinned node in a spacer, which fights React on unmount; sticky
  frames do the same job.

## One rule of our own

The server sends the finished page: every receipt line struck, every block visible, the rail a
grid. The motion island rewinds those states and plays them. So with `prefers-reduced-motion`,
with no script, or if the libraries fail to load, nothing is hidden and nothing is pinned.
