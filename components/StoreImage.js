import Image from "next/image";
import { isLibraryMedia } from "@/lib/image-src";

// The one way the app uses next/image (P1-IMAGES). Same props as next/image.
// A library photo (/api/media/<id>) is sent unoptimized, as its own url,
// because Next's optimizer can't fetch it for the right store; see
// lib/image-src.js. Every other image (the Shopify CDN) is optimized as before.
// No hooks, so server and client components can both use it.
// test:images fails if any other file imports next/image.
export default function StoreImage({ unoptimized, ...props }) {
  return <Image {...props} unoptimized={Boolean(unoptimized) || isLibraryMedia(props.src)} />;
}
