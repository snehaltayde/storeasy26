"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { STACK, CALC, stackTotals, typicalRupees, typicalValues } from "./landing-copy";
import { Glyph } from "./LandingArt";

// The landing page's calculator island: the app bill, added up. Each line
// starts at the standard estimate for that kind of app (STACK in
// ./landing-copy.js: one named app's lowest paid plan, with its source), and
// the founder types over any of them. Storeasy's plans come from the server
// (lib/platform/billing.js listPublicPlans, the source /pricing reads); no
// price is written in this file. Figures stay in this tab only. The totals count up to their new value; a
// screen reader gets the final figure once, and with motion off the figure
// simply changes.
const inr = (n) => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mk-blue";
const focusInk = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

function useCountUp(target) {
  const [shown, setShown] = useState(target);
  const last = useRef(target);
  useEffect(() => {
    const start = last.current;
    if (start === target) return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      last.current = target;
      setShown(target);
      return undefined;
    }
    const began = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const p = Math.min(1, (now - began) / 650);
      const value = p === 1 ? target : start + (target - start) * (1 - Math.pow(1 - p, 3));
      last.current = value;
      setShown(value);
      if (p !== 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

function Count({ value, className }) {
  const shown = useCountUp(value);
  return (
    <dd className={className}>
      <span aria-hidden="true">{inr(shown === value ? value : Math.round(shown))}</span>
      <span className="sr-only">{inr(value)}</span>
    </dd>
  );
}

export default function StackCalculator({ plans = [] }) {
  const uid = useId();
  const [values, setValues] = useState(typicalValues);
  const typical = useMemo(typicalValues, []);
  const atTypical = STACK.every((row) => String(values[row.id] ?? "").trim() === typical[row.id]);
  const paid = plans.filter((p) => p.price > 0);
  const [planKey, setPlanKey] = useState(() => (paid[0] || plans[0])?.id ?? "");
  const plan = plans.find((p) => p.id === planKey) || null;
  const t = useMemo(() => stackTotals(values, plan ? plan.price : null), [values, plan]);
  const bad = new Set(t.invalid);
  const empty = t.entered === 0;

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-14">
      <fieldset className="min-w-0">
        <legend className="sr-only">{CALC.legend}</legend>
        <ul className="divide-y divide-mk-rule border-y border-mk-rule">
          {STACK.map((row) => {
            const id = `${uid}-${row.id}`;
            const err = bad.has(row.id);
            const filled = !err && String(values[row.id] ?? "").trim() !== "";
            return (
              <li key={row.id} className="grid grid-cols-[auto_minmax(0,1fr)_7.5rem] items-center gap-x-3.5 gap-y-1 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_11rem] sm:gap-x-4">
                <Glyph id={row.id} />
                <label htmlFor={id} className="min-w-0">
                  <span className="block text-[0.9375rem] font-semibold text-mk-navy">{row.label}</span>
                  <span className="block text-sm text-mk-body">
                    {CALC.builtAs} {row.built}
                  </span>
                  <span className="block text-xs text-mk-muted">
                    {CALC.typical} {row.price.vendor}, {inr(typicalRupees(row))}
                  </span>
                </label>
                <div className="relative">
                  <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-sm text-mk-muted">
                    ₹
                  </span>
                  <input
                    id={id}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={CALC.placeholder}
                    value={values[row.id] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [row.id]: e.target.value }))}
                    aria-invalid={err || undefined}
                    aria-describedby={err ? `${id}-err` : `${id}-unit`}
                    className={`h-12 w-full rounded-xl border bg-white pr-3 pl-7 sm:pr-3.5 sm:pl-8 text-right text-[0.9375rem] font-medium tabular-nums text-mk-navy transition-[border-color,box-shadow] duration-300 placeholder:font-normal placeholder:text-mk-muted ${err ? "border-mk-danger" : filled ? "border-mk-violet shadow-[0_10px_24px_-16px_rgb(91_43_224/0.9)]" : "border-mk-edge"} ${focus}`}
                  />
                  <span id={`${id}-unit`} className="sr-only">
                    {CALC.unit}
                  </span>
                </div>
                {err && (
                  <p id={`${id}-err`} className="col-span-3 text-sm text-mk-danger">
                    {CALC.invalid}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-4 -ml-4 flex flex-wrap gap-x-1">
          <button type="button" onClick={() => setValues(typicalValues())} disabled={atTypical} className={`rounded-full px-4 py-2 text-sm font-semibold text-mk-violet transition-colors hover:bg-white disabled:cursor-not-allowed disabled:text-mk-muted disabled:hover:bg-transparent ${focus}`}>
            {CALC.reset}
          </button>
          <button type="button" onClick={() => setValues({})} disabled={empty && t.invalid.length === 0} className={`rounded-full px-4 py-2 text-sm font-semibold text-mk-violet transition-colors hover:bg-white disabled:cursor-not-allowed disabled:text-mk-muted disabled:hover:bg-transparent ${focus}`}>
            {CALC.clear}
          </button>
        </div>
      </fieldset>

      <div className="lg:sticky lg:top-24 lg:self-start">
        <div className="mk-sum mk-grain p-7 sm:p-8" aria-live="polite">
          {empty ? (
            <p className="text-lg leading-relaxed text-white">{CALC.empty}</p>
          ) : (
            <dl className="space-y-5">
              <div>
                <dt className="text-sm text-mk-on-ink">{CALC.monthly}</dt>
                <Count value={t.monthly} className="mt-1 text-5xl font-semibold tracking-tight tabular-nums text-white" />
              </div>
              <div>
                <dt className="text-sm text-mk-on-ink">{CALC.yearly}</dt>
                <Count value={t.yearly} className="mt-1 text-2xl font-medium tabular-nums text-white" />
              </div>
            </dl>
          )}

          <div className="mt-7 border-t border-white/20 pt-6">
            {plans.length === 0 ? (
              <p className="text-sm text-mk-on-ink">
                {CALC.noPlans}{" "}
                <Link href="/pricing" className={`rounded font-semibold text-white underline underline-offset-4 ${focusInk}`}>
                  {CALC.seePricing}
                </Link>
              </p>
            ) : (
              <>
                <label htmlFor={`${uid}-plan`} className="text-sm text-mk-on-ink">
                  {CALC.plan}
                </label>
                <select id={`${uid}-plan`} value={planKey} onChange={(e) => setPlanKey(e.target.value)} className={`mt-2 h-12 w-full rounded-xl border border-white/30 bg-mk-navy px-3.5 text-[0.9375rem] text-white ${focusInk}`}>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}: {`${inr(p.price / 100)} a ${p.interval}`}
                    </option>
                  ))}
                </select>
                <dl className="mt-5 space-y-2.5 text-[0.9375rem]">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-mk-on-ink">{CALC.planCost}</dt>
                    <dd className="font-medium tabular-nums text-white">{inr(t.plan)}</dd>
                  </div>
                  {!empty && (
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-mk-on-ink">{t.difference >= 0 ? CALC.difference : CALC.over}</dt>
                      <Count value={Math.abs(t.difference)} className="font-semibold tabular-nums text-white" />
                    </div>
                  )}
                </dl>
              </>
            )}
          </div>
        </div>
        <p className="mt-5 text-sm font-semibold text-mk-navy">{CALC.estimate}</p>
        <p className="mt-1 text-sm text-mk-body">{CALC.shopifyStays}</p>
      </div>
    </div>
  );
}
