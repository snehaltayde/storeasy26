import { cn } from "@/components/ui/utils"

function Skeleton({
  className,
  ...props
}) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md motion-reduce:animate-none bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
