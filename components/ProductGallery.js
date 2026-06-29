"use client";

import { useState } from "react";
import Image from "next/image";

export default function ProductGallery({ images = [], title }) {
  const [active, setActive] = useState(0);

  if (!images.length) {
    return (
      <div className="flex aspect-square w-full items-center justify-center rounded-2xl bg-zinc-100 text-sm text-zinc-400">
        No image
      </div>
    );
  }

  const main = images[active] || images[0];

  return (
    <div className="lg:sticky lg:top-28">
      <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-zinc-100">
        <Image
          src={main.url}
          alt={main.alt || title}
          fill
          priority
          sizes="(min-width:1024px) 45vw, 100vw"
          className="object-cover"
        />
      </div>

      {images.length > 1 && (
        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto">
          {images.map((img, i) => (
            <button
              key={img.id || i}
              type="button"
              onClick={() => setActive(i)}
              aria-label={`View image ${i + 1}`}
              className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 transition ${
                i === active ? "border-lime-500" : "border-transparent hover:border-zinc-300"
              }`}
            >
              <Image src={img.url} alt="" fill sizes="64px" className="object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
