"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { STACK, CALC, stackTotals } from "./landing-copy";

// The landing page's one client island: the founder's own app bill, added up.
// Plans come from the server (lib/platform/billing.js listPlans, the source
// /pricing reads); nothing here holds a price. Figures stay in this tab only.
const inr = (n) => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-700";

export default function StackCalculator({ plans = [] }) {
  const uid = useId();
  const [values, setValues] = useState({});
  const paid = plans.filter((p) => p.price > 0);
  const [planKey, setPlanKey] = useState(() => (paid[0] || plans[0])?.id ?? "");
  const plan = plans.find((p) => p.id === planKey) || null;
  const t = useMemo(() => stackTotals(values, plan ? plan.price : null), [values, plan]);
  const bad = new Set(t.invalid);
  const empty = t.entered === 0;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-12">
      <fieldset className="min-w-0">
        <legend className="sr-only">{CALC.legend}</legend>
        <ul className="divide-y divide-zinc-200 border-y border-zinc-200">
          {STACK.map((row) => {
            const id = `${uid}-${row.id}`;
            const err = bad.has(row.id);
            return (
              <li key={row.id} className="grid grid-cols-[minmax(0,1fr)_9.5rem] items-center gap-x-4 gap-y-1 py-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
                <label htmlFor={id} className="min-w-0">
                  <span className="block text-[0.9375rem] font-semibold text-zinc-900">{row.label}</span>
                  <span className="block text-sm text-zinc-600">{CALC.builtAs} {row.built}</span>
                </label>
                <div className="relative">
                  <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-sm text-zinc-500">₹</span>
                  <input
                    id={id}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={CALC.placeholder}
                    value={values[row.id] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [row.id]: e.target.value }))}
                    aria-invalid={err || undefined}
                    aria-describedby={err ? `${id}-err` : `${id}-unit`}
                    className={`h-11 w-full rounded-lg border bg-white pr-3 pl-7 text-right font-mono text-sm tabular-nums text-zinc-900 placeholder:font-sans placeholder:text-zinc-500 ${err ? "border-red-700" : "border-zinc-300"} ${focus}`}
                  />
                  <span id={`${id}-unit`} className="sr-only">
                    {CALC.unit}
                  </span>
                </div>
                {err && (
                  <p id={`${id}-err`} className="col-span-2 text-sm text-red-700">
                    {CALC.invalid}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <button type="button" onClick={() => setValues({})} disabled={empty && t.invalid.length === 0} className={`mt-4 -ml-4 rounded-full px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400 disabled:hover:bg-transparent ${focus}`}>
          {CALC.clear}
        </button>
      </fieldset>

      <div className="lg:sticky lg:top-20 lg:self-start">
        <div className="rounded-2xl bg-zinc-950 p-6 text-white" aria-live="polite">
          {empty ? (
            <p className="text-[0.9375rem] text-zinc-300">{CALC.empty}</p>
          ) : (
            <dl className="space-y-4">
              <div>
                <dt className="text-sm text-zinc-300">{CALC.monthly}</dt>
                <dd className="mt-1 font-mono text-4xl font-semibold tabular-nums tracking-tight text-lime-400">{inr(t.monthly)}</dd>
              </div>
              <div>
                <dt className="text-sm text-zinc-300">{CALC.yearly}</dt>
                <dd className="mt-1 font-mono text-xl tabular-nums">{inr(t.yearly)}</dd>
              </div>
            </dl>
          )}

          <div className="mt-6 border-t border-white/15 pt-5">
            {plans.length === 0 ? (
              <p className="text-sm text-zinc-300">
                {CALC.noPlans}{" "}
                <Link href="/pricing" className={`font-semibold text-white underline underline-offset-4 ${focus} focus-visible:outline-lime-400`}>
                  {CALC.seePricing}
                </Link>
              </p>
            ) : (
              <>
                <label htmlFor={`${uid}-plan`} className="text-sm text-zinc-300">
                  {CALC.plan}
                </label>
                <select id={`${uid}-plan`} value={planKey} onChange={(e) => setPlanKey(e.target.value)} className={`mt-1.5 h-11 w-full rounded-lg border border-white/20 bg-zinc-900 px-3 text-sm text-white ${focus} focus-visible:outline-lime-400`}>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}: {p.price === 0 ? CALC.free : `${inr(p.price / 100)} a ${p.interval}`}
                    </option>
                  ))}
                </select>
                <dl className="mt-4 space-y-2 text-sm">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-zinc-300">{CALC.planCost}</dt>
                    <dd className="font-mono tabular-nums">{inr(t.plan)}</dd>
                  </div>
                  {!empty && (
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-zinc-300">{t.difference >= 0 ? CALC.difference : CALC.over}</dt>
                      <dd className="font-mono tabular-nums text-white">{inr(Math.abs(t.difference))}</dd>
                    </div>
                  )}
                </dl>
              </>
            )}
          </div>
        </div>
        <p className="mt-4 text-sm font-semibold text-zinc-900">{CALC.estimate}</p>
        <p className="mt-1 text-sm text-zinc-600">{CALC.shopifyStays}</p>
      </div>
    </div>
  );
}
