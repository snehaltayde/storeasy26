"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

// A value shown whole in a mono box with a Copy button (Phase 3 line 0; the
// operator sign-in's authenticator secret is its first user). When the
// clipboard is refused, the value is selected instead and the line under it
// says to copy it by hand. label names the value for screen readers
// ("the authenticator key"); id goes on the value itself.
export function CopyButton({ value, label, id, className }) {
  const [state, setState] = useState("idle"); // idle | copied | failed
  const ref = useRef(null);
  const reset = useRef(null);
  useEffect(() => () => clearTimeout(reset.current), []);
  async function copy() {
    clearTimeout(reset.current);
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      const r = document.createRange();
      r.selectNodeContents(ref.current);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(r);
      setState("failed");
    }
    reset.current = setTimeout(() => setState("idle"), 2500);
  }
  return (
    <div data-kit="copy" className={className}>
      <div className="flex items-stretch overflow-hidden rounded-md border border-border bg-muted">
        <code ref={ref} id={id} className="min-w-0 flex-1 px-2.5 py-2 font-mono text-[0.8125rem] break-all select-all">
          {value}
        </code>
        <Button type="button" variant="ghost" onClick={copy} className="h-auto shrink-0 rounded-none border-l border-border px-3" aria-label={state === "copied" ? "Copied" : `Copy ${label}`}>
          {state === "copied" ? <Check aria-hidden className="text-success" /> : <Copy aria-hidden />}
          <span aria-hidden>{state === "copied" ? "Copied" : "Copy"}</span>
        </Button>
      </div>
      <p role="status" className={cn("mt-1.5 text-[0.8125rem]", state === "failed" ? "text-destructive" : "text-muted-foreground")}>
        {state === "failed" ? "Couldn't copy. It's selected: press Ctrl+C (⌘C on a Mac)." : state === "copied" ? <span className="sr-only">Copied</span> : null}
      </p>
    </div>
  );
}
