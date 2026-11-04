"use client";

import { usePathname } from "next/navigation";

// P3-FRAME (ED-02): "Edit this page", a link from the live store into the
// editor at the page the founder is looking at. The storefront layout renders
// it only for a browser with a console cookie (_admin or _platform, presence
// only: the editor itself signs the founder in) on a documents-mode store's
// live page, never in a preview and never for a shopper.
export const editorHref = (pathname) => `/admin/editor?path=${encodeURIComponent(typeof pathname === "string" && pathname.startsWith("/") ? pathname : "/")}`;

export default function EditThisPage() {
  const pathname = usePathname() || "/";
  return (
    <a
      href={editorHref(pathname)}
      data-edit-this-page=""
      className="fixed bottom-4 left-4 z-40 rounded-sf-button bg-sf-accent px-4 py-2 text-sm font-bold text-sf-on-accent shadow-lg transition hover:bg-sf-accent-hover"
    >
      Edit this page
    </a>
  );
}
