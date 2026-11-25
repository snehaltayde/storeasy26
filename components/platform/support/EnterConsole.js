"use client";

// Phase 3 line 5: "Enter store console (read-only)". Asks the operator API for
// a single-use, 60-second entry token, then submits a form POST with it to the
// store's own /api/admin/support-entry (another host), which sets the store's
// host-only __Host-support cookie and sends the browser to /admin. The token lives
// only in this click: never in a URL, the page or storage. No rel=noreferrer on
// the form: a no-referrer submission sends Origin: null, which the entry route
// refuses (it needs the console's origin); the entry answer itself sends
// Referrer-Policy: no-referrer. Same tab, so no
// popup blocker can eat the post; the browser's Back returns here.
import { useState } from "react";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supportApi } from "./supportApi";

function post(url, token) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = url;
  form.style.display = "none";
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "token";
  input.value = token;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

export function EnterConsole({ storeId, onError }) {
  const [busy, setBusy] = useState(false);
  async function enter() {
    setBusy(true);
    onError?.(null);
    try {
      const { token, entryUrl } = await supportApi("POST", { action: "enter", tenant: storeId });
      post(entryUrl, token);
    } catch (e) {
      onError?.(e.message);
      setBusy(false);
    }
  }
  return (
    <Button type="button" onClick={enter} disabled={busy} data-support="enter">
      <LogIn aria-hidden /> {busy ? "Opening the console…" : "Enter store console (read-only)"}
    </Button>
  );
}
