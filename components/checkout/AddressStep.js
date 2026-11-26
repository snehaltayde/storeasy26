"use client";

import SavedAddressPicker from "./SavedAddressPicker";
import PincodeField from "./PincodeField";
import WhatsAppConsent from "./WhatsAppConsent";

// Phase 8 step 0: checkout step 1, split out of CheckoutFlow. The form lives
// in CheckoutFlow and changes only through applyAddress (./checkoutModel),
// which `onAddress(patch, source)` calls.
// Phase 8 line 1: the PIN code comes first (./PincodeField, which holds the
// lookup's state). While city and state hold what the PIN found, PincodeField
// shows them as one chip ("Bengaluru, Karnataka · Change") and passes
// `chip: true` to the render function here, which then leaves out those two
// fields; Change opens them to edit. This file stays hook-free.

const AUTOCOMPLETE = {
  email: "email",
  phone: "tel",
  name: "name",
  line1: "address-line1",
  line2: "address-line2",
  city: "address-level2",
  state: "address-level1",
};

const FIELDS = [
  { key: "email", label: "Email", type: "email", required: true, half: true },
  { key: "phone", label: "Phone", type: "tel", required: true, half: true },
  { key: "name", label: "Full name", required: true },
  { key: "line1", label: "Address", required: true },
  { key: "line2", label: "Apartment, suite (optional)", required: false },
  { key: "city", label: "City", required: true, half: true },
  { key: "state", label: "State", required: true, half: true },
];

// Phase 8 line 4: the country comes first (the store's own and its enabled
// markets', `countries` from lib/markets.js countryOptions). The PIN lookup is
// India's; any other country gets a plain postal code field.
export default function AddressStep({ form, valid, onAddress, onContinue, countries = [] }) {
  const india = (form.country_code || "IN") === "IN";
  const fields = (chip) => (
          <div className="grid grid-cols-2 gap-3">
            {(chip
              ? FIELDS.filter((f) => f.key !== "city" && f.key !== "state")
              : FIELDS
            ).map((f) => (
              <div key={f.key} className={f.half ? "col-span-1" : "col-span-2"}>
                <label className="mb-1 block text-xs font-medium text-sf-text-subtle">
                  {f.label}
                </label>
                <input
                  type={f.type || "text"}
                  name={f.key}
                  autoComplete={AUTOCOMPLETE[f.key]}
                  value={form[f.key]}
                  onChange={(e) =>
                    onAddress({ [f.key]: e.target.value }, "typed")
                  }
                  className="w-full sf-field rounded-sf-control border border-sf-border px-3 py-2"
                />
              </div>
            ))}
          </div>
  );
  return (
    <section>
      <h2 className="mb-4 text-lg font-bold">Contact &amp; shipping address</h2>
      {countries.length > 1 && (
        <div className="mb-3">
          <label htmlFor="checkout-country" className="mb-1 block text-xs font-medium text-sf-text-subtle">
            Country
          </label>
          <select
            id="checkout-country"
            name="country_code"
            autoComplete="country"
            value={form.country_code}
            onChange={(e) => onAddress({ country_code: e.target.value }, "typed")}
            className="w-full sf-field rounded-sf-control border border-sf-border bg-sf-surface px-3 py-2"
          >
            {countries.map((c) => (
              <option key={c.country} value={c.country}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {/* saved-addresses */}
      <SavedAddressPicker form={form} onAddress={onAddress} />
      {india ? (
        <PincodeField form={form} onAddress={onAddress}>
          {fields}
        </PincodeField>
      ) : (
        <>
          <div className="mb-3">
            <label htmlFor="checkout-postal" className="mb-1 block text-xs font-medium text-sf-text-subtle">
              Postal code
            </label>
            <input
              id="checkout-postal"
              name="pincode"
              autoComplete="postal-code"
              value={form.pincode}
              onChange={(e) => onAddress({ pincode: e.target.value }, "typed")}
              className="w-full sf-field rounded-sf-control border border-sf-border px-3 py-2"
            />
          </div>
          {fields(false)}
        </>
      )}
      {/* messaging-consent */}
      <WhatsAppConsent phone={form.phone} country={form.country_code || "IN"} />
      <button
        onClick={onContinue}
        disabled={!valid}
        className="sf-focus mt-6 min-h-11 w-full rounded-sf-control bg-sf-inverse px-6 py-3 text-sm font-semibold text-sf-on-inverse transition hover:bg-sf-inverse-hover disabled:cursor-not-allowed disabled:bg-sf-surface-disabled"
      >
        Continue to review
      </button>
    </section>
  );
}
