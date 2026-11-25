import { CircleCheck, CircleX, LoaderCircle, TriangleAlert } from "lucide-react";
import { cn } from "@/components/ui/utils";
import { healthWords } from "./storesWords";

// A store's live health as an icon and plain words in the status colour
// (docs/UI.md "Stores (line 1)"). Not a pill: on the Stores list it sits next
// to the Status badge and must read differently at a glance, and its longest
// words ("Needs attention: sync failed, pushes to Shopify failing") wrap
// instead of being clipped. `health` undefined is "Checking…". The element
// carrying data-health holds exactly the label's text (the drill reads it).
const LOOK = {
  success: { Icon: CircleCheck, text: "text-success" },
  warning: { Icon: TriangleAlert, text: "text-warning-text" },
  danger: { Icon: CircleX, text: "text-destructive" },
  muted: { Icon: LoaderCircle, text: "text-muted-foreground" },
};

export default function HealthMark({ health, size = "sm", className }) {
  const { label, tone } = healthWords(health);
  const { Icon, text } = LOOK[tone] || LOOK.danger;
  const pending = !health;
  return (
    <span className={cn("inline-flex items-start gap-1.5", text, size === "lg" ? "text-base font-medium" : "text-[0.8125rem]", className)}>
      <Icon aria-hidden className={cn("shrink-0", size === "lg" ? "mt-0.5 size-5" : "mt-px size-4", pending && "motion-safe:animate-spin")} />
      <span data-health={health?.state || "pending"} className="min-w-0 leading-snug whitespace-normal">
        {label}
      </span>
    </span>
  );
}
