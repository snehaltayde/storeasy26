"use client";

import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, SecretField } from "@/components/admin/settings/SecretField";
import { SaveBar, ReadOnlyNote, useSettingsSection } from "@/components/admin/settings/SaveBar";

// Settings → Tracking (Phase 2 line 7): the GA4 measurement id and API secret,
// the Meta pixel id, the Conversions API token and the test event code. The
// two secrets are write-only (SecretField: has_* flags only). Saves { tracking }.
//   initial: { readOnly, tracking } from settingsView
const toState = (v) => ({
  tracking: {
    ga4_measurement_id: v.tracking?.ga4_measurement_id || "",
    ga4_api_secret: "",
    meta_pixel_id: v.tracking?.meta_pixel_id || "",
    meta_capi_token: "",
    meta_test_event_code: v.tracking?.meta_test_event_code || "",
  },
});
const toBody = (s) => ({ tracking: s.tracking });

export function TrackingForm({ initial, role }) {
  const form = useSettingsSection({ initial, toState, toBody });
  const { state, setState, view, readOnly } = form;
  const t = state.tracking;
  const set = (k) => (v) => setState((s) => ({ ...s, tracking: { ...s.tracking, [k]: v } }));
  return (
    <form onSubmit={form.save} noValidate className="space-y-4" data-settings-tab="tracking">
      <ReadOnlyNote form={form} />
      <p className="text-sm text-muted-foreground">Events are sent only for shoppers who agree to them in your store's cookie banner.</p>
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Google Analytics 4</CardTitle>
          <CardDescription>The measurement id runs the tag in the browser; the API secret lets orders be counted from the server too.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field id="st-ga4-id" label="Measurement id" hint={'Looks like "G-XXXXXXX".'}>
            <Input
              id="st-ga4-id"
              disabled={readOnly}
              value={t.ga4_measurement_id}
              onChange={(e) => set("ga4_measurement_id")(e.target.value)}
              placeholder="G-XXXXXXX"
              aria-describedby="st-ga4-id-hint"
              className="font-mono"
            />
          </Field>
          <SecretField
            id="st-ga4-secret"
            label="API secret"
            isSet={view.tracking?.has_ga4_api_secret}
            value={t.ga4_api_secret}
            onChange={set("ga4_api_secret")}
            disabled={readOnly}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Meta</CardTitle>
          <CardDescription>The pixel runs in the browser; the Conversions API token sends purchases from the server.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field id="st-meta-pixel" label="Pixel id" hint="Numbers only.">
            <Input
              id="st-meta-pixel"
              inputMode="numeric"
              disabled={readOnly}
              value={t.meta_pixel_id}
              onChange={(e) => set("meta_pixel_id")(e.target.value)}
              aria-describedby="st-meta-pixel-hint"
              className="font-mono"
            />
          </Field>
          <SecretField
            id="st-meta-capi"
            label="Conversions API token"
            isSet={view.tracking?.has_meta_capi_token}
            value={t.meta_capi_token}
            onChange={set("meta_capi_token")}
            disabled={readOnly}
          />
          <Field id="st-meta-test" label="Test event code" hint="Only while you test in Meta's Events Manager. Remove it for real traffic.">
            <Input
              id="st-meta-test"
              disabled={readOnly}
              value={t.meta_test_event_code}
              onChange={(e) => set("meta_test_event_code")(e.target.value)}
              aria-describedby="st-meta-test-hint"
              className="font-mono"
            />
          </Field>
        </CardContent>
      </Card>
      <SaveBar form={form} role={role} label="Save tracking" />
    </form>
  );
}
