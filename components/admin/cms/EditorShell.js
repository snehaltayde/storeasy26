"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronRight, ListTree, Menu } from "lucide-react";
import { Button, IconButton } from "@/components/console/Button";
import { Drawer } from "@/components/console/Drawer";
import { Skeleton } from "@/components/console/bits";
import { useConsoleNav } from "@/components/console/nav/ConsoleShell";
import { DEVICES, TREE_DOCKED_FROM, fitCaption, frameStyles } from "./editorLayout";

// ED-01: the full-width editor. Its own layout, outside the console's 1024px
// cap: a top bar, then tree on the left, preview in the centre and inspector
// on the right, filling the window. The console navigation folds into a
// drawer behind the menu button. Widths and breakpoints are the numbers in
// ./editorLayout.js (tree 224px, inspector 288px):
//   1280 and wider: all three panes
//   1024 to 1279:   the tree opens in a drawer from the "Sections" button
//   under 1024:     the inspector moves under the preview
// Used by Designer (home page) and SurfaceDesigner (product and collection
// pages, which have no tree). Callers pass their own pieces; this file only
// arranges them, so save, preview and issue display stay in the callers.
// `children` are the notices (conflicts, refused saves) shown under the top
// bar, above the panes. In the tree, a control marked `data-tree-pick` (a
// section's row) closes the tree drawer when clicked, so the founder lands
// straight on that section's settings instead of pressing Escape first.

export function EditorShell({ title, description, breadcrumb, tabs, actions, tree, treeTitle = "Sections", preview, inspector, children }) {
  const nav = useConsoleNav();
  const [treeOpen, setTreeOpen] = useState(false);
  const hasTree = !!tree;

  // Widening past 1280 docks the tree: close the drawer so it never shows twice.
  useEffect(() => {
    if (!hasTree) return;
    const mq = window.matchMedia(`(min-width: ${TREE_DOCKED_FROM}px)`);
    const onChange = () => {
      if (mq.matches) setTreeOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [hasTree]);

  // From 1024 wide the editor fills the window below anything the console
  // shows above it (a platform notice), so the page itself never scrolls and
  // each pane scrolls on its own.
  const rootRef = useRef(null);
  const [top, setTop] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setTop(Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY)));
    measure();
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(document.body);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      data-editor-shell
      style={{ "--editor-top": `${top}px` }}
      className="flex flex-col bg-surface lg:h-[calc(100dvh_-_var(--editor-top,0px))]"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge bg-surface px-3 py-2">
        {nav?.openNav && <IconButton data-console-menu label="Open menu" icon={<Menu size={17} aria-hidden />} onClick={nav.openNav} />}
        {/* which store this is, where the top bar has room (the menu has it too) */}
        {nav?.storeName && (
          <span data-store-name className="hidden max-w-48 truncate text-xs font-medium text-fg-muted xl:inline" title={nav.storeName}>
            {nav.storeName}
          </span>
        )}
        {hasTree && (
          <Button
            data-tree-toggle
            size="sm"
            className="xl:hidden"
            icon={<ListTree size={14} aria-hidden />}
            aria-haspopup="dialog"
            aria-expanded={treeOpen}
            onClick={() => setTreeOpen(true)}
          >
            {treeTitle}
          </Button>
        )}
        <div className="flex min-w-0 items-center gap-1.5">
          {breadcrumb?.length > 1 && breadcrumb[0].href && (
            <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-fg-muted">
              <Link href={breadcrumb[0].href} className="rounded focus-ring hover:text-fg hover:underline">
                {breadcrumb[0].label}
              </Link>
              <ChevronRight size={12} aria-hidden />
            </nav>
          )}
          <h1 className="truncate text-base font-semibold tracking-tight text-fg">{title}</h1>
          {description && <p className="sr-only">{description}</p>}
        </div>
        {tabs}
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </header>

      <div className="space-y-2 border-b border-edge px-3 py-2 empty:hidden">{children}</div>

      <div data-editor-panes className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {hasTree && (
          <aside data-editor-pane="tree" aria-label={treeTitle} className="hidden w-56 shrink-0 overflow-y-auto border-r border-edge bg-surface xl:block">
            {/* while the drawer holds the tree, it renders there only */}
            {!treeOpen && tree}
          </aside>
        )}
        <section data-editor-pane="preview" aria-label="Preview" className="flex min-w-0 flex-col bg-surface-sunken lg:flex-1">
          {preview}
        </section>
        {inspector && (
          <aside
            data-editor-pane="inspector"
            aria-label="Settings"
            className="shrink-0 overflow-y-auto border-t border-edge bg-surface lg:w-72 lg:border-l lg:border-t-0"
          >
            {inspector}
          </aside>
        )}
      </div>

      {hasTree && (
        <Drawer open={treeOpen} onClose={() => setTreeOpen(false)} side="left" title={treeTitle} closeLabel={`Close ${treeTitle.toLowerCase()}`}>
          {/* picking a section closes the drawer; the row's own click selects it first */}
          <div
            data-tree-drawer
            onClick={(e) => {
              if (e.target?.closest?.("[data-tree-pick]")) setTreeOpen(false);
            }}
          >
            {tree}
          </div>
        </Drawer>
      )}
    </div>
  );
}

// The Mobile / Tablet / Desktop buttons. Each sets a real width (DEVICES).
export function DeviceSwitch({ device, onChange }) {
  return (
    <span className="flex items-center rounded-ctl border border-edge bg-surface p-0.5" role="group" aria-label="Preview width">
      {DEVICES.map((d) => (
        <Button
          key={d.key}
          size="sm"
          variant={device === d.key ? "primary" : "ghost"}
          aria-pressed={device === d.key}
          title={`${d.width} px wide`}
          onClick={() => onChange(d.key)}
        >
          {d.label}
        </Button>
      ))}
    </span>
  );
}

// The grey canvas the page sits on. It measures its own space, renders the
// page at the device's real width, shrinks it as a whole when it is wider than
// the space, and says so in the caption. `frame` is (style) => <iframe/>, or
// null while the preview starts; `placeholder: false` shows nothing instead of
// a skeleton (for when a banner already explains why).
export function PreviewCanvas({ device, frame, placeholder = true }) {
  const ref = useRef(null);
  const [space, setSpace] = useState(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSpace((s) => (s && s.w === width && s.h === height ? s : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { device: d, fit, box, frame: frameStyle } = frameStyles(device, space);

  return (
    <div data-preview-canvas className="flex min-h-0 flex-col px-2 pb-2 lg:flex-1">
      <p data-frame-caption className="py-1 text-center text-[11px] text-fg-subtle">
        {fitCaption(d, space ? fit : null)}
      </p>
      <div ref={ref} className="h-[75dvh] min-h-0 lg:h-auto lg:flex-1">
        {frame && box ? (
          <div className="relative mx-auto overflow-hidden rounded-card bg-surface shadow-card ring-1 ring-edge" style={box}>
            {frame(frameStyle)}
          </div>
        ) : (
          placeholder && <Skeleton className="h-full w-full rounded-card" />
        )}
      </div>
    </div>
  );
}
