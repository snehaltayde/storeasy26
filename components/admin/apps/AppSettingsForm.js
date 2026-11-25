"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RoleGate } from "@/components/kit/role-gate";
import { roleAllows } from "@/lib/platform/authz";
import { useToast } from "@/components/kit/toast";
import { AppRefusal } from "@/components/admin/apps/AppRefusal";
import { NO_MANAGE, postApp } from "@/components/admin/apps/app-words";

// An app's settings form, built from its manifest's settings (lib/plugins/
// manifest.js): text, number, boolean (a switch), choice (a select), list
// (rows of those, "Add", a remove button per row, up to its max) and secret.
// A secret is never shown: a "Saved" or "Not set" badge and "Replace" (or
// "Add"), which opens an empty password field with Cancel; "Remove" clears a
// saved one. The whole form saves at once (POST /api/admin/apps/[id]
// { settings }); the Save / Discard bar sticks to the bottom only while
// something changed; each field's problem shows under it, the route's
// sentence above the bar, and nothing typed is lost. Roles without
// apps.manage see every field disabled and no Save.
//   install, settings (manifest settings), role, onSaved(install)
const labelOf = (s) => s.label || s.key.charAt(0).toUpperCase() + s.key.slice(1).replace(/_/g, " ");
const blankItem = (s) => Object.fromEntries(s.fields.map((f) => [f.key, f.kind === "boolean" ? false : f.kind === "choice" ? f.options[0] : f.kind === "number" ? null : ""]));
const plainOf = (settings, values) => Object.fromEntries(settings.filter((s) => s.kind !== "secret").map((s) => [s.key, values[s.key] ?? (s.kind === "list" ? [] : s.kind === "boolean" ? false : s.kind === "number" ? null : "")]));

function FieldError({ id, children }) {
  if (!children) return null;
  return (
    <p id={id} className="text-xs text-destructive" data-field-error>
      {children}
    </p>
  );
}

