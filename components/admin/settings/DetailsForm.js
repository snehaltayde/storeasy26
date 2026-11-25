"use client";

import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/admin/settings/SecretField";
import { SaveBar, ReadOnlyNote, useSettingsSection } from "@/components/admin/settings/SaveBar";
import { changedIdentity } from "@/lib/admin/settings";

// Settings → Details (Phase 2 line 7): the store's name, address, contact and
// brand words; the domains and the Shopify store read-only (operators claim
// domains); the sign-in password row as before. Saves { identity } and, only
// when typed, admin_password.
//   initial: { readOnly, identity, domains, shopify } from settingsView
const IDENTITY = ["name", "site_url", "support_email", "support_phone", "title", "tagline", "footer_tagline", "logo_text1", "logo_text2", "legal_name"];
const toState = (v) => ({ identity: Object.fromEntries(IDENTITY.map((k) => [k, v.identity?.[k] ?? ""])), adminPassword: "" });
// only what changed since the tab loaded (changedIdentity): a stale tab can't undo a newer save
const toBody = (s, view) => ({ identity: changedIdentity(s.identity, toState(view).identity), ...(s.adminPassword ? { admin_password: s.adminPassword } : {}) });

const FIELDS = [
  { key: "name", label: "Store name", hint: "Shown across your storefront, emails and receipts." },
  { key: "site_url", label: "Store address", hint: "The web address shoppers use, like https://shop.yourbrand.in. Links and the sitemap use it.", placeholder: "https://" },
  { key: "support_email", label: "Support email", hint: "Shoppers see it on the contact page and in the footer.", type: "email" },
  { key: "support_phone", label: "Support phone", type: "tel" },
  { key: "title", label: "Site title", hint: "The browser tab and search results." },
  { key: "tagline", label: "Tagline", hint: "The default description for search results and the home page." },
  { key: "footer_tagline", label: "Footer tagline" },
  { key: "legal_name", label: "Legal name", hint: "Shown in the footer and on your policy pages." },
];

export function DetailsForm({ initial, role }) {
  const form = useSettingsSection({ initial, toState, toBody });
  const { state, setState, view, readOnly } = form;
  const set = (k) => (e) => setState((s) => ({ ...s, identity: { ...s.identity, [k]: e.target.value } }));
  const domains = view.domains || [];
  return (
    <form onSubmit={form.save} noValidate className="space-y-4" data-settings-tab="details">
      <ReadOnlyNote form={form} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Your store</CardTitle>
          <CardDescription>Changes show on your storefront within a minute, with no publish.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {FIELDS.map((f) => (
            <Field key={f.key} id={`st-${f.key}`} label={f.label} hint={f.hint}>
              <Input
                id={`st-${f.key}`}
                type={f.type || "text"}
                placeholder={f.placeholder}
                disabled={readOnly}
                value={state.identity[f.key]}
                onChange={set(f.key)}
                aria-describedby={f.hint ? `st-${f.key}-hint` : undefined}
              />
            </Field>
          ))}
          <Field id="st-logo_text1" label="Logo text" hint="Used when there is no picture logo (set it in onboarding's Brand step). The second part shows in your accent colour.">
            <div className="flex gap-2">
              <Input
                id="st-logo_text1"
                aria-label="Logo text, first part"
                disabled={readOnly}
                value={state.identity.logo_text1}
                onChange={set("logo_text1")}
                aria-describedby="st-logo_text1-hint"
              />
              <Input aria-label="Logo text, accent part" disabled={readOnly} value={state.identity.logo_text2} onChange={set("logo_text2")} />
            </div>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Addresses and Shopify</CardTitle>
          <CardDescription>Storeasy's team adds domains for you; you check them in Domains and SEO.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Domains</p>
            {domains.length ? (
              <ul className="space-y-1 font-mono text-[0.8125rem] text-foreground">
                {domains.map((d) => (
                  <li key={d} className="truncate" title={d}>
                    {d}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No domain yet.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Shopify store</p>
            <p className="font-mono text-[0.8125rem]">{view.shopify?.store_domain || "Not connected"}</p>
            <p className="text-xs text-muted-foreground">
              {view.shopify?.uninstalled_at
                ? "The Storeasy app was removed from Shopify. Reconnect it from onboarding step 1."
                : view.shopify?.connected
                  ? "Connected."
                  : "Connect it from onboarding step 1."}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Setup sign-in password</CardTitle>
          <CardDescription>The store's first password, from before team accounts. Changing it signs out every other session that used it.</CardDescription>
        </CardHeader>
        <CardContent className="max-w-sm">
          <Field id="st-admin-password" label="New password" hint="At least 8 characters. Leave it empty to keep the current one.">
            <Input
              id="st-admin-password"
              type="password"
              autoComplete="new-password"
              disabled={readOnly}
              value={state.adminPassword}
              onChange={(e) => setState((s) => ({ ...s, adminPassword: e.target.value }))}
              aria-describedby="st-admin-password-hint"
            />
          </Field>
        </CardContent>
      </Card>

      <SaveBar form={form} role={role} label="Save details" />
    </form>
  );
}
