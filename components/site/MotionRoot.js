"use client";

import { useEffect } from "react";

// The landing page's motion island. It holds no words and draws nothing. The
// page it finds is already finished (components/site/landing.css draws every
// final state); this rewinds those states and plays them against the scroll,
// through the markup's attributes:
//   data-deck           the hero's deck: the queue of rented apps and the
//                       panel of built-in features turn into loops, one app
//                       dropping into the panel at a time
//   data-scene="rail"   from 768px, pinned and slid sideways by the scroll
//   data-path           the speed section's line, drawn as it arrives
//   data-art            a picture (./LandingArt.js): its data-pop parts rise
//                       into place, its data-stroke lines draw themselves and
//                       its data-grow bars fill, once, as it reaches the window
//                       (on the pinned rail: as the rail brings it in)
//   data-split          a heading whose lines rise out of their masks
//   data-reveal         a block that fades up; data-draw a rule that draws;
//                       data-clip a block wiped in from its lower edge
//   data-magnetic       a button that leans towards a fine pointer
// There is no pointer companion: the disc that followed the pointer read as a
// stray dot on the page and was taken out (owner, 2026-11-26).
// GSAP (ScrollTrigger, SplitText) and Lenis are fetched here and nowhere else,
// after the page is up, so no store page and no other marketing page carries
// them (docs/DECISIONS.md). Under prefers-reduced-motion nothing is fetched
// and nothing starts.
export default function MotionRoot() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const home = document.querySelector("[data-mk-home]");
    if (!home) return undefined;
    let gone = false;
    let stop = () => {};
    Promise.all([import("gsap"), import("gsap/ScrollTrigger"), import("gsap/SplitText"), import("lenis")])
      .then(([{ gsap }, { ScrollTrigger }, { SplitText }, { default: Lenis }]) => {
        if (!gone) stop = start({ gsap, ScrollTrigger, SplitText, Lenis, home });
      })
      .catch(() => {}); // the libraries did not arrive: the page stays as drawn
    return () => {
      gone = true;
      stop();
    };
  }, []);
  return null;
}

function start({ gsap, ScrollTrigger, SplitText, Lenis, home }) {
  gsap.registerPlugin(ScrollTrigger, SplitText);
  // The header floats over the page (components/site/SiteNav.js), so the
  // pinned rail takes the whole window.
  const head = 0;

  // Inertial scrolling, on GSAP's clock so the scrubbed scenes stay in step.
  const lenis = new Lenis({ lerp: 0.11, anchors: true, autoRaf: false }); // anchors land by each section's scroll-margin
  lenis.on("scroll", ScrollTrigger.update);
  const tick = (time) => lenis.raf(time * 1000);
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);

  const mm = gsap.matchMedia();
  mm.add({ any: "(min-width: 1px)", mid: "(min-width: 768px)", fine: "(hover: hover) and (pointer: fine)" }, (ctx) => {
    const { mid, fine } = ctx.conditions;
    home.dataset.motion = "on";
    home.dataset.pin = mid ? "rail" : "";
    const undo = [deck(gsap, ScrollTrigger, home), mid && rail(gsap, ScrollTrigger, home, head), path(gsap, home), art(gsap, home, mid), reveals(gsap, ScrollTrigger, SplitText, home), fine && pointer(gsap)];
    return () => {
      for (const fn of undo) if (fn) fn();
      delete home.dataset.motion;
      delete home.dataset.pin;
    };
  });
  // The display face changes every measure once it has loaded.
  document.fonts?.ready.then(() => ScrollTrigger.refresh());

  return () => {
    mm.revert();
    gsap.ticker.remove(tick);
    gsap.ticker.lagSmoothing(500, 33);
    lenis.destroy();
  };
}

