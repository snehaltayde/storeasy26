"use client"

import * as React from "react"
import { cn } from "@/components/ui/utils"
import { Progress as ProgressPrimitive } from "radix-ui"

// shadcn/ui Progress (radix base), restyled to docs/UI.md. `value` null (or
// left out) is indeterminate: Radix then leaves aria-valuenow off and sets
// data-state="indeterminate"; the bar shows a pulsing third, which stands
// still under reduced motion.
function Progress({ className, value = null, ...props }) {
  const known = typeof value === "number" && Number.isFinite(value)
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={known ? value : null}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full rounded-full bg-primary",
          known ? "w-full motion-safe:transition-transform" : "w-1/3 opacity-60 motion-safe:animate-pulse"
        )}
        style={known ? { transform: `translateX(-${100 - Math.min(100, Math.max(0, value))}%)` } : undefined}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
