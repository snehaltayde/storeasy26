"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, FlaskConical, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { money, plainErrors } from "@/lib/offers/plain";

// "Try it" (COM-03): example carts from this store's own products, each
// checked against the offer's sentence, alone and with the store's other live
// offers (POST /api/admin/offers/simulate, offers.read: it writes nothing, so
// support can preview too). The button is a read control. Once the founder
// changes the rules, the example follows them (debounced); an example for
// rules since changed is never shown next to the new sentence.
//   offer: the engine-shaped offer, or null while the rules are incomplete
//   auto: follow changes (the form was edited); otherwise only "Try it" runs it
//   onResult(sim): the fresh result, or null (the form's warnings read facts)
export function SimulatePanel({ offer, enabled, currency, auto = false, onResult, className }) {
  const key = offer ? JSON.stringify(offer) : "";
  const [sim, setSim] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  async function run() {
    if (!key) return;
    const n = ++seq.current;
    setBusy(true);
    let data;
    try {
      const res = await fetch("/api/admin/offers/simulate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offer, enabled }) });
      data = await res.json().catch(() => ({ ok: false, errors: ["The example couldn't be worked out. Try again."] }));
      if (res.status === 401 || res.status === 403) data = { ok: false, errors: [data.error || "You can't try offers with this sign-in."] };
    } catch {
      data = { ok: false, errors: ["The example couldn't load. Check your connection and try again."] };
    }
    if (n !== seq.current) return;
    setSim({ ...data, key });
    setBusy(false);
  }

  useEffect(() => {
    if (!key || !auto) {
      seq.current++;
      setBusy(false);
      return undefined;
    }
    const h = setTimeout(run, 350);
    return () => clearTimeout(h);
    // run reads the offer behind key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, auto]);

  const fresh = Boolean(sim && sim.key === key);
  useEffect(() => {
    onResult?.(fresh && sim.ok ? sim : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, sim]);

  return (
    <div data-simulator="result" className={cn("space-y-2", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Example from your store</p>
          <p className="text-xs text-muted-foreground">Real products, checked against your other live offers. Nothing is saved.</p>
        </div>
        <Button type="button" size="sm" variant="outline" className="shrink-0 bg-card" data-read-control disabled={!key || busy} onClick={run}>
          <FlaskConical aria-hidden />
          {busy ? "Trying…" : fresh ? "Try it again" : "Try it"}
        </Button>
      </div>
      {!key ? (
        <p className="text-sm text-muted-foreground">Finish the rules, then try it on example carts from your store.</p>
      ) : busy && !fresh ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Checking on your store&rsquo;s products…
        </p>
      ) : !fresh ? (
        <p className="text-sm text-muted-foreground">Try it to see what a shopper&rsquo;s cart gets.</p>
      ) : sim.ok === false ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <p className="font-medium">The example couldn&rsquo;t be worked out</p>
          <ul className="mt-1 space-y-0.5">
            {plainErrors(sim.errors || [sim.error], { currency }).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      ) : (
        <SimResult sim={sim} />
      )}
    </div>
  );
}

function SimResult({ sim }) {
  if (sim.missing && !sim.example) return <p className="text-sm text-muted-foreground">{sim.missing}</p>;
  const rows = sim.steps?.length > 1 ? sim.steps : [sim.example];
  return (
    <ul className="space-y-1.5 text-sm" aria-live="polite">
      {rows.map((ex, i) => (
        <li key={i} className="flex items-start gap-2" data-example={ex.agrees ? "agrees" : "differs"}>
          {ex.agrees ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />}
          <span className="text-foreground">
            {ex.text}
            {!ex.agrees && <span className="block text-destructive">The cart worked this out differently ({money(ex.alone.discountTotal, sim.currency)} off). Check the offer before you start it.</span>}
          </span>
        </li>
      ))}
      {sim.nearMiss && (
        <li className="flex items-start gap-2 text-muted-foreground" data-example={sim.nearMiss.agrees ? "agrees" : "differs"}>
          <span className="mt-0.5 inline-block size-4 shrink-0" aria-hidden />
          <span>{sim.nearMiss.text}</span>
        </li>
      )}
      {(sim.notes || []).map((n, i) => (
        <li key={`n${i}`} className="flex items-start gap-2 text-warning-text">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{n}</span>
        </li>
      ))}
    </ul>
  );
}
