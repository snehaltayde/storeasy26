"use client";

import { useEffect } from "react";

// Register the PWA service worker in production only — registering in dev
// causes stale-asset caching headaches while iterating.
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator &&
      process.env.NODE_ENV === "production"
    ) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
