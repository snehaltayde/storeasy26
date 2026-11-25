import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

// A row's own action in the team tables: an icon and its words from 1280px up;
// narrower, the icon alone (the words stay in aria-label and title), so a row's actions fit beside the name. 40px tall on touch.
//   icon: a lucide component; children: the words; danger: the red tone
export function RowAction({ icon: Icon, children, danger = false, className, ...rest }) {
  return (
    <Button type="button" variant="ghost" size="sm" aria-label={children} title={children} className={cn("pointer-coarse:h-10 pointer-coarse:min-w-10", danger && "text-destructive hover:text-destructive", className)} {...rest}>
      <Icon aria-hidden="true" />
      <span aria-hidden="true" className="hidden whitespace-nowrap xl:inline">
        {children}
      </span>
    </Button>
  );
}
