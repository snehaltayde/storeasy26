"use client";

import { useEffect } from "react";

// Designer ⇄ preview bridge (S54 / audit slice 3). Rendered ONLY in preview
// mode (cookie-gated, see the storefront layout) — public pages never ship
// it. It stays INERT until the embedding console performs a same-origin
// handshake, so a plain draft preview browses normally; inside the designer,
// clicking a section SELECTS it instead of navigating.
//
// Protocol (window.postMessage, same-origin enforced):
//   parent → "storeasy:designer:hello"            activate select mode
//   parent → {type:"storeasy:sec:highlight", id}  outline + scroll to a section
//   parent → {type:"storeasy:refresh"}            reload (after a draft save)
//   child  → {type:"storeasy:sec:click", id}      a [data-sec] was clicked
//   child  → {type:"storeasy:ready"}              bridge mounted (handshake reply)

const OUTLINE_ID = "storeasy-designer-outline";

export default function PreviewBridge() {
  useEffect(() => {
    if (window.parent === window) return; // not embedded → stay inert
    let active = false;
    const origin = window.location.origin;

    const style = document.createElement("style");
    style.id = OUTLINE_ID;
    style.textContent = `
      [data-sec].storeasy-selected { outline: 2px solid #0ea5e9; outline-offset: 4px; border-radius: 4px; }
      body.storeasy-designing [data-sec] { cursor: pointer; }
      body.storeasy-designing [data-sec]:hover { outline: 2px dashed #0ea5e9aa; outline-offset: 4px; border-radius: 4px; }
    `;

    const select = (id) => {
      document.querySelectorAll("[data-sec].storeasy-selected").forEach((el) => el.classList.remove("storeasy-selected"));
      const el = id && document.querySelector(`[data-sec="${CSS.escape(id)}"]`);
      if (el) {
        el.classList.add("storeasy-selected");
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };

    const onClick = (e) => {
      if (!active) return;
      const target = e.target.closest("[data-sec]");
      if (!target) return;
      // selecting, not shopping: swallow the navigation
      e.preventDefault();
      e.stopPropagation();
      select(target.getAttribute("data-sec"));
      window.parent.postMessage({ type: "storeasy:sec:click", id: target.getAttribute("data-sec") }, origin);
    };

    const onMessage = (e) => {
      if (e.origin !== origin) return; // same-origin console only
      const msg = e.data;
      if (msg === "storeasy:designer:hello") {
        active = true;
        document.head.appendChild(style);
        document.body.classList.add("storeasy-designing");
        window.parent.postMessage({ type: "storeasy:ready" }, origin);
        return;
      }
      if (!active || !msg || typeof msg !== "object") return;
      if (msg.type === "storeasy:sec:highlight") select(msg.id);
      if (msg.type === "storeasy:refresh") window.location.reload();
    };

    window.addEventListener("message", onMessage);
    document.addEventListener("click", onClick, true);
    // announce in case the parent's hello raced our mount
    window.parent.postMessage({ type: "storeasy:ready" }, origin);
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("click", onClick, true);
      style.remove();
      document.body.classList.remove("storeasy-designing");
    };
  }, []);
  return null;
}
