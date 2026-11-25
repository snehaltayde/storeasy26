"use client";

import SavedAddressPicker from "./SavedAddressPicker";

// Phase 8 step 0: checkout step 1, split out of CheckoutFlow. Stateless: the
// form lives in CheckoutFlow and changes only through applyAddress
// (./checkoutModel), which `onAddress(patch, source)` calls.

const AUTOCOMPLETE = {
  email: "email",
  phone: "tel",
  name: "name",
  line1: "address-line1",
  line2: "address-line2",
  city: "address-level2",
  state: "address-level1",
  pincode: "postal-code",
};

const FIELDS = [
  { key: "email", label: "Email", type: "email", required: true, half: true },
  { key: "phone", label: "Phone", type: "tel", required: true, half: true },
  { key: "name", label: "Full name", required: true },
  { key: "line1", label: "Address", required: true },
  { key: "line2", label: "Apartment, suite (optional)", required: false },
  { key: "city", label: "City", required: true, half: true },
  { key: "state", label: "State", required: true, half: true },
  { key: "pincode", label: "PIN code", required: true, half: true },
];

export default function AddressStep({ form, valid, onAddress, onContinue }) {
  return (
    <section>
      <h2 className="mb-4 text-lg font-bold">Contact &amp; shipping address</h2>
      {/* saved-addresses */}
      <SavedAddressPicker form={form} onAddress={onAddress} />
      <div className="grid grid-cols-2 gap-3">
        {FIELDS.map((f) => (
          <div key={f.key} className={f.half ? "col-span-1" : "col-span-2"}>
            <label className="mb-1 block text-xs font-medium text-sf-text-subtle">{f.label}</label>
            <input
              type={f.type || "text"}
              name={f.key}
              autoComplete={AUTOCOMPLETE[f.key]}
              value={form[f.key]}
              onChange={(e) => onAddress({ [f.key]: e.target.value }, "typed")}
              className="w-full rounded-sf-control border border-sf-border px-3 py-2.5 text-sm outline-none focus:border-sf-border-hover"
            />
          </div>
        ))}
      </div>
      <button
        onClick={onContinue}
        disabled={!valid}
        className="mt-6 w-full rounded-sf-control bg-sf-inverse px-6 py-3 text-sm font-semibold text-sf-on-inverse transition hover:bg-sf-inverse-hover disabled:cursor-not-allowed disabled:bg-sf-surface-disabled"
      >
        Continue to review
      </button>
    </section>
  );
}
