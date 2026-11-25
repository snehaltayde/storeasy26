import { cn } from "@/components/ui/utils";

// A row's own action in the team tables: an icon and its words from 1280px up;
// narrower, the icon alone (the words stay in aria-label and title), so a
// row's actions fit beside the name. 40px tall on touch. The page keeps a
// plain <Button> as RoleGate's child (test:console-kit) and spreads these:
//   <Button {...rowAction("Remove", { danger: true })}><RowActionBody icon={UserMinus}>Remove</RowActionBody></Button>
export function rowAction(label, { danger = false } = {}) {
  return {
    type: "button",
    variant: "ghost",
    size: "sm",
    "aria-label": label,
    title: label,
    className: cn("pointer-coarse:h-10 pointer-coarse:min-w-10", danger && "text-destructive hover:text-destructive"),
  };
}

export function RowActionBody({ icon: Icon, children }) {
  return (
    <>
      <Icon aria-hidden="true" />
      <span aria-hidden="true" className="hidden whitespace-nowrap xl:inline">
        {children}
      </span>
    </>
  );
}
