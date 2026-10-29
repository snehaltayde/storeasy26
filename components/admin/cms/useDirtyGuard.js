"use client";

import { useEffect } from "react";

// S52: unsaved-changes guard. The browser's beforeunload covers tab close,
// reload and hard navigation; in-app <Link> navigations don't fire it, so
// editors ALSO confirm their own Cancel/Back actions via dialog.
export function useDirtyGuard(dirty) {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = ""; // required for the browser prompt
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
