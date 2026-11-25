"use client";

// Phase 6 line 1 (docs/plans/phase-6.md feature 5): the studio's one
// aria-live="assertive" region. It reads `text` out; the same words twice
// in a row are read again (`count` changes: a no-break space is added or
// taken off, which a screen reader doesn't say). Visually hidden.
export default function LiveRegion({ text = "", count = 0 }) {
  return (
    <div aria-live="assertive" aria-atomic="true" className="sr-only" data-studio-live="">
      {text ? `${text}${count % 2 ? " " : ""}` : ""}
    </div>
  );
}
