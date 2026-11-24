// cn: class names for the console components (components/ui). clsx joins
// them; tailwind-merge drops the earlier of two conflicting utilities. Our
// theme adds rounded-ctl / rounded-card and shadow-card / shadow-overlay
// (app/console.css), so tailwind-merge is told they are radius and shadow
// values; without it "rounded-md rounded-card" keeps both and
// a shadow-overlay before a stock shadow keeps both (scripts/test-console-ui.js).
import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: { theme: { radius: ["ctl", "card"], shadow: ["card", "overlay"] } },
});

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
