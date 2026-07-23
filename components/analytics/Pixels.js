"use client";

import { useEffect, useRef } from "react";
import { readConsentCookie, isConsentGranted } from "@/lib/track/names";

const GA4_ID = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID || "";
const PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID || "";

function loadGtag(id) {
  if (!id || window.gtag) return;
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", id);
}

function loadFbq(id) {
  if (!id || window.fbq) return;
  /* eslint-disable */
  !(function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
    t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
  /* eslint-enable */
  window.fbq("init", id);
  window.fbq("track", "PageView");
}

// Loads gtag + the Meta pixel ONLY after DPDP consent is granted (never before —
// third-party tags are the definition of non-essential). Listens for the
// banner's grant so pixels light up without a reload.
export default function Pixels() {
  const loaded = useRef(false);
  useEffect(() => {
    const maybeLoad = () => {
      if (loaded.current) return;
      if (!isConsentGranted(readConsentCookie())) return;
      loaded.current = true;
      loadGtag(GA4_ID);
      loadFbq(PIXEL_ID);
    };
    maybeLoad();
    window.addEventListener("consent-granted", maybeLoad);
    return () => window.removeEventListener("consent-granted", maybeLoad);
  }, []);
  return null;
}