// The hero's deck: its two windows become loops. Each list gets copies of the
// rows its window shows put before it, so after one turn the window is back on
// the same rows and the loop closes without a seam. Every 2.3s the queue's
// last app drops out of it and the feature that replaces that app lands at the
// top of the panel, lit for a moment. It holds still under the pointer and
// while the hero is out of the window. The copies are taken away on the way out.
function deck(gsap, ScrollTrigger, home) {
  const figure = home.querySelector("[data-deck]");
  if (!figure) return undefined;
  const copies = [];
  const reel = (list) => {
    const rows = [...list.children];
    const height = rows[0].offsetHeight;
    const shown = Math.round(list.parentElement.clientHeight / height);
    const lead = rows.slice(-shown).map((row) => row.cloneNode(true));
    list.prepend(...lead);
    copies.push(...lead);
    return { list, height, shown, count: rows.length, all: [...lead, ...rows] };
  };
  const queue = reel(figure.querySelector("[data-deck-queue]"));
  const built = reel(figure.querySelector("[data-deck-built]"));
  const tl = gsap.timeline({ repeat: -1, delay: 2.6 });
  for (let i = 0; i < queue.count; i++) {
    const at = i * 2.3;
    const landed = built.all[built.all.length - built.shown - 1 - i];
    tl.to(queue.list, { y: (i + 1) * queue.height, duration: 0.7, ease: "power3.inOut" }, at);
    tl.to(built.list, { y: (i + 1) * built.height, duration: 0.7, ease: "power3.inOut" }, at + 0.3);
    tl.fromTo(landed, { "--lit": 1 }, { "--lit": 0, duration: 1.2, ease: "power2.out" }, at + 0.6);
    tl.fromTo(landed.firstElementChild, { scale: 0 }, { scale: 1, duration: 0.5, ease: "back.out(2.6)" }, at + 0.6);
  }
  tl.to({}, { duration: 1.6 });
  let seen = true;
  let held = false;
  const run = () => (seen && !held ? tl.play() : tl.pause());
  const watch = ScrollTrigger.create({ trigger: figure, start: "top bottom", end: "bottom top", onToggle: (self) => ((seen = self.isActive), run()) });
  const hold = () => ((held = true), run());
  const free = () => ((held = false), run());
  figure.addEventListener("pointerenter", hold);
  figure.addEventListener("pointerleave", free);
  return () => {
    figure.removeEventListener("pointerenter", hold);
    figure.removeEventListener("pointerleave", free);
    watch.kill();
    tl.kill();
    gsap.set([queue.list, built.list], { clearProps: "transform" });
    for (const row of copies) row.remove();
  };
}

// The rail: the section is made as tall as the row is long, so one screen of
// scroll moves the row by one screen.
function rail(gsap, ScrollTrigger, home, head) {
  const scene = home.querySelector('[data-scene="rail"]');
  const row = scene.querySelector("[data-rail]");
  const run = () => Math.max(0, row.scrollWidth - document.documentElement.clientWidth);
  const size = () => scene.style.setProperty("--rail-run", `${run()}px`);
  size();
  ScrollTrigger.addEventListener("refreshInit", size);
  const scrollTrigger = { trigger: scene, start: `top ${head}px`, end: "bottom bottom", invalidateOnRefresh: true };
  const slide = gsap.to(row, { x: () => -run(), ease: "none", scrollTrigger: { ...scrollTrigger, scrub: 0.5 } });
  // Each panel's picture plays as the rail carries it into the window.
  for (const el of scene.querySelectorAll("[data-art]")) draw(gsap, el, { trigger: el, containerAnimation: slide, start: "left 88%", once: true });
  gsap.fromTo(scene.querySelector("[data-rail-bar]"), { scaleX: 0 }, { scaleX: 1, ease: "none", scrollTrigger: { ...scrollTrigger, scrub: true } });
  return () => {
    ScrollTrigger.removeEventListener("refreshInit", size);
    scene.style.removeProperty("--rail-run");
  };
}

// The speed section's line: drawn from the cached content to the shopper's
// screen while the figure crosses the middle of the window.
function path(gsap, home) {
  const figure = home.querySelector("[data-path]");
  const nodes = [...figure.querySelectorAll("[data-node]")];
  const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: { trigger: figure, start: "top 78%", end: "top 30%", scrub: 0.5 } });
  tl.fromTo(figure.querySelector("[data-path-fill]"), { scaleX: 0 }, { scaleX: 1, duration: 1 }, 0);
  tl.fromTo(figure.querySelector("[data-path-dot]"), { left: "0%" }, { left: "100%", duration: 1 }, 0);
  nodes.forEach((node, i) => {
    tl.from(node, { scale: 0.72, autoAlpha: 0.35, duration: 0.14, ease: "back.out(2.4)" }, Math.max(0, (i / (nodes.length - 1)) * 0.94 - 0.06));
  });
}

