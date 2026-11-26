"use client";

import { useEffect, useRef } from "react";

// The landing page's motion island. It holds no words and draws one thing, the
// pointer's companion disc. The page it finds is already finished
// (components/site/landing.css draws every final state); this rewinds those
// states and plays them against the scroll, through the markup's attributes:
//   data-scene="bill"   the receipt: each line is struck and answered, the
//                       stamp lands, the total arrives. From 1024px the stage
//                       is pinned and the scroll scrubs it, then the lines fold
//                       into the total; below that it plays once, in place
//   data-scene="rail"   from 768px, pinned and slid sideways by the scroll
//   data-path           the speed section's line, drawn as it arrives
//   data-split          a heading whose lines rise out of their masks
//   data-reveal         a block that fades up; data-draw a rule that draws;
//                       data-clip a block wiped in from its lower edge
//   data-magnetic       a button that leans towards a fine pointer
// GSAP (ScrollTrigger, SplitText) and Lenis are fetched here and nowhere else,
// after the page is up, so no store page and no other marketing page carries
// them (docs/DECISIONS.md). Under prefers-reduced-motion nothing is fetched
// and nothing starts.
export default function MotionRoot() {
  const disc = useRef(null);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const home = document.querySelector("[data-mk-home]");
    if (!home) return undefined;
    let gone = false;
    let stop = () => {};
    Promise.all([import("gsap"), import("gsap/ScrollTrigger"), import("gsap/SplitText"), import("lenis")])
      .then(([{ gsap }, { ScrollTrigger }, { SplitText }, { default: Lenis }]) => {
        if (!gone) stop = start({ gsap, ScrollTrigger, SplitText, Lenis, home, disc: disc.current });
      })
      .catch(() => {}); // the libraries did not arrive: the page stays as drawn
    return () => {
      gone = true;
      stop();
    };
  }, []);
  return <div ref={disc} aria-hidden="true" className="mk-cursor" />;
}

function start({ gsap, ScrollTrigger, SplitText, Lenis, home, disc }) {
  gsap.registerPlugin(ScrollTrigger, SplitText);
  const head = document.querySelector("header")?.offsetHeight || 65;
  home.style.setProperty("--mk-head", `${head}px`);

  // Inertial scrolling, on GSAP's clock so the scrubbed scenes stay in step.
  const lenis = new Lenis({ lerp: 0.11, anchors: true, autoRaf: false }); // anchors land by each section's scroll-margin
  lenis.on("scroll", ScrollTrigger.update);
  const tick = (time) => lenis.raf(time * 1000);
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);

  const mm = gsap.matchMedia();
  mm.add({ any: "(min-width: 1px)", desk: "(min-width: 1024px) and (min-height: 560px)", mid: "(min-width: 768px)", fine: "(hover: hover) and (pointer: fine)" }, (ctx) => {
    const { desk, mid, fine } = ctx.conditions;
    home.dataset.motion = "on";
    home.dataset.pin = [desk && "bill", mid && "rail"].filter(Boolean).join(" ");
    const undo = [bill(gsap, ScrollTrigger, home, head, desk), mid && rail(gsap, ScrollTrigger, home, head), path(gsap, home), reveals(gsap, ScrollTrigger, SplitText, home), fine && pointer(gsap, disc)];
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
    home.style.removeProperty("--mk-head");
  };
}

