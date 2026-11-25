"use client";

// Phase 8 line 2: the cash-on-delivery code. "We sent a code to +91 ••••••4321";
// the browser can fill the code from the SMS (autocomplete="one-time-code");
// Resend after 30 s; Change number goes back to the address step. The answers
// (wrong, expired, locked, too many) are the server's own sentences.
import { useEffect, useRef, useState } from "react";

export default function CodOtpDialog({ sentTo, resendIn = 30, sentAt, error, busy, onVerify, onResend, onChangeNumber, onClose }) {
  const [code, setCode] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const input = useRef(null);
  useEffect(() => {
    input.current?.focus();
  }, [sentAt]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  const wait = Math.max(0, Math.ceil(((sentAt || 0) + resendIn * 1000 - now) / 1000));
  const ready = /^\d{6}$/.test(code);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div role="dialog" aria-modal="true" aria-labelledby="cod-otp-title" data-checkout="cod-otp" className="w-full max-w-sm rounded-sf-card bg-sf-surface p-5 shadow-xl">
        <h2 id="cod-otp-title" className="text-base font-bold">
          Confirm your phone number
        </h2>
        <p className="mt-1 text-sm text-sf-text-muted">We sent a code to {sentTo}</p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) onVerify(code);
          }}
        >
          <label htmlFor="cod-otp-code" className="block text-xs font-medium text-sf-text-subtle">
            6-digit code
          </label>
          <input
            ref={input}
            id="cod-otp-code"
            name="one-time-code"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            aria-invalid={error ? "true" : undefined}
            aria-describedby={error ? "cod-otp-error" : undefined}
            className="w-full rounded-sf-control border border-sf-border-strong px-3 py-3 text-center font-mono text-lg tracking-[0.4em]"
          />
          {error && (
            <p id="cod-otp-error" role="alert" className="text-sm text-sf-danger">
              {error}
            </p>
          )}
          <button type="submit" disabled={!ready || busy} className="w-full rounded-sf-control bg-sf-accent px-6 py-3 text-sm font-bold text-sf-on-accent hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-60">
            {busy ? "Checking…" : "Confirm and place order"}
          </button>
        </form>
        <div className="mt-3 flex items-center justify-between text-xs">
          <button type="button" onClick={onResend} disabled={wait > 0 || busy} className="font-medium text-sf-accent-text hover:underline disabled:text-sf-text-faint disabled:no-underline">
            {wait > 0 ? `Resend in ${wait} s` : "Resend code"}
          </button>
          <button type="button" onClick={onChangeNumber} disabled={busy} className="font-medium text-sf-text-muted hover:underline">
            Change number
          </button>
        </div>
      </div>
    </div>
  );
}
