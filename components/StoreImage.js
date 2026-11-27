"use client";

import Image from "next/image";
import { isLibraryMedia, isOptimizable, shopifyLoader } from "@/lib/image-src";

// The one way the app uses next/image (P1-IMAGES). Same props as next/image.
// A library photo (/api/media/<id>) is sent unoptimized, as its own url,
// because Next's optimizer can't fetch it for the right store; see
// lib/image-src.js. A Shopify CDN photo is resized by Shopify's own CDN
// (?width=N) through shopifyLoader, never through /_next/image.
// A client component so the loader function stays on the client; server
// components pass it plain props.
// test:images fails if any other file imports next/image.
export default function StoreImage({ unoptimized, ...props }) {
  const off = Boolean(unoptimized) || isLibraryMedia(props.src);
  const shopify = !off && isOptimizable(props.src);
  return <Image {...props} unoptimized={off} loader={shopify ? shopifyLoader : undefined} />;
}
