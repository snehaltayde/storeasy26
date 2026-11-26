"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Calculator, ChevronDown, Gauge, LayoutTemplate, ShieldCheck, Tags, Wallet } from "lucide-react";
import { NAV } from "./landing-copy";

// The marketing header's moving parts (v4): a glass pill that floats over the
// page and draws in once the page is scrolled, a Product menu that opens under
// it, and a sheet for small screens. Its words are NAV in ./landing-copy.js.
// The logo is passed in by SiteNav (a server component, through next/image).
//
// Both menus are disclosures: a button with aria-expanded and aria-controls,
// over a group of plain links, which is what a site's navigation should be to
// a screen reader (not role="menu"). Closed, a panel is inert, so nothing in it
// can be tabbed to. Escape closes the open one and returns focus to its
// button; so do a press outside the header, focus leaving the header, and a
// change of page. The Product menu also opens under a mouse, without a click.
// Motion is CSS transitions only, which app/marketing.css stops under
// prefers-reduced-motion.
const ICONS = { studio: LayoutTemplate, offers: Tags, checkout: Wallet, speed: Gauge, control: ShieldCheck, apps: Calculator };
const ring = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mk-blue";
const ease = "ease-[cubic-bezier(0.16,1,0.3,1)]";
const link = `rounded-full px-3.5 py-2 text-sm font-medium whitespace-nowrap text-mk-body transition-colors hover:bg-mk-navy/[0.06] hover:text-mk-navy aria-[current=page]:bg-mk-navy/[0.06] aria-[current=page]:text-mk-navy ${ring}`;
const panel = "rounded-[1.75rem] border border-white/80 bg-white/95 shadow-[0_40px_80px_-32px_rgb(11_6_86/0.5)] backdrop-blur-2xl";
const shut = "invisible -translate-y-2 scale-[0.98] opacity-0";
const shown = "visible translate-y-0 scale-100 opacity-100";

function Item({ item, onPick, delay, open, compact = false }) {
  const Icon = ICONS[item.id] || LayoutTemplate;
  return (
    <Link
      href={item.href}
      onClick={onPick}
      style={{ transitionDelay: open ? `${delay}ms` : "0ms" }}
      className={`group/item flex items-center gap-3 rounded-2xl p-2.5 transition-[background-color,opacity,translate] duration-300 hover:bg-mk-mist ${open ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"} ${ring}`}
    >
      <span aria-hidden="true" className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-linear-to-br from-mk-violet/15 to-mk-blue/15 text-mk-violet transition-[background-image,color,scale] duration-300 group-hover/item:scale-105 group-hover/item:from-mk-navy group-hover/item:to-mk-violet group-hover/item:text-white">
        <Icon strokeWidth={1.6} className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-mk-navy">{item.label}</span>
        {compact ? null : <span className="block truncate text-[0.8125rem] text-mk-body">{item.body}</span>}
      </span>
    </Link>
  );
}