function PlainControl({ s, id, value, onChange, disabled, error }) {
  const describedBy = error ? `${id}-error` : undefined;
  if (s.kind === "boolean") {
    return <Switch id={id} checked={Boolean(value)} onCheckedChange={onChange} disabled={disabled} aria-describedby={describedBy} aria-invalid={Boolean(error)} />;
  }
  if (s.kind === "choice") {
    return (
      <Select value={value ?? undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full" aria-describedby={describedBy} aria-invalid={Boolean(error)}>
          <SelectValue placeholder="Choose one" />
        </SelectTrigger>
        <SelectContent>
          {s.options.map((o) => (
            <SelectItem key={o} value={o}>
              {o.charAt(0).toUpperCase() + o.slice(1)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (s.kind === "number") {
    return (
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={s.min}
        max={s.max}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={Boolean(error)}
        className="font-mono"
      />
    );
  }
  return <Input id={id} value={value ?? ""} maxLength={s.max} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-describedby={describedBy} aria-invalid={Boolean(error)} />;
}

export function AppSettingsForm({ install, settings, role, onSaved }) {
  const toast = useToast();
  const canManage = roleAllows(role, "apps.manage");
  const [values, setValues] = useState(() => plainOf(settings, install.settings));
  const [secrets, setSecrets] = useState({}); // key -> { editing, value } | { clear: true }
  const [errors, setErrors] = useState({});
  const [refusal, setRefusal] = useState(null);
  const [busy, setBusy] = useState(false);
  const saved = useMemo(() => JSON.stringify(plainOf(settings, install.settings)), [settings, install.settings]);
  const dirty = JSON.stringify(values) !== saved || Object.values(secrets).some((x) => x.clear || (x.editing && x.value));

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (!settings.length) {
    return (
      <Card data-apps="settings">
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>This app has nothing to set up.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const set = (key, v) => setValues((x) => ({ ...x, [key]: v }));
  const setItem = (key, i, field, v) => setValues((x) => ({ ...x, [key]: x[key].map((it, j) => (j === i ? { ...it, [field]: v } : it)) }));
  const discard = () => {
    setValues(plainOf(settings, install.settings));
    setSecrets({});
    setErrors({});
    setRefusal(null);
  };

  async function save(e) {
    e.preventDefault();
    if (!canManage) return;
    setBusy(true);
    setRefusal(null);
    const body = { ...values };
    for (const s of settings) {
      if (s.kind !== "secret") continue;
      const x = secrets[s.key];
      if (x?.clear) body[s.key] = null;
      else if (x?.editing && x.value) body[s.key] = x.value;
    }
    const r = await postApp(`apps/${encodeURIComponent(install.id)}`, { settings: body });
    setBusy(false);
    if (!r.ok) {
      setErrors(r.errors || {});
      setRefusal(r.error);
      return;
    }
    setErrors({});
    setSecrets({});
    setValues(plainOf(settings, r.install.settings));
    onSaved(r.install);
    toast.success("Settings saved.");
  }

  return (
    <Card data-apps="settings">
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>{canManage ? "Changes apply as soon as you save." : NO_MANAGE}</CardDescription>
      </CardHeader>
      <CardContent>
        <form id="app-settings" onSubmit={save} className="space-y-6" noValidate>
          <AppRefusal>{errors._ || null}</AppRefusal>
          {settings.map((s) => {
            const id = `app-setting-${s.key}`;
            if (s.kind === "secret") {
              const isSet = Boolean(install.secretsSet?.[s.key]);
              const x = secrets[s.key] || {};
              return (
                <div key={s.key} className="space-y-2" data-setting={s.key}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor={x.editing ? id : undefined}>{labelOf(s)}</Label>
                    <Badge variant={x.clear ? "warning" : isSet ? "success" : "muted"} data-secret-state={x.clear ? "removing" : isSet ? "set" : "not-set"}>
                      {x.clear ? "Removed when you save" : isSet ? "Saved" : "Not set"}
                    </Badge>
                  </div>
                  {s.help && <p className="text-xs text-muted-foreground">{s.help}</p>}
                  {x.editing ? (
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input id={id} type="password" autoComplete="off" value={x.value || ""} maxLength={s.max ?? 500} onChange={(e) => setSecrets((m) => ({ ...m, [s.key]: { editing: true, value: e.target.value } }))} aria-describedby={errors[s.key] ? `${id}-error` : undefined} aria-invalid={Boolean(errors[s.key])} />
                      <Button type="button" variant="outline" onClick={() => setSecrets((m) => ({ ...m, [s.key]: {} }))}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
                        <Button type="button" variant="outline" size="sm" data-secret-edit={s.key} onClick={() => setSecrets((m) => ({ ...m, [s.key]: { editing: true, value: "" } }))}>
                          {isSet ? "Replace" : "Add"}
                        </Button>
                      </RoleGate>
                      {isSet && !x.clear && (
                        <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
                          <Button type="button" variant="ghost" size="sm" data-secret-clear={s.key} onClick={() => setSecrets((m) => ({ ...m, [s.key]: { clear: true } }))}>
                            Remove
                          </Button>
                        </RoleGate>
                      )}
                    </div>
                  )}
                  <FieldError id={`${id}-error`}>{errors[s.key]}</FieldError>
                </div>
              );
            }
            if (s.kind === "list") {
              const items = values[s.key] || [];
              return (
                <fieldset key={s.key} className="space-y-3" data-setting={s.key}>
                  <legend className="text-sm font-medium text-foreground">{labelOf(s)}</legend>
                  <p className="text-xs text-muted-foreground">{`${items.length} of ${s.max}`}</p>
                  <FieldError id={`${id}-error`}>{errors[s.key]}</FieldError>
                  <ol className="space-y-3">
                    {items.map((item, i) => (
                      <li key={i} className="rounded-md border border-border p-3" data-list-item={i}>
                        <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-start">
                          {s.fields.map((f) => {
                            const fid = `${id}-${i}-${f.key}`;
                            const err = errors[`${s.key}.${i}.${f.key}`];
                            return (
                              <div key={f.key} className="space-y-1">
                                <Label htmlFor={fid}>{labelOf(f)}</Label>
                                <PlainControl s={f} id={fid} value={item[f.key]} onChange={(v) => setItem(s.key, i, f.key, v)} disabled={!canManage} error={err} />
                                <FieldError id={`${fid}-error`}>{err}</FieldError>
                              </div>
                            );
                          })}
                          <RoleGate role={role} action="apps.manage" reason={NO_MANAGE} mode="hide">
                            <Button type="button" variant="ghost" size="icon" className="sm:mt-6" aria-label={`Remove ${labelOf(s).toLowerCase()} ${i + 1}`} onClick={() => set(s.key, items.filter((_, j) => j !== i))}>
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </RoleGate>
                        </div>
                        <FieldError id={`${id}-${i}-error`}>{errors[`${s.key}.${i}`]}</FieldError>
                      </li>
                    ))}
                  </ol>
                  {canManage && items.length < s.max && (
                    <Button type="button" variant="outline" size="sm" data-list-add={s.key} onClick={() => set(s.key, [...items, blankItem(s)])}>
                      <Plus aria-hidden="true" />
                      Add
                    </Button>
                  )}
                </fieldset>
              );
            }
            return (
              <div key={s.key} className={s.kind === "boolean" ? "flex items-center justify-between gap-4" : "space-y-1"} data-setting={s.key}>
                <Label htmlFor={id}>{labelOf(s)}</Label>
                {s.help && <p className="text-xs text-muted-foreground">{s.help}</p>}
                <PlainControl s={s} id={id} value={values[s.key]} onChange={(v) => set(s.key, v)} disabled={!canManage} error={errors[s.key]} />
                <FieldError id={`${id}-error`}>{errors[s.key]}</FieldError>
              </div>
            );
          })}
          {canManage && dirty && (
            <div className="sticky bottom-0 -mx-6 space-y-3 border-t border-border bg-card px-6 py-3" data-apps="save-bar">
              <AppRefusal>{refusal && !errors._ ? refusal : null}</AppRefusal>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={discard} disabled={busy}>
                  Discard
                </Button>
                <Button type="submit" disabled={busy} data-apps="save-settings">
                  {busy ? "Saving…" : "Save settings"}
                </Button>
              </div>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
