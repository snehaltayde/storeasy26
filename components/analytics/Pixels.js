"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { pixelsAllowed } from "@/lib/track/no-pixels";
import { readConsentCookie, parseConsent } from "@/lib/track/names";

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
// S24 quirk fix: ids arrive as props from the layout's TENANT-scoped pass —
// a visitor on tenant A must never load tenant B's (or the env default's)
// pixels; a tenant without ids simply loads nothing.
export default function Pixels({ ga4Id = "", metaPixelId = "" }) {
  const loadedGa = useRef(false);
  const loadedMeta = useRef(false);
  // Phase 9 line 1: never on a page whose address carries a signed token (/reviews/*)
  const allowed = pixelsAllowed(usePathname());
  useEffect(() => {
    if (!allowed) return undefined;
    const maybeLoad = () => {
      // S33 (SF24): PER-PURPOSE loading — analytics consent gates gtag,
      // marketing consent gates the Meta pixel. Withdrawal reloads the page
      // (banner), so a revoked purpose's tag never comes back.
      const c = parseConsent(readConsentCookie());
      if (c.analytics && !loadedGa.current) {
        loadedGa.current = true;
        loadGtag(ga4Id);
      }
      if (c.marketing && !loadedMeta.current) {
        loadedMeta.current = true;
        loadFbq(metaPixelId);
      }
    };
    maybeLoad();
    window.addEventListener("consent-granted", maybeLoad);
    return () => window.removeEventListener("consent-granted", maybeLoad);
  }, [ga4Id, metaPixelId, allowed]);
  return null;
}