// One picture, played once: parts rise, bars fill, lines draw. The SVG parts
// keep what GSAP leaves on them (their resting state); the HTML parts hand
// their transform back to the stylesheet, which tilts and fans some of them.
function draw(gsap, el, scrollTrigger) {
  const all = (name) => [...el.querySelectorAll(`[${name}]`)];
  const svg = (node) => node instanceof SVGElement && !(node instanceof SVGSVGElement);
  const tl = gsap.timeline({ defaults: { ease: "power3.out" }, scrollTrigger });
  const pops = all("data-pop");
  const parts = pops.filter((node) => !svg(node));
  const marks = pops.filter(svg);
  if (parts.length) tl.from(parts, { autoAlpha: 0, y: 22, scale: 0.94, duration: 0.8, stagger: 0.06, clearProps: "transform,opacity,visibility" }, 0);
  if (marks.length) tl.from(marks, { autoAlpha: 0, y: 8, duration: 0.6, stagger: 0.07 }, 0);
  const bars = all("data-grow");
  if (bars.length) tl.from(bars, { scaleX: 0, transformOrigin: (i, node) => (node.dataset.grow === "end" ? "100% 50%" : "0% 50%"), duration: 0.9, ease: "power2.inOut", stagger: 0.08 }, 0.25);
  const lines = all("data-stroke");
  if (lines.length) tl.fromTo(lines, { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 1.1, ease: "power2.inOut", stagger: 0.1 }, 0.3);
}

// Every picture still below the fold. On the pinned rail the rail plays its own.
function art(gsap, home, railPinned) {
  for (const el of home.querySelectorAll("[data-art]")) {
    if (railPinned && el.closest('[data-scene="rail"]')) continue;
    if (el.getBoundingClientRect().top > window.innerHeight * 0.92) draw(gsap, el, { trigger: el, start: "top 84%", once: true });
  }
}

// What arrives as the page is read. Only what is still below the fold when
// this starts is rewound, so nothing already on screen blinks.
function reveals(gsap, ScrollTrigger, SplitText, home) {
  const below = (el) => el.getBoundingClientRect().top > window.innerHeight * 0.92;
  const waiting = (name) => [...home.querySelectorAll(`[${name}]`)].filter(below);

  for (const el of waiting("data-split")) {
    SplitText.create(el, {
      type: "lines",
      mask: "lines",
      linesClass: "mk-split",
      autoSplit: true,
      onSplit: (self) => gsap.from(self.lines, { yPercent: 112, duration: 1.15, ease: "expo.out", stagger: 0.09, scrollTrigger: { trigger: el, start: "top 88%", once: true } }),
    });
  }

  const blocks = waiting("data-reveal");
  gsap.set(blocks, { autoAlpha: 0, y: 30 });
  ScrollTrigger.batch(blocks, { start: "top 90%", once: true, onEnter: (els) => gsap.to(els, { autoAlpha: 1, y: 0, duration: 1, ease: "power3.out", stagger: 0.09, overwrite: true }) });

  const rules = waiting("data-draw");
  gsap.set(rules, { scaleX: 0, transformOrigin: "0 50%" });
  ScrollTrigger.batch(rules, { start: "top 92%", once: true, onEnter: (els) => gsap.to(els, { scaleX: 1, duration: 1.4, ease: "expo.out", stagger: 0.09, overwrite: true }) });

  for (const el of waiting("data-clip")) {
    gsap.fromTo(el, { clipPath: "inset(100% 0% 0% 0%)", y: 40 }, { clipPath: "inset(0% 0% 0% 0%)", y: 0, duration: 1.3, ease: "expo.out", clearProps: "clipPath", scrollTrigger: { trigger: el, start: "top 92%", once: true } });
  }
}

// A fine pointer: the calls to action lean towards it and spring back.
function pointer(gsap) {
  let held = null;
  const release = () => {
    if (held) gsap.to(held, { x: 0, y: 0, duration: 0.9, ease: "elastic.out(1, 0.45)", overwrite: true });
    held = null;
  };
  const onMove = (e) => {
    if (e.pointerType === "touch") return;
    const target = e.target instanceof Element ? e.target : null;
    const next = target ? target.closest("[data-magnetic]") : null;
    if (next !== held) release();
    held = next;
    if (!held) return;
    const box = held.getBoundingClientRect();
    const dx = e.clientX - (box.left + box.width / 2 - Number(gsap.getProperty(held, "x")));
    const dy = e.clientY - (box.top + box.height / 2 - Number(gsap.getProperty(held, "y")));
    gsap.to(held, { x: dx * 0.3, y: dy * 0.4, duration: 0.5, ease: "power3.out", overwrite: true });
  };
  document.addEventListener("pointermove", onMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", release);
  return () => {
    document.removeEventListener("pointermove", onMove);
    document.documentElement.removeEventListener("pointerleave", release);
    release();
  };
}
