// The operator console (Phase 0 line 8): until Phase 3 rebuilds it, every
// screen here is an old one, so it sits in a [data-legacy] region and keeps
// the old tokens under the console's .console body (app/console.css).
export default function PlatformLayout({ children }) {
  return (
    <div data-legacy className="contents">
      {children}
    </div>
  );
}
