"use client";

import { useEffect } from "react";

// Client-side error tracking (Session 17): window errors + unhandled promise
// rejections beacon to /api/errors. Session-deduped and capped so a render
// loop can't self-DDoS; the server fingerprints + throttles alerts again.
const seen = new Set();
const MAX_PER_SESSION = 10;

export function reportClientError({ name, message, stack, digest }) {
  if (typeof window === "undefined" || !message) return;
  const key = `${name}|${String(message).slice(0, 120)}`;
  if (seen.has(key) || seen.size >= MAX_PER_SESSION) return;
  seen.add(key);
  const body = JSON.stringify({
    name,
    message: String(message).slice(0, 500),
    stack: String(stack || "").slice(0, 2048),
    digest,
    url: window.location.href,
  });
  try {
    const ok = navigator.sendBeacon?.("/api/errors", new Blob([body], { type: "application/json" }));
    if (!ok) throw new Error("beacon refused");
  } catch {
    fetch("/api/errors", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  }
}

export default function ErrorReporter() {
  useEffect(() => {
    const onError = (e) =>
      reportClientError({
        name: e.error?.name || "Error",
        message: e.message || e.error?.message,
        stack: e.error?.stack,
      });
    const onRejection = (e) =>
      reportClientError({
        name: e.reason?.name || "UnhandledRejection",
        message: e.reason?.message || String(e.reason),
        stack: e.reason?.stack,
      });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
