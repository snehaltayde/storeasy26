"use client";

import { Children, cloneElement, isValidElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/components/ui/utils";
import { roleAllows } from "@/lib/platform/authz";

// A control the caller's role may not use (docs/UI.md "States", support role):
// hidden (mode "hide"), or shown disabled with the reason in a tooltip (mode
// "disable", the default). A disabled control is aria-disabled, not disabled,
// so it stays in the Tab order and the tooltip opens on focus; its clicks and
// Enter/Space are swallowed. The server refuses the write regardless: this
// only keeps the page from showing a button that will be refused.
//   role: the actor's role; action: the authz string (lib/platform/authz.js)
//   reason: the plain sentence the tooltip shows
//   children: exactly one element (Button, a link)
export function RoleGate({ role, action, reason, mode = "disable", children }) {
  if (roleAllows(role, action)) return children;
  if (mode === "hide") return null;
  const child = Children.only(children);
  if (!isValidElement(child)) return null;
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const gated = cloneElement(child, {
    "aria-disabled": true,
    "data-role-gate": "disabled",
    onClick: stop,
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") stop(e);
    },
    className: cn(child.props.className, "cursor-not-allowed opacity-50"),
  });
  return (
    <Tooltip>
      <TooltipTrigger asChild>{gated}</TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
