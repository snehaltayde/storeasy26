"use client";

import { useState } from "react";
import Image from "next/image";

// next/image that fades in once decoded — kills the hard "pop" as product
// imagery loads (the bg placeholder already reserves space, so no layout shift).
export default function FadeImage({ className = "", onLoad, ...props }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <Image
      {...props}
      onLoad={(e) => {
        setLoaded(true);
        onLoad?.(e);
      }}
      className={`${className} transition duration-500 ${loaded ? "opacity-100" : "opacity-0"}`}
    />
  );
}
