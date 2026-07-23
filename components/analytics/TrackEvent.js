"use client";

import { useEffect, useRef } from "react";
import { track } from "@/lib/track/client";

// Declarative page-view events: server components render
//   <TrackEvent name="view_item" data={{ value, currency, items }} />
// and the event fires once on mount (strict-mode double-effect guarded).
export default function TrackEvent({ name, data }) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    track(name, data || {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
