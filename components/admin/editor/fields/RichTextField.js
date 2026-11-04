"use client";

// P3-INSPECTOR (AU-01, ED-04): the rich text field. THE INTERFACE IS FINAL;
// this file ships a fallback implementation behind it. P3-RTE replaces the
// implementation (a real editor) and keeps every prop below as it is.
//
// Props (the contract):
//   value           string   the stored HTML (sanitized by the server). The
//                            field shows it and never changes it on its own:
//                            an untouched value goes back exactly as it came.
//   onChange(html)  function called with what the founder typed or pasted.
//                            The field never sanitizes (the server is the only
//                            sanitizer: saveDraft sanitizes, and the field then
//                            shows the stored value it gets back).
//   issues          array    the issues placed at this field
//                            ({ message, severity, … }, inspectorModel
//                            placeIssues/notesAt). Each message is shown under
//                            the field in plain words, in an element whose id
//                            is notesId(id), referenced by aria-describedby.
//   focusRequest    { path, offset? } | null
//                            ED-04: when it changes, the field takes the
//                            focus. `path` is the field path the request was
//                            made for (the form only passes a request whose
//                            path lands on this field). `offset` is a block
//                            child index: offset 2 puts the caret at the start
//                            of the third top-level block (paragraph, heading,
//                            list). Without an offset the caret is left alone.
//   readOnlyReason  string?  when given, the field can't be edited and says
//                            why, in these words (for example content this
//                            editor can't edit yet, or a founder without
//                            permission).
//   id              string   the element id: the field's anchor
//                            (fieldAnchor, "f-<section>-<path>"), so publish
//                            links and preview clicks find it.
//   label           string   the field's label, as the registry declares it.
//   placeholder     string?  the empty-state hint.
//   required        boolean? marks the label.
//
// The fallback: a plain text box showing the HTML, with a note that the
// formatting buttons come with the full editor (P3-RTE). Known limit: until
// then a founder sees tags here (AU-01 is not met by this fallback).
import { useEffect, useRef } from "react";
import { applyFocus, blockStart, notesId, noteTone, blocks } from "./inspectorModel.js";

const TONE = { danger: "text-danger", warning: "text-warning", muted: "text-fg-muted" };

export default function RichTextField({ value, onChange, issues = [], focusRequest = null, readOnlyReason = null, id, label, placeholder = "", required = false }) {
  const ref = useRef(null);
  const html = typeof value === "string" ? value : "";
  const notes = Array.isArray(issues) ? issues : [];
  const readOnly = typeof readOnlyReason === "string" && readOnlyReason.length > 0;

  useEffect(() => {
    if (!focusRequest || typeof document === "undefined") return;
    applyFocus(document, id, blockStart(ref.current?.value ?? html, focusRequest.offset));
    // a new request object is a new request, even for the same path
  }, [focusRequest]);

  const describedBy = [notes.length ? notesId(id) : null, readOnly ? `${id}--readonly` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="min-w-0" data-rich-text="fallback">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-fg-muted">
        {label}
        {required && <span className="text-danger"> *</span>}
      </label>
      <textarea
        ref={ref}
        id={id}
        value={html}
        placeholder={placeholder}
        readOnly={readOnly}
        aria-readonly={readOnly || undefined}
        aria-invalid={blocks(notes) || undefined}
        aria-describedby={describedBy}
        onChange={(e) => !readOnly && onChange?.(e.target.value)}
        className={`w-full min-h-32 rounded-ctl border bg-surface px-3 py-2 font-mono text-xs text-fg focus-ring ${blocks(notes) ? "border-danger" : "border-edge"} ${readOnly ? "bg-surface-sunken text-fg-subtle" : ""}`}
      />
      {readOnly ? (
        <p id={`${id}--readonly`} className="mt-1 text-xs text-fg-muted">
          {readOnlyReason}
        </p>
      ) : (
        <p className="mt-1 text-xs text-fg-subtle">The formatting buttons arrive with the full text editor. Until then the formatting shows as tags here.</p>
      )}
      {notes.length > 0 && (
        <div id={notesId(id)} data-for={id} className="mt-1 space-y-0.5">
          {notes.map((n, i) => (
            <p key={i} className={`text-xs ${TONE[noteTone(n)]}`}>
              {n.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