// The receipt. Pinned: one scrubbed timeline, about half a step of scroll for
// each line, then the fold. Not pinned: the same strikes, played once.
// Opacity, never visibility: a screen reader reads the whole receipt at any
// point of the scroll.
function bill(gsap, ScrollTrigger, home, head, pinned) {
  const scene = home.querySelector('[data-scene="bill"]');
  const receipt = scene.querySelector(".mk-receipt");
  const paper = scene.querySelector("[data-paper]");
  const lines = [...scene.querySelectorAll("[data-line]")];
  const step = pinned ? 0.5 : 0.14;
  const tl = gsap.timeline({
    defaults: { ease: "power2.out" },
    scrollTrigger: pinned ? { trigger: scene, start: `top ${head}px`, end: "bottom bottom", scrub: 0.6, invalidateOnRefresh: true } : { trigger: paper, start: "top 70%", once: true },
  });
  // Pinned, the first line strikes itself once the receipt has landed, to show
  // what the scroll will do to the rest.
  const first = pinned ? gsap.timeline({ delay: 1.7, defaults: { ease: "power2.out" } }) : tl;
  lines.forEach((line, i) => {
    const on = i === 0 ? first : tl;
    const at = i === 0 ? 0 : (pinned ? i - 0.6 : i) * step;
    on.fromTo(line.querySelector("[data-strike]"), { "--s": 0, color: "#0b0656" }, { "--s": 1, color: "#676a8a", duration: 0.4, ease: "power2.inOut" }, at);
    on.from(line.querySelector("[data-built]"), { opacity: 0, x: -12, duration: 0.35 }, at + 0.16);
  });
  const done = lines.length * step;
  tl.from(scene.querySelector("[data-stamp]"), { opacity: 0, scale: 2.8, rotation: -30, duration: 0.4, ease: "power3.in" }, done);
  tl.from(scene.querySelector("[data-total]"), { opacity: 0, y: 16, duration: 0.45 }, done + 0.15);
  if (pinned) {
    // The list folds into its last line: the bill is now one plan.
    tl.to(lines, { height: 0, opacity: 0, duration: 0.9, ease: "power2.inOut", stagger: { each: 0.04, from: "end" } }, done + 1);
    tl.to(scene.querySelector("[data-cols]"), { height: 0, paddingBottom: 0, opacity: 0, duration: 0.6, ease: "power2.inOut" }, "<0.5");
    tl.to(paper, { rotation: -1.5, scale: 1.08, duration: 1.2, ease: "power2.inOut" }, done + 1);
    tl.to({}, { duration: 0.7 });
  }
  if (!pinned) return undefined;
  // Keep the whole slip inside a short pinned frame. Measured unfolded: a
  // refresh puts the timeline back where the scroll is.
  const fit = () => {
    tl.progress(0);
    receipt.style.removeProperty("--fit");
    const room = window.innerHeight - head - 40;
    if (paper.offsetHeight > room) receipt.style.setProperty("--fit", (room / paper.offsetHeight).toFixed(3));
  };
  fit();
  ScrollTrigger.addEventListener("refreshInit", fit);
  return () => {
    ScrollTrigger.removeEventListener("refreshInit", fit);
    receipt.style.removeProperty("--fit");
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
  gsap.to(row, { x: () => -run(), ease: "none", scrollTrigger: { ...scrollTrigger, scrub: 0.5 } });
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

// A fine pointer: the disc follows it, swells over anything that can be
// pressed, and the calls to action lean towards it and spring back.
function pointer(gsap, disc) {
  const x = gsap.quickTo(disc, "x", { duration: 0.35, ease: "power3.out" });
  const y = gsap.quickTo(disc, "y", { duration: 0.35, ease: "power3.out" });
  let held = null;
  const release = () => {
    if (held) gsap.to(held, { x: 0, y: 0, duration: 0.9, ease: "elastic.out(1, 0.45)", overwrite: true });
    held = null;
  };
  const onMove = (e) => {
    if (e.pointerType === "touch") return;
    x(e.clientX);
    y(e.clientY);
    disc.dataset.on = "";
    const target = e.target instanceof Element ? e.target : null;
    disc.dataset.over = !target ? "" : target.closest("input") ? "type" : target.closest("a, button, summary, select, label") ? "press" : "";
    const next = target ? target.closest("[data-magnetic]") : null;
    if (next !== held) release();
    held = next;
    if (!held) return;
    const box = held.getBoundingClientRect();
    const dx = e.clientX - (box.left + box.width / 2 - Number(gsap.getProperty(held, "x")));
    const dy = e.clientY - (box.top + box.height / 2 - Number(gsap.getProperty(held, "y")));
    gsap.to(held, { x: dx * 0.3, y: dy * 0.4, duration: 0.5, ease: "power3.out", overwrite: true });
  };
  const onLeave = () => {
    delete disc.dataset.on;
    release();
  };
  document.addEventListener("pointermove", onMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave);
  return () => {
    document.removeEventListener("pointermove", onMove);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    onLeave();
    delete disc.dataset.over;
  };
}