export default function SiteNavBar({ children }) {
  const pathname = usePathname();
  const menuId = useId();
  const sheetId = useId();
  const header = useRef(null);
  const productButton = useRef(null);
  const sheetButton = useRef(null);
  const sheet = useRef(null);
  const hover = useRef(false);
  const leaving = useRef(0);
  const [open, setOpen] = useState(null); // null | "product" | "sheet"
  const [scrolled, setScrolled] = useState(false);
  const product = open === "product";
  const sheetOpen = open === "sheet";

  // The pill draws in once the page has moved.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A new page closes whatever was open.
  useEffect(() => setOpen(null), [pathname]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      (open === "sheet" ? sheetButton : productButton).current?.focus();
      setOpen(null);
    };
    const onPress = (e) => {
      if (!header.current?.contains(e.target)) setOpen(null);
    };
    const wide = window.matchMedia("(min-width: 1024px)");
    const onWide = () => setOpen((o) => (o === "sheet" && wide.matches ? null : o));
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress);
    wide.addEventListener("change", onWide);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPress);
      wide.removeEventListener("change", onWide);
    };
  }, [open]);

  // The sheet covers the page: the page behind it holds still, and focus
  // starts on the sheet's first link.
  useEffect(() => {
    if (!sheetOpen) return undefined;
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = "hidden";
    const first = sheet.current?.querySelector("a");
    const timer = window.setTimeout(() => first?.focus(), 60);
    return () => {
      window.clearTimeout(timer);
      root.style.overflow = before;
    };
  }, [sheetOpen]);

  const close = () => setOpen(null);
  const onBlur = (e) => {
    if (open && e.relatedTarget && !header.current?.contains(e.relatedTarget)) setOpen(null);
  };
  const enter = (e) => {
    if (e.pointerType !== "mouse") return;
    window.clearTimeout(leaving.current);
    hover.current = true;
    setOpen("product");
  };
  const leave = (e) => {
    if (e.pointerType !== "mouse") return;
    hover.current = false;
    leaving.current = window.setTimeout(() => setOpen((o) => (o === "product" ? null : o)), 160);
  };

  return (
    <header ref={header} onBlur={onBlur} data-scrolled={scrolled ? "" : undefined} className="group/nav pointer-events-none sticky top-0 z-40 h-[4.75rem]">
      <button type="button" tabIndex={-1} aria-hidden="true" onClick={close} className={`fixed inset-0 -z-10 bg-mk-ink/45 backdrop-blur-sm transition-[opacity,visibility] duration-300 lg:hidden ${sheetOpen ? "pointer-events-auto visible opacity-100" : "invisible opacity-0"}`} />

      <div className={`pointer-events-auto relative mx-auto mt-3 flex h-14 w-[calc(100%-1.5rem)] max-w-[76rem] items-center gap-1 rounded-full border border-white/70 bg-white/75 pr-2 pl-4 shadow-[0_18px_44px_-22px_rgb(11_6_86/0.45)] backdrop-blur-xl backdrop-saturate-150 transition-[max-width,background-color,box-shadow] duration-700 ${ease} group-data-[scrolled]/nav:max-w-[67rem] group-data-[scrolled]/nav:bg-white/92 group-data-[scrolled]/nav:shadow-[0_24px_54px_-24px_rgb(11_6_86/0.6)] sm:pl-5`}>
        {children}

        <nav aria-label={NAV.label} className="ml-3 hidden items-center lg:flex">
          <div onPointerEnter={enter} onPointerLeave={leave}>
            <button
              ref={productButton}
              type="button"
              aria-expanded={product}
              aria-controls={menuId}
              onClick={() => setOpen((o) => (o === "product" && !hover.current ? null : "product"))}
              className={`${link} inline-flex items-center gap-1 aria-expanded:bg-mk-navy/[0.06] aria-expanded:text-mk-navy`}
            >
              {NAV.product}
              <ChevronDown aria-hidden="true" strokeWidth={2} className={`h-4 w-4 transition-transform duration-300 ${product ? "rotate-180" : ""}`} />
            </button>
            <div id={menuId} role="group" aria-label={NAV.productLabel} inert={!product} className={`absolute top-full left-0 w-[min(100%,47rem)] origin-top-left pt-3 transition-[opacity,transform,visibility] duration-300 ${ease} ${product ? shown : shut}`}>
              <div className={`${panel} grid grid-cols-[minmax(0,1fr)_15rem] gap-2 p-2.5`}>
                <ul className="grid grid-cols-2 gap-0.5">
                  {NAV.items.map((item, i) => (
                    <li key={item.id}>
                      <Item item={item} onPick={close} delay={40 + i * 35} open={product} />
                    </li>
                  ))}
                </ul>
                <Link href={NAV.feature.href} onClick={close} className={`group/feature relative flex flex-col justify-between overflow-hidden rounded-[1.25rem] bg-(image:--mk-surface) p-4 text-white ${ring}`}>
                  <span aria-hidden="true" className="flex items-center gap-2">
                    <span className="grid grid-cols-4 gap-1">
                      {NAV.items.concat(NAV.items).map((item, i) => (
                        <i key={`${item.id}-${i}`} className="block h-2.5 w-2.5 rounded-[3px] bg-white/30 transition-[background-color,translate] duration-500 group-hover/feature:translate-x-1 group-hover/feature:bg-white/70" style={{ transitionDelay: `${i * 20}ms` }} />
                      ))}
                    </span>
                    <ArrowRight strokeWidth={1.8} className="h-4 w-4 text-mk-sky" />
                    <i className="block h-9 w-9 rounded-xl bg-white shadow-[0_0_24px_rgb(156_192_255/0.8)]" />
                  </span>
                  <span className="mt-8 block">
                    <span className="mk-display block text-xl leading-tight">{NAV.feature.title}</span>
                    <span className="mt-1.5 flex items-center gap-1.5 text-[0.8125rem] text-mk-on-ink">
                      {NAV.feature.body}
                      <ArrowRight aria-hidden="true" strokeWidth={2} className="h-3.5 w-3.5 transition-transform duration-300 group-hover/feature:translate-x-1" />
                    </span>
                  </span>
                </Link>
              </div>
            </div>
          </div>
          {NAV.links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={pathname === l.href ? "page" : undefined} className={link}>
              {l.label}
            </Link>
          ))}
        </nav>

        <Link href="/contact" className={`${link} ml-auto max-xl:hidden`}>
          {NAV.talk}
        </Link>
        <Link href="/signup" className={`mk-cta inline-flex h-10 flex-none items-center gap-1.5 rounded-full px-4 text-sm font-semibold whitespace-nowrap max-xl:ml-auto sm:px-5 ${ring}`}>
          <span className="sm:hidden">{NAV.ctaShort}</span>
          <span className="max-sm:hidden">{NAV.cta}</span>
          <ArrowRight aria-hidden="true" strokeWidth={2} className="h-4 w-4" />
        </Link>
        <button ref={sheetButton} type="button" aria-expanded={sheetOpen} aria-controls={sheetId} aria-label={sheetOpen ? NAV.close : NAV.menu} onClick={() => setOpen((o) => (o === "sheet" ? null : "sheet"))} className={`relative grid h-10 w-10 flex-none place-items-center rounded-full text-mk-navy transition-colors hover:bg-mk-navy/[0.06] lg:hidden ${ring}`}>
          <span aria-hidden="true" className={`absolute h-0.5 w-5 rounded-full bg-current transition-transform duration-300 ${ease} ${sheetOpen ? "rotate-45" : "-translate-y-[0.3rem]"}`} />
          <span aria-hidden="true" className={`absolute h-0.5 w-5 rounded-full bg-current transition-transform duration-300 ${ease} ${sheetOpen ? "-rotate-45" : "translate-y-[0.3rem]"}`} />
        </button>

        <span aria-hidden="true" className="pointer-events-none absolute inset-x-8 bottom-0 block h-0.5 overflow-hidden rounded-full">
          <span className="mk-progress bottom-0" />
        </span>
      </div>

      <div ref={sheet} id={sheetId} role="group" aria-label={NAV.menu} inert={!sheetOpen} data-lenis-prevent="" className={`pointer-events-auto absolute inset-x-3 top-[4.5rem] max-h-[calc(100svh-5.5rem)] origin-top overflow-y-auto overscroll-contain p-3 transition-[opacity,transform,visibility] duration-500 lg:hidden ${ease} ${panel} ${sheetOpen ? shown : shut}`}>
        <p className="px-2.5 pt-1 pb-1 text-xs font-semibold text-mk-muted">{NAV.product}</p>
        <ul className="grid grid-cols-1 gap-0.5 min-[30rem]:grid-cols-2">
          {NAV.items.map((item, i) => (
            <li key={item.id}>
              <Item item={item} onPick={close} delay={60 + i * 40} open={sheetOpen} />
            </li>
          ))}
        </ul>
        <ul className="mt-2 border-t border-mk-rule pt-2">
          {NAV.links.map((l, i) => (
            <li key={l.href}>
              <Link
                href={l.href}
                onClick={close}
                aria-current={pathname === l.href ? "page" : undefined}
                style={{ transitionDelay: sheetOpen ? `${300 + i * 45}ms` : "0ms" }}
                className={`mk-display flex items-center justify-between rounded-2xl px-2.5 py-2.5 text-2xl text-mk-navy transition-[background-color,opacity,translate] duration-300 hover:bg-mk-mist aria-[current=page]:text-mk-violet ${sheetOpen ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"} ${ring}`}
              >
                {l.label}
                <ArrowRight aria-hidden="true" strokeWidth={1.6} className="h-5 w-5 text-mk-muted" />
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-3 grid gap-2 min-[30rem]:grid-cols-2">
          <Link href="/signup" onClick={close} className={`mk-cta inline-flex h-12 items-center justify-center rounded-full px-5 text-[0.9375rem] font-semibold ${ring}`}>
            {NAV.cta}
          </Link>
          <Link href="/contact" onClick={close} className={`inline-flex h-12 items-center justify-center rounded-full border border-mk-edge px-5 text-[0.9375rem] font-semibold text-mk-navy hover:bg-mk-mist ${ring}`}>
            {NAV.talk}
          </Link>
        </div>
      </div>
    </header>
  );
}
