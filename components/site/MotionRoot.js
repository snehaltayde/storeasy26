"use client";

import { useEffect } from "react";

// The landing page's motion island: draws nothing, holds no words. It turns on
// four behaviours that the markup opts into with data attributes, and does
// nothing at all under prefers-reduced-motion (app/marketing.css then shows
// every element in its final state):
//   data-reveal     fades in once when it scrolls into view; only elements
//                   still below the fold at start are hidden, so nothing flashes
//   data-parallax   a number: how far the layer drifts against the scroll
//   data-magnetic   a button that leans towards a fine pointer
//   data-spot       a card whose light follows the pointer (--mx, --my)
export default function MotionRoot() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const wide = window.matchMedia("(min-width: 1024px)");
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");

    const revealed = [...document.querySelectorAll("[data-reveal]")];
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-reveal", "in");
          io.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.06 },
    );
    const fold = window.innerHeight * 0.92;
    for (const el of revealed) {
      if (el.getBoundingClientRect().top <= fold) continue;
      el.setAttribute("data-reveal", "pending");
      io.observe(el);
    }

    const layers = [...document.querySelectorAll("[data-parallax]")].map((el) => ({ el, k: Number(el.dataset.parallax) || 0 }));
    let queued = 0;
    const paint = () => {
      queued = 0;
      const vh = window.innerHeight;
      for (const layer of layers) {
        if (!wide.matches) {
          layer.el.style.transform = "";
          continue;
        }
        // the parent never moves, so reading it can't feed back into the drift
        const box = layer.el.parentElement.getBoundingClientRect();
        if (box.bottom + 300 >= 0 && vh + 300 >= box.top) {
          const y = (box.top + box.height / 2 - vh / 2) * layer.k;
          layer.el.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`;
        }
      }
    };
    const onScroll = () => {
      if (!queued) queued = requestAnimationFrame(paint);
    };
    if (layers.length) {
      paint();
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll, { passive: true });
    }

    let magnet = null;
    const release = () => {
      if (magnet) magnet.style.transform = "";
      magnet = null;
    };
    const onMove = (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const spot = target ? target.closest("[data-spot]") : null;
      if (spot) {
        const r = spot.getBoundingClientRect();
        spot.style.setProperty("--mx", `${Math.round(e.clientX - r.left)}px`);
        spot.style.setProperty("--my", `${Math.round(e.clientY - r.top)}px`);
      }
      if (!fine.matches) return;
      const next = target ? target.closest("[data-magnetic]") : null;
      if (next !== magnet) release();
      magnet = next;
      if (magnet) {
        const r = magnet.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) * 0.2;
        const dy = (e.clientY - (r.top + r.height / 2)) * 0.28;
        magnet.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
      }
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", release);

    return () => {
      io.disconnect();
      for (const el of revealed) el.setAttribute("data-reveal", "");
      for (const layer of layers) layer.el.style.transform = "";
      if (queued) cancelAnimationFrame(queued);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", release);
      release();
    };
  }, []);
  return null;
}
