"use client"

import * as React from "react"

// docs/UI.md "Shell": the sidebar is a sheet below 768px and icons below 1024px.
const MOBILE_BREAKPOINT = 768
const COMPACT_BREAKPOINT = 1024

// true while the viewport is narrower than `px` (false on the server and the first render)
export function useIsBelow(px) {
  const [below, setBelow] = React.useState(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${px - 1}px)`)
    const onChange = () => setBelow(mql.matches)
    mql.addEventListener("change", onChange)
    setBelow(mql.matches)
    return () => mql.removeEventListener("change", onChange)
  }, [px])

  return !!below
}

export function useIsMobile() {
  return useIsBelow(MOBILE_BREAKPOINT)
}

export function useIsCompact() {
  return useIsBelow(COMPACT_BREAKPOINT)
}
