"use client";

// Edit a store's details (Phase 3 line 2), through the existing PATCH
// {update} (S51): name, domains, Shopify store domain and app client id and
// secret, order id prefix and support email. Only changed fields are sent;
// the client secret is write-only (empty keeps it). A server error naming a
// field shows under that field.
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { storeApi } from "./lifecycleWords";

const FIELDS = [
  { key: "name", label: "Store name", group: "store" },
  { key: "domains", label: "Domains", hint: "One host per line, e.g. pavos.in. Each must not belong to another store.", area: true, group: "store" },
  { key: "shop_domain", label: "Shopify store domain", hint: "Looks like x.myshopify.com.", group: "shopify" },
  { key: "client_id", label: "Shopify app client id", group: "shopify", mono: true },
  { key: "client_secret", label: "Shopify app client secret", secret: true, group: "shopify", mono: true },
  { key: "order_prefix", label: "Order id prefix", hint: "2 to 4 letters or digits, e.g. PAV.", group: "store", half: true, mono: true },
  { key: "support_email", label: "Support email", type: "email", group: "store", half: true },
];
const GROUPS = [
  { id: "store", legend: "Store", hint: "Shoppers see the name, domains and support email." },
  { id: "shopify", legend: "Shopify app", hint: "The app the catalog sync connects through." },
];

const initial = (d) => ({
  name: d.name || "",
  domains: (d.domains || []).join("\n"),
  shop_domain: d.shopDomain || "",
  client_id: d.clientId || "",
  client_secret: "",
  order_prefix: d.orderPrefix || "",
  support_email: d.supportEmail || "",
});

export default function EditStoreDialog({ store, details, open, onOpenChange, onDone }) {
  const [values, setValues] = useState(() => initial(details));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null); // { message, field }
  const start = initial(details);
  const changed = FIELDS.filter((f) => (f.secret ? values[f.key].trim() !== "" : values[f.key] !== start[f.key]));

  async function submit(e) {
    e.preventDefault();
    if (!changed.length || busy) return;
    setBusy(true);
    setError(null);
    const update = {};
    for (const f of changed) update[f.key] = f.key === "domains" ? values.domains.split(/[\s,]+/).filter(Boolean) : values[f.key];
    try {
      await storeApi(store.id, { body: { update } });
      onOpenChange(false);
      onDone(`Saved ${store.name}'s details.`);
    } catch (err) {
      setError({ message: err.message, field: err.field });
    } finally {
      setBusy(false);
    }
  }

  const field = (f) => {
    const bad = error?.field === f.key;
    const hint = f.secret ? (details.hasClientSecret ? "Set. Leave empty to keep it; values are never shown." : "Not set yet.") : f.hint;
    const describedBy = [hint && `edit-${f.key}-hint`, bad && `edit-${f.key}-error`].filter(Boolean).join(" ") || undefined;
    const props = {
      id: `edit-${f.key}`,
      value: values[f.key],
      onChange: (e) => setValues((v) => ({ ...v, [f.key]: e.target.value })),
      "aria-invalid": bad || undefined,
      "aria-describedby": describedBy,
    };
    return (
      <div key={f.key} className={f.half ? "space-y-1.5" : "space-y-1.5 sm:col-span-2"}>
        <Label htmlFor={`edit-${f.key}`}>{f.label}</Label>
        {f.area ? <Textarea rows={3} spellCheck={false} {...props} className="font-mono" /> : <Input type={f.secret ? "password" : f.type || "text"} autoComplete={f.secret ? "new-password" : "off"} spellCheck={f.mono ? false : undefined} {...props} className={f.mono ? "font-mono" : undefined} />}
        {hint && (
          <p id={`edit-${f.key}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
        {bad && (
          <p id={`edit-${f.key}-error`} className="text-xs text-destructive">
            {error.message}
          </p>
        )}
      </div>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        if (o) {
          setValues(initial(details));
          setError(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent data-dialog="edit-store" className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>Edit details</DialogTitle>
            <DialogDescription>Changes apply to {store.name} at once.</DialogDescription>
          </DialogHeader>
          {GROUPS.map((g) => (
            <fieldset key={g.id} className="border-t border-border pt-4 first-of-type:border-t-0 first-of-type:pt-0">
              <legend className="float-left w-full">
                <span className="block text-sm font-semibold">{g.legend}</span>
                <span className="mt-0.5 block text-[0.8125rem] text-muted-foreground">{g.hint}</span>
              </legend>
              <div className="clear-both grid gap-4 pt-3 sm:grid-cols-2">{FIELDS.filter((f) => f.group === g.id).map(field)}</div>
            </fieldset>
          ))}
          {error && !error.field && (
            <Alert variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="sticky -bottom-4 z-10 sm:-bottom-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!changed.length || busy} data-action="save-details">
              {busy ? "Saving…" : changed.length > 1 ? `Save ${changed.length} changes` : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
