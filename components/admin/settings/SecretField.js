"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

// A write-only secret (Phase 2 line 7): the page only ever knows whether one
// is saved (the has_* flag), never its value. "Saved" or "Not set", and
// "Replace" (or "Add") opens an empty password field; leaving it empty keeps
// the saved one (buildSettingsPatch drops an empty secret). Cancel empties it.
export function SecretField({ id, label, isSet, value, onChange, disabled = false, hint = null }) {
  const [open, setOpen] = useState(false);
  const editing = open || Boolean(value);
  return (
    <div className="space-y-1.5" data-secret-field={id}>
      <div className="flex items-center gap-2">
        <Label htmlFor={editing ? id : undefined} id={`${id}-label`}>
          {label}
        </Label>
        <Badge variant={isSet ? "success" : "muted"}>{isSet ? "Saved" : "Not set"}</Badge>
      </div>
      {editing ? (
        <div className="flex gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            disabled={disabled}
            value={value}
            placeholder={isSet ? "Type the new value" : "Paste it here"}
            onChange={(e) => onChange(e.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" disabled={disabled} aria-describedby={`${id}-label`} onClick={() => setOpen(true)}>
          {isSet ? "Replace" : "Add"}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">{hint || (isSet ? "A saved value is never shown again, only replaced." : "It is never shown after you save it.")}</p>
    </div>
  );
}

// A labelled settings field: the control, then a hint, then this field's own
// error (aria-describedby ties both to the control). children: the control,
// with the same id as htmlFor.
export function Field({ id, label, hint = null, error = null, children, className = "" }) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// A native select styled like Input (the phone's own picker; no portal).
export const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-md border border-input bg-muted px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";
